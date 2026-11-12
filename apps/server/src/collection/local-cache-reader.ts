import { statSync } from 'node:fs';
import * as path from 'node:path';
import type { Wechat2RssListedFeed } from './providers/wechat2rss';
import { parseWechat2RssJsonFeed } from './provider-article';

type Row = Record<string, unknown>;
type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...args: string[]): Row[];
    get(...args: string[]): Row | undefined;
  };
  close(): void;
};
const MAX_ROWS = 1000;
const MAX_BYTES = 32 * 1024 * 1024;
const invalid = (code = 'CACHE_LOCAL_READ_UNAVAILABLE') => new Error(code);

function validateTables(database: Database) {
  const schema = database
    .prepare(
      "SELECT name,type FROM pragma_table_list() WHERE schema='main' AND name IN ('rsses','articles')",
    )
    .all();
  const required = {
    rsses: ['biz_id', 'name'],
    articles: [
      'biz_id',
      'url',
      'title',
      'created',
      'fulltext',
      'content',
      'pic_url',
    ],
  };
  for (const [table, names] of Object.entries(required)) {
    const definition = schema.find((row) => row.name === table);
    if (definition?.type !== 'table')
      throw invalid('CACHE_LOCAL_SCHEMA_UNVERIFIED');
    const columns = database.prepare(`PRAGMA table_xinfo('${table}')`).all();
    if (
      columns.some((row) => row.hidden !== 0) ||
      names.some((name) => !columns.some((row) => row.name === name))
    )
      throw invalid('CACHE_LOCAL_SCHEMA_UNVERIFIED');
  }
}

/** Runtime cache reads stay in the fixed Node 24 process. Never spawn a reader
 * child or fall back to Python/HTTP. The Python CLI remains offline maintenance. */
function snapshot<T>(read: (database: Database) => T): T {
  const file = process.env.WECHAT2RSS_CACHE_DB?.trim();
  if (!file || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) throw invalid();
  try {
    if (!statSync(file).isFile()) throw invalid();
  } catch {
    throw invalid();
  }
  let DatabaseSync: new (
    file: string,
    options: { readOnly: boolean; timeout: number },
  ) => Database;
  try {
    if (Number(process.versions.node.split('.')[0]) < 24) throw invalid();
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- Lazy builtin: ordinary non-local mode still loads on older supported development runtimes.
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw invalid('CACHE_LOCAL_NATIVE_UNAVAILABLE');
  }
  let database: Database;
  try {
    database = new DatabaseSync(file, { readOnly: true, timeout: 250 });
  } catch {
    throw invalid();
  }
  let result: T,
    primary: unknown,
    failed = false;
  try {
    database.exec('PRAGMA query_only=ON; BEGIN');
    validateTables(database);
    result = read(database);
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    database.close();
  } catch (closeError) {
    if (failed) {
      // This server module is also traversed through AppRouter's browser types
      // (ES2020). Keep the real Node 24 builtin without widening global libs.
      const Aggregate = (
        globalThis as unknown as {
          AggregateError: new (errors: unknown[], message: string) => Error;
        }
      ).AggregateError;
      throw new Aggregate(
        [primary, closeError],
        'CACHE_LOCAL_READ_AND_CLOSE_FAILED',
      );
    }
    throw closeError;
  }
  if (failed) throw primary;
  return result!;
}
function bounded(value: unknown) {
  // Count the former ASCII JSON envelope without allocating an escaped copy
  // (a hostile control/Unicode string could otherwise expand up to sixfold).
  let bytes = 0;
  const add = (amount: number) => {
    bytes += amount;
    if (bytes > MAX_BYTES) throw invalid('CACHE_LOCAL_TOO_LARGE');
  };
  const visit = (item: unknown) => {
    if (typeof item === 'string') {
      add(2);
      for (let i = 0; i < item.length; i++) {
        const code = item.charCodeAt(i);
        let width = code >= 127 || code < 32 ? 6 : 1;
        if (
          code === 34 ||
          code === 92 ||
          code === 8 ||
          code === 9 ||
          code === 10 ||
          code === 12 ||
          code === 13
        )
          width = 2;
        add(width);
      }
    } else if (Array.isArray(item)) {
      add(2 + Math.max(0, item.length - 1));
      for (const child of item) visit(child);
    } else if (item && typeof item === 'object') {
      const entries = Object.entries(item);
      add(2 + Math.max(0, entries.length - 1));
      for (const [key, child] of entries) {
        visit(key);
        add(1);
        visit(child);
      }
    } else if (
      item === null ||
      typeof item === 'boolean' ||
      typeof item === 'number'
    )
      add(String(item).length);
    else throw invalid();
  };
  visit(value);
}
function limit(row: Row | undefined) {
  if (!row || Number(row.count) > MAX_ROWS || Number(row.bytes) > MAX_BYTES)
    throw invalid('CACHE_LOCAL_TOO_LARGE');
}
function published(raw: unknown) {
  if (typeof raw === 'number') {
    const date = new Date(raw * 1000);
    if (!Number.isFinite(raw) || !Number.isFinite(date.getTime()))
      throw invalid('CACHE_LOCAL_TIME_UNVERIFIED');
    return date.toISOString();
  }
  if (typeof raw !== 'string') throw invalid('CACHE_LOCAL_TIME_UNVERIFIED');
  const m =
    /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/.exec(
      raw,
    );
  if (!m) throw invalid('CACHE_LOCAL_TIME_UNVERIFIED');
  const [, year, month, day, hour, minute, second, zone] = m;
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) >
      new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate() ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (zone !== 'Z' &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
  )
    throw invalid('CACHE_LOCAL_TIME_UNVERIFIED');
  const time = Date.parse(raw.replace(' ', 'T'));
  if (!Number.isFinite(time)) throw invalid('CACHE_LOCAL_TIME_UNVERIFIED');
  return new Date(time).toISOString();
}

export async function listLocalWechat2RssCache(): Promise<
  Wechat2RssListedFeed[]
> {
  return snapshot((database) => {
    limit(
      database
        .prepare(
          'SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM (SELECT coalesce(octet_length(name),0)+coalesce(octet_length(biz_id),0) AS bytes FROM rsses LIMIT 1001)',
        )
        .get(),
    );
    const seen = new Set<string>();
    const result = database
      .prepare('SELECT biz_id,name FROM rsses LIMIT 1001')
      .all()
      .map((row) => {
        const biz = String(row.biz_id);
        if (
          !/^\d{5,15}$/.test(biz) ||
          typeof row.name !== 'string' ||
          !row.name.trim() ||
          seen.has(biz)
        )
          throw invalid('CACHE_LOCAL_IDENTITY_CONFLICT');
        seen.add(biz);
        return {
          feedId: 'MP_WXS_' + biz,
          name: row.name,
          feedUrl: '/feed/' + biz + '.json',
          checkTime: null,
          nextUpdateTime: null,
          paused: null,
        };
      });
    bounded(result);
    return result;
  });
}
export async function readLocalWechat2RssCache(feedId: string, name: string) {
  if (!/^MP_WXS_\d{5,15}$/.test(feedId)) throw invalid();
  if (typeof name !== 'string' || !name.trim())
    throw invalid('CACHE_LOCAL_IDENTITY_CONFLICT');
  const raw = snapshot((database) => {
    const biz = feedId.slice(7);
    // octet_length(column) uses SQLite column metadata, before reading a name
    // or body into JS. The bounded subqueries never project a large body.
    const identities = database
      .prepare(
        'SELECT octet_length(name) AS bytes FROM rsses WHERE biz_id = ? LIMIT 2',
      )
      .all(biz);
    if (identities.length !== 1) throw invalid('CACHE_LOCAL_IDENTITY_CONFLICT');
    if (Number(identities[0].bytes) > MAX_BYTES)
      throw invalid('CACHE_LOCAL_TOO_LARGE');
    if (
      database
        .prepare('SELECT name FROM rsses WHERE biz_id = ? LIMIT 1')
        .get(biz)?.name !== name
    )
      throw invalid('CACHE_LOCAL_IDENTITY_CONFLICT');
    limit(
      database
        .prepare(
          'SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM (SELECT coalesce(octet_length(url),0)+coalesce(octet_length(title),0)+coalesce(octet_length(created),0)+coalesce(octet_length(content),0)+coalesce(octet_length(pic_url),0) AS bytes FROM articles WHERE biz_id = ? LIMIT 1001)',
        )
        .get(biz),
    );
    const items = database
      .prepare(
        'SELECT url,title,created,content,pic_url FROM articles WHERE biz_id = ? ORDER BY created DESC LIMIT 1001',
      )
      .all(biz)
      .map((row) => {
        if (
          typeof row.url !== 'string' ||
          typeof row.title !== 'string' ||
          (row.content !== null && typeof row.content !== 'string') ||
          (row.pic_url !== null && typeof row.pic_url !== 'string')
        )
          throw invalid();
        return {
          id: row.url,
          url: row.url,
          title: row.title,
          date_published: published(row.created),
          content_html: row.content || '',
          image: row.pic_url || '',
        };
      });
    const page = { items };
    bounded(page);
    return page;
  });
  return parseWechat2RssJsonFeed(raw, feedId);
}
