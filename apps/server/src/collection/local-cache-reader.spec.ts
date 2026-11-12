import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import child = require('node:child_process');
import {
  listLocalWechat2RssCache,
  readLocalWechat2RssCache,
} from './local-cache-reader';
import { parseWechat2RssJsonFeed } from './provider-article';

// eslint-disable-next-line @typescript-eslint/no-var-requires -- This regression intentionally exercises the fixed Node 24 builtin.
const nativeAvailable = Number(process.versions.node.split('.')[0]) >= 24;
const sqlite = nativeAvailable ? require('node:sqlite') : undefined;
const DatabaseSync = sqlite?.DatabaseSync;
const oracleExec = child.execFileSync;
const id = 'MP_WXS_1234567890';
const name = '合成公众号😱';
const url = 'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=9&idx=1';
const body =
  '<div class="rich_media_content"><p>合成正文😱</p><img src="https://mmbiz.qpic.cn/synthetic.png"></div>';

const describeNative = nativeAvailable ? describe : describe.skip;
describeNative(
  'native local cache reader (real read-only SQLite, no reader child)',
  () => {
    let root: string, file: string, writer: any;
    const beforeEnv = process.env.WECHAT2RSS_CACHE_DB;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-native-reader-'));
      file = path.join(root, 'cache.sqlite');
      writer = new DatabaseSync(file);
      writer.exec(
        'CREATE TABLE rsses(biz_id INTEGER,name TEXT); CREATE TABLE articles(biz_id INTEGER,url TEXT,title TEXT,created,fulltext INTEGER,content TEXT,pic_url TEXT)',
      );
      writer.prepare('INSERT INTO rsses VALUES(?,?)').run(1234567890, name);
      writer
        .prepare('INSERT INTO articles VALUES(?,?,?,?,?,?,?)')
        .run(
          1234567890,
          url,
          '合成标题😱',
          '2026-10-11 13:27:00+08:00',
          1,
          body,
          '',
        );
      process.env.WECHAT2RSS_CACHE_DB = file;
    });
    afterEach(() => {
      jest.restoreAllMocks();
      writer?.close();
      if (beforeEnv === undefined) delete process.env.WECHAT2RSS_CACHE_DB;
      else process.env.WECHAT2RSS_CACHE_DB = beforeEnv;
      if (
        !path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
        !path.basename(root).startsWith('wewe-native-reader-')
      )
        throw Error('FIXTURE_ROOT_REQUIRED');
      fs.rmSync(root, { recursive: true });
    });
    const hash = (file: string) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- Synchronous test-only byte receipt.
      return require('node:crypto')
        .createHash('sha256')
        .update(fs.readFileSync(file))
        .digest('hex');
    };
    const forbidIo = () => {
      const methods = [
        'spawn',
        'spawnSync',
        'exec',
        'execSync',
        'execFile',
        'execFileSync',
        'fork',
      ] as const;
      const spies = methods.map((method) =>
        jest.spyOn(child, method).mockImplementation((() => {
          throw Error('CHILD_FORBIDDEN');
        }) as any),
      );
      const network = jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(Error('HTTP_FORBIDDEN'));
      return () => {
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        expect(network).not.toHaveBeenCalled();
      };
    };

    it('matches the unchanged offline Python/parser contract and keeps bytes unchanged without any runtime child', async () => {
      const raw = JSON.parse(
        oracleExec(
          process.platform === 'win32' ? 'python' : 'python3',
          [
            path.resolve(__dirname, '../../scripts/read-wechat2rss-cache.py'),
            '--database',
            file,
            '--feed',
            id,
            '--name',
            name,
          ],
          { encoding: 'utf8', windowsHide: true },
        ),
      );
      const expected = parseWechat2RssJsonFeed(raw, id),
        before = hash(file),
        checkIo = forbidIo();
      expect(await readLocalWechat2RssCache(id, name)).toEqual(expected);
      expect(await listLocalWechat2RssCache()).toEqual([
        {
          feedId: id,
          name,
          feedUrl: '/feed/1234567890.json',
          checkTime: null,
          nextUpdateTime: null,
          paused: null,
        },
      ]);
      expect(hash(file)).toBe(before);
      checkIo();
    });

    it('really opens readOnly rather than merely avoiding writes by convention', async () => {
      const created: any[] = [];
      jest
        .spyOn(sqlite, 'DatabaseSync')
        .mockImplementation((...args: unknown[]) => {
          const [file, options] = args as [string, any];
          expect(options).toMatchObject({ readOnly: true, timeout: 250 });
          const database = new DatabaseSync(file, options);
          expect(() =>
            database.exec('CREATE TABLE forbidden_write(id INTEGER)'),
          ).toThrow(/readonly|read.only/i);
          created.push(database);
          return database;
        });
      await listLocalWechat2RssCache();
      await readLocalWechat2RssCache(id, name);
      expect(created).toHaveLength(2);
      expect(() => created[0].prepare('SELECT 1')).toThrow();
    });

    it('rejects wrong names, invalid IDs and a conflicting canonical publisher without external fallback', async () => {
      const checkIo = forbidIo();
      await expect(readLocalWechat2RssCache(id, '其他号')).rejects.toThrow(
        'CACHE_LOCAL_IDENTITY_CONFLICT',
      );
      await expect(
        readLocalWechat2RssCache('1234567890', name),
      ).rejects.toThrow('CACHE_LOCAL_READ_UNAVAILABLE');
      writer.exec(
        "UPDATE articles SET url='https://mp.weixin.qq.com/s?__biz=MzIzNDU2Nzg5MA==&mid=9&idx=1'",
      );
      await expect(readLocalWechat2RssCache(id, name)).rejects.toThrow(
        'WECHAT2RSS_ARTICLE_IDENTITY_CONFLICT',
      );
      checkIo();
    });

    it('rejects duplicate publisher identities rather than guessing a row', async () => {
      writer.prepare('INSERT INTO rsses VALUES(?,?)').run(1234567890, name);
      await expect(listLocalWechat2RssCache()).rejects.toThrow(
        'CACHE_LOCAL_IDENTITY_CONFLICT',
      );
      await expect(readLocalWechat2RssCache(id, name)).rejects.toThrow(
        'CACHE_LOCAL_IDENTITY_CONFLICT',
      );
    });

    it('never creates a missing file or falls back when local configuration is invalid', async () => {
      const checkIo = forbidIo(),
        missing = path.join(root, 'missing.sqlite');
      for (const value of [missing, 'relative.sqlite', file + '\nother']) {
        process.env.WECHAT2RSS_CACHE_DB = value;
        await expect(listLocalWechat2RssCache()).rejects.toThrow(
          'CACHE_LOCAL_READ_UNAVAILABLE',
        );
      }
      expect(fs.existsSync(missing)).toBe(false);
      checkIo();
    });

    it('reads only committed bytes and sees a later committed fill', async () => {
      writer.exec('BEGIN');
      writer.prepare('UPDATE articles SET content=?').run('<p>uncommitted</p>');
      expect(
        (await readLocalWechat2RssCache(id, name)).articles[0].contentHtml,
      ).toContain('合成正文');
      writer.exec('COMMIT');
      expect(
        (await readLocalWechat2RssCache(id, name)).articles[0].contentHtml,
      ).toContain('uncommitted');
    });

    it.each([
      '2026-02-30 12:00:00+08:00',
      '2026-10-11 13:27:00',
      '2026-10-11 13:27:00+99:00',
      null,
    ])(
      'rejects unverified time %s without inventing a timezone',
      async (value) => {
        writer.prepare('UPDATE articles SET created=?').run(value);
        await expect(readLocalWechat2RssCache(id, name)).rejects.toThrow(
          'CACHE_LOCAL_TIME_UNVERIFIED',
        );
      },
    );

    it('supports verified numeric and timezone-bearing fractional publication values', async () => {
      writer.prepare('UPDATE articles SET created=?').run(1791696420);
      expect(
        (await readLocalWechat2RssCache(id, name)).articles[0].publishTime,
      ).toBe(1791696420);
      writer
        .prepare('UPDATE articles SET created=?')
        .run('2026-10-11T13:27:00.123456789+08:00');
      expect(
        (await readLocalWechat2RssCache(id, name)).articles[0].publishTime,
      ).toBe(Math.floor(Date.parse('2026-10-11T05:27:00Z') / 1000));
    });

    it('retains the 1000-row limit for feeds and articles', async () => {
      writer.exec('BEGIN');
      for (let i = 1; i <= 1000; i++)
        writer
          .prepare('INSERT INTO articles VALUES(?,?,?,?,?,?,?)')
          .run(1234567890, url, 'fixture', '2026-10-11T05:27:00Z', 1, '', '');
      writer.exec('COMMIT');
      await expect(readLocalWechat2RssCache(id, name)).rejects.toThrow(
        'CACHE_LOCAL_TOO_LARGE',
      );
      writer.exec('BEGIN');
      for (let i = 1; i <= 1000; i++)
        writer
          .prepare('INSERT INTO rsses VALUES(?,?)')
          .run(1234567890 + i, 'fixture');
      writer.exec('COMMIT');
      await expect(listLocalWechat2RssCache()).rejects.toThrow(
        'CACHE_LOCAL_TOO_LARGE',
      );
    });

    it.each(['content', 'created', 'name'])(
      'rejects oversized %s before fetching the text into JS',
      async (column) => {
        let fetched = 0;
        jest
          .spyOn(sqlite, 'DatabaseSync')
          .mockImplementation((...args: unknown[]) => {
            const db = new DatabaseSync(...args);
            return {
              exec: db.exec.bind(db),
              close: db.close.bind(db),
              prepare(sql: string) {
                const statement = db.prepare(sql);
                return {
                  all(...values: string[]) {
                    if (
                      sql.startsWith('SELECT url,title,created,content,pic_url')
                    )
                      fetched++;
                    return statement.all(...values);
                  },
                  get(...values: string[]) {
                    if (sql.startsWith('SELECT name FROM rsses')) fetched++;
                    return statement.get(...values);
                  },
                };
              },
            };
          });
        writer
          .prepare(
            column === 'name'
              ? 'UPDATE rsses SET name=?'
              : `UPDATE articles SET ${column}=?`,
          )
          .run('x'.repeat(33 * 1024 * 1024));
        await expect(readLocalWechat2RssCache(id, name)).rejects.toThrow(
          'CACHE_LOCAL_TOO_LARGE',
        );
        // A small publisher name is fetched before the article budget, but a huge
        // publisher name must never be fetched. No oversized body/date is fetched.
        expect(fetched).toBe(column === 'name' ? 0 : 1);
      },
    );

    it('bounds ASCII-escaped control characters without constructing an expanded JSON copy', async () => {
      writer
        .prepare('UPDATE articles SET content=?')
        .run('\u0001'.repeat(6 * 1024 * 1024));
      await expect(readLocalWechat2RssCache(id, name)).rejects.toThrow(
        'CACHE_LOCAL_TOO_LARGE',
      );
    });

    it.each(['view', 'generated'])(
      'rejects a %s before evaluating cache payload expressions',
      async (kind) => {
        writer.exec('DROP TABLE articles');
        writer.exec(
          kind === 'view'
            ? "CREATE VIEW articles AS SELECT 1234567890 biz_id, 'url' url, 'title' title, 'date' created, 1 fulltext, hex(zeroblob(1000000000)) content, '' pic_url"
            : 'CREATE TABLE articles(biz_id INTEGER,url TEXT,title TEXT,created,fulltext INTEGER,content TEXT GENERATED ALWAYS AS (hex(zeroblob(1000000000))),pic_url TEXT)',
        );
        await expect(readLocalWechat2RssCache(id, name)).rejects.toThrow(
          'CACHE_LOCAL_SCHEMA_UNVERIFIED',
        );
      },
    );

    it('does not downgrade untrusted data images or erase missing-body provenance', async () => {
      writer
        .prepare('UPDATE articles SET content=?')
        .run('<p>text</p><img src="data:image/png;base64,dW50cnVzdGVk">');
      const page = await readLocalWechat2RssCache(id, name);
      expect(page.imageBlocked).toBe(1);
      expect(page.articles[0].contentHtml).not.toContain('data:image');
      writer.exec('UPDATE articles SET content=NULL');
      expect((await readLocalWechat2RssCache(id, name)).bodyMissing).toBe(1);
    });
  },
);

if (!nativeAvailable)
  it('fails closed on an older development runtime rather than spawning Python or HTTP', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-native-reader-'));
    const previous = process.env.WECHAT2RSS_CACHE_DB;
    try {
      const file = path.join(root, 'empty.sqlite');
      fs.writeFileSync(file, '');
      process.env.WECHAT2RSS_CACHE_DB = file;
      await expect(listLocalWechat2RssCache()).rejects.toThrow(
        'CACHE_LOCAL_NATIVE_UNAVAILABLE',
      );
    } finally {
      if (previous === undefined) delete process.env.WECHAT2RSS_CACHE_DB;
      else process.env.WECHAT2RSS_CACHE_DB = previous;
      fs.unlinkSync(path.join(root, 'empty.sqlite'));
      fs.rmdirSync(root);
    }
  });
