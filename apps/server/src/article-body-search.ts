import { Prisma, PrismaClient } from '@prisma/client';
import { ArticleFilter, articlePublicationRange } from '@wewe-rss/shared';
import { load } from 'cheerio';

/** Plain visible text only: no HTML, hidden metadata, scripts or media payloads. */
export function visibleBodyText(html: string | null): string {
  if (!html) return '';
  const $ = load(html);
  $(
    'script,style,template,noscript,head,iframe,svg,[hidden],[aria-hidden="true"]',
  ).remove();
  $('[style]').each((_, e) => {
    if (
      /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(
        $(e).attr('style') || '',
      )
    )
      $(e).remove();
  });
  $('p,div,section,article,li,h1,h2,h3,h4,h5,h6,br,tr').each((_, e) => {
    $(e).before(' ');
    $(e).after(' ');
  });
  return $('body').text().replace(/\s+/g, ' ').trim();
}

/** Bounded, resumable work while the user explicitly prepares local search.
 * Generation guards edits; the source-body predicate also guards deletion and
 * same-ID recreation, whose generation can restart. An identical source body
 * has the same projection and is safe to reuse across that lifecycle change. */
export async function prepareBodySearch(prisma: PrismaClient) {
  const candidates = await prisma.$queryRaw<
    Array<{ article_id: string; bytes: bigint }>
  >`SELECT d.article_id,COALESCE(length(a.content_html),0) AS bytes FROM article_search_documents d JOIN articles a ON a.id=d.article_id WHERE d.pending=1 ORDER BY d.article_id LIMIT 128`;
  let bytes = 0;
  const selected: string[] = [];
  for (const row of candidates) {
    const size = Number(row.bytes) * 2;
    if (selected.length && bytes + size > 8 * 1024 * 1024) break;
    selected.push(row.article_id);
    bytes += size;
  }
  const dirty = await prisma.articleSearchDocument.findMany({
    where: { pending: true, articleId: { in: selected } },
    select: {
      articleId: true,
      generation: true,
      article: { select: { contentHtml: true } },
    },
  });
  const parsed = dirty.map((row) => ({
    ...row,
    text: visibleBodyText(row.article.contentHtml),
  }));
  if (parsed.length)
    await prisma.$transaction(
      parsed.map((row) =>
        prisma.articleSearchDocument.updateMany({
          where: {
            articleId: row.articleId,
            pending: true,
            generation: row.generation,
            article: {
              is: { id: row.articleId, contentHtml: row.article.contentHtml },
            },
          },
          data: { bodyText: row.text, pending: false },
        }),
      ),
    );
  return bodySearchCoverage(prisma);
}
export async function bodySearchCoverage(prisma: PrismaClient) {
  const [total, pending, uncached] = await prisma.$transaction([
    prisma.articleSearchDocument.count(),
    prisma.articleSearchDocument.count({ where: { pending: true } }),
    prisma.articleSearchDocument.count({ where: { bodyCached: false } }),
  ]);
  return { total, pending, uncached, indexed: total - pending };
}

function searchScope(input: ArticleFilter) {
  const term = (input.search || '').trim();
  const clauses: Prisma.Sql[] = [
    Prisma.sql`(instr(lower(a.title),lower(${term}))>0 OR instr(lower(f.mp_name),lower(${term}))>0 OR (d.pending=0 AND instr(lower(d.body_text),lower(${term}))>0))`,
  ];
  if (input.mpId) clauses.push(Prisma.sql`a.mp_id=${input.mpId}`);
  if (input.group && input.group !== 'all')
    clauses.push(
      input.group === 'ungrouped'
        ? Prisma.sql`f.group_id IS NULL`
        : Prisma.sql`f.group_id=${input.group}`,
    );
  const range = articlePublicationRange(input);
  if (range) {
    clauses.push(Prisma.sql`a.publish_time>0`);
    if (range.gte !== undefined)
      clauses.push(Prisma.sql`a.publish_time>=${range.gte}`);
    if (range.lt !== undefined)
      clauses.push(Prisma.sql`a.publish_time<${range.lt}`);
  }
  return Prisma.sql`FROM articles a JOIN feeds f ON f.id=a.mp_id LEFT JOIN article_search_documents d ON d.article_id=a.id WHERE ${Prisma.join(clauses, ' AND ')}`;
}

type SearchInput = ArticleFilter & {
  sort?: 'publishTime' | 'readCount' | 'likeCount';
  direction?: 'asc' | 'desc';
  cursor?: string | null;
};
/** The cursor is the first unseen row, exactly as the ordinary Prisma list. */
export async function findBodySearchIds(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  input: SearchInput,
  take: number,
  exportOrder = false,
) {
  const column =
    input.sort === 'readCount'
      ? 'read_count'
      : input.sort === 'likeCount'
        ? 'like_count'
        : 'publish_time';
  const direction =
    input.sort && input.sort !== 'publishTime'
      ? 'DESC'
      : input.direction === 'asc'
        ? 'ASC'
        : 'DESC';
  const order = Prisma.raw(
    `a.${column} ${direction},a.id ${exportOrder ? 'ASC' : direction}`,
  );
  const scope = searchScope(input);
  if (!input.cursor)
    return prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT a.id ${scope} ORDER BY ${order} LIMIT ${take}`,
    );
  const field = Prisma.raw(`a.${column}`);
  const cursorRows = await prisma.$queryRaw<
    Array<{ id: string; value: number | bigint | null }>
  >(
    Prisma.sql`SELECT a.id,${field} AS value ${scope} AND a.id=${input.cursor} LIMIT 1`,
  );
  const cursor = cursorRows[0];
  if (!cursor) return [];
  const idDirection = exportOrder ? 'ASC' : direction;
  const idTie =
    idDirection === 'ASC'
      ? Prisma.sql`a.id>=${cursor.id}`
      : Prisma.sql`a.id<=${cursor.id}`;
  const strictValue =
    direction === 'ASC'
      ? Prisma.sql`${field}>${cursor.value}`
      : Prisma.sql`${field}<${cursor.value}`;
  let seek: Prisma.Sql;
  if (cursor.value === null)
    seek =
      direction === 'DESC'
        ? Prisma.sql`${field} IS NULL AND ${idTie}`
        : Prisma.sql`(${field} IS NOT NULL OR (${field} IS NULL AND ${idTie}))`;
  else {
    const tied = Prisma.sql`(${strictValue} OR (${field}=${cursor.value} AND ${idTie}))`;
    if (column === 'publish_time')
      seek = Prisma.sql`${field} ${Prisma.raw(direction === 'ASC' ? '>=' : '<=')} ${cursor.value} AND ${tied}`;
    else
      seek =
        direction === 'DESC' ? Prisma.sql`(${field} IS NULL OR ${tied})` : tied;
  }
  return prisma.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT a.id ${scope} AND (${seek}) ORDER BY ${order} LIMIT ${take}`,
  );
}
export async function bodySearchSummary(
  prisma: PrismaClient,
  input: ArticleFilter,
) {
  const rows = await prisma.$queryRaw<
    Array<{
      articles: bigint;
      readAvailable: bigint;
      likeAvailable: bigint;
      cachedBodies: bigint;
      oldestPublishTime: number | null;
      newestPublishTime: number | null;
    }>
  >(
    Prisma.sql`SELECT COUNT(*) AS articles,COUNT(a.read_count) AS readAvailable,COUNT(a.like_count) AS likeAvailable,COUNT(a.content_html) AS cachedBodies,MIN(a.publish_time) AS oldestPublishTime,MAX(a.publish_time) AS newestPublishTime ${searchScope(input)}`,
  );
  const r = rows[0];
  return {
    ...r,
    articles: Number(r.articles),
    readAvailable: Number(r.readAvailable),
    likeAvailable: Number(r.likeAvailable),
    cachedBodies: Number(r.cachedBodies),
    oldestPublishTime:
      r.oldestPublishTime === null ? null : Number(r.oldestPublishTime),
    newestPublishTime:
      r.newestPublishTime === null ? null : Number(r.newestPublishTime),
  };
}
export function searchSnippet(text: string, term: string) {
  const needle = term.trim();
  const asciiFold = (value: string) =>
    value.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const at = asciiFold(text).indexOf(asciiFold(needle));
  if (at < 0) return null;
  const start = Math.max(0, at - 45),
    end = Math.min(text.length, at + needle.length + 85);
  return {
    before: (start ? '…' : '') + text.slice(start, at),
    match: text.slice(at, at + needle.length),
    after: text.slice(at + needle.length, end) + (end < text.length ? '…' : ''),
  };
}
