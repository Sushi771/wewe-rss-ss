import { Prisma, PrismaClient } from '@prisma/client';
import {
  AUTOMATIC_MEDIA_BODY_LIMIT,
  automaticMediaSources,
} from '../collection/automatic-media-body';
import { resolveCollectionRoute } from '../collection/collection-channel';
import { takeMediaHints } from './cache-sync-state';

const select = {
  id: true,
  mpId: true,
  contentHtml: true,
  sourceUrl: true,
  verifiedSourceUrl: true,
  updatedAt: true,
  lastBodyStatus: true,
  title: true,
  publishTime: true,
} as const;

// Reuse the existing saved-media inspection ceiling, independently of the
// unchanged 8MB automatic writeback limit. Oversized rows are inspected alone.
const INSPECTION_LIMIT = 32_000_000;

/** PK cursor; normal pages <=8MB, one oversized inspection <=32MB.
 * No oversized body is passed to the automatic writer. */
export class AutomaticMediaScan {
  private useHints = true;
  constructor(
    private readonly prisma: Pick<
      PrismaClient,
      'feed' | 'article' | '$queryRaw' | '$transaction'
    >,
  ) {}
  async page(cursor: string, since: number, history = false) {
    const feeds = (
      await this.prisma.feed.findMany({ where: { status: 1 } })
    ).filter((feed) => resolveCollectionRoute(feed).channel === 'wechat2rss');
    if (!feeds.length) return { rows: [], cursor: '', end: true };
    // No caller-supplied SQL; feed bindings and hints are parameterized.
    const hints = this.useHints ? takeMediaHints() : [];
    this.useHints = !this.useHints;
    const page = await this.prisma.$transaction(async (tx) => {
      const eligible = Prisma.sql`mp_id IN (${Prisma.join(feeds.map((feed) => feed.id))}) AND ${history || hints.length ? Prisma.sql`1=1` : Prisma.sql`COALESCE(updated_at, created_at) >= ${new Date(since)}`}`;
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          mpId: string;
          bytes: bigint | number;
          eligible: bigint | number;
        }>
      >(Prisma.sql`
      SELECT id, mp_id AS mpId, CASE WHEN ${eligible} THEN 1 ELSE 0 END AS eligible,
      CASE WHEN ${eligible} THEN length(CAST(content_html AS BLOB)) ELSE 0 END AS bytes
      FROM articles WHERE ${hints.length ? Prisma.sql`id IN (${Prisma.join(hints)})` : Prisma.sql`id > ${cursor}`}
      ORDER BY id LIMIT 20`);
      let total = 0,
        oversized = false;
      const accepted = [] as typeof rows;
      for (const row of rows) {
        const bytes = Number(row.bytes || 0);
        const inspected = bytes <= INSPECTION_LIMIT ? bytes : 0;
        if (bytes > AUTOMATIC_MEDIA_BODY_LIMIT) {
          if (oversized || total + inspected > INSPECTION_LIMIT) break;
          oversized = true;
        } else if (
          total + bytes >
          (oversized ? INSPECTION_LIMIT : AUTOMATIC_MEDIA_BODY_LIMIT)
        )
          break;
        accepted.push(row);
        total += inspected;
      }
      const ids = accepted
        .filter(
          (row) =>
            Number(row.eligible) === 1 &&
            Number(row.bytes || 0) <= INSPECTION_LIMIT,
        )
        .map((row) => row.id);
      const bodies = ids.length
        ? await tx.article.findMany({
            where: { id: { in: ids } },
            select,
          })
        : [];
      // Hints improve freshness only; the durable scan cursor closes lost hints.
      return {
        accepted: accepted.filter((row) => Number(row.eligible) === 1),
        bodies,
        cursor: hints.length ? cursor : accepted.at(-1)?.id || '',
        end:
          !hints.length && rows.length < 20 && accepted.length === rows.length,
      };
    });
    // Keep DOM parsing and image validation outside the SQLite read transaction.
    return {
      rows: page.accepted.map((row) => {
        const body = page.bodies.find((body) => body.id === row.id);
        if (Number(row.bytes || 0) <= AUTOMATIC_MEDIA_BODY_LIMIT && body)
          return body;
        return {
          id: row.id,
          mpId: row.mpId,
          contentHtml: null,
          oversized: true,
          mediaReady: body
            ? automaticMediaSources(body.contentHtml || '').ready
            : false,
        };
      }),
      cursor: page.cursor,
      end: page.end,
    };
  }
  async load(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const sizes = await tx.$queryRaw<Array<{ bytes: bigint | number }>>`
      SELECT length(CAST(content_html AS BLOB)) AS bytes FROM articles WHERE id = ${id}`;
      if (
        !sizes.length ||
        Number(sizes[0].bytes || 0) > AUTOMATIC_MEDIA_BODY_LIMIT
      )
        return;
      return (
        (await tx.article.findUnique({ where: { id }, select })) || undefined
      );
    });
  }
}
