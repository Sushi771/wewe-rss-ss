import { Prisma, PrismaClient } from '@prisma/client';

const MAX_PROBE_BYTES = 8_000_000;
export type CachedBodyMediaFlags = {
  id: string;
  bodyMissing: number;
  remoteImages: number;
  mediaPending: number;
};

/** Match the old SQL's tag/attribute rules in one linear pass. In particular,
 * a stale data-src beside a valid inline src is not another remote request. */
function remoteImageTag(html: string) {
  const source = html.toLowerCase();
  let offset = 0;
  while (offset < source.length) {
    const start = source.indexOf('<img', offset);
    if (start < 0) return false;
    const end = source.indexOf('>', start);
    if (end < 0) return false;
    const tag = source.slice(start, end + 1);
    if (tag.includes(' src="http') || tag.includes(" src='http")) return true;
    if (
      (tag.includes(' data-src="http') || tag.includes(" data-src='http")) &&
      !tag.includes(' src="data:image/') &&
      !tag.includes(" src='data:image/")
    )
      return true;
    offset = end + 1;
  }
  return false;
}

/** One read statement/snapshot, scoped to the incoming saved identities. Healthy
 * inline bodies return flags only. Ambiguous HTTP attributes use a linear JS
 * probe outside the connection, with a total 8MB transfer/CPU budget. Bodies
 * beyond that budget stay conservatively pending; they are never called ready.
 * No transaction, pool setting, timeout, write guard or list cache is changed. */
export async function readCachedBodyMediaFlags(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  mpId: string,
  rawIds: string[],
): Promise<CachedBodyMediaFlags[]> {
  const ids = [...new Set(rawIds)];
  if (!ids.length) return [];
  if (ids.length > 1000) throw Error('PROVIDER_PAGE_INVALID');
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      bodyMissing: number | bigint;
      retryable: number | bigint;
      pending: number | bigint;
      hint: number | bigint;
      probe: string | null;
    }>
  >(Prisma.sql`/* cache_body_media_flags */
    WITH sizes AS MATERIALIZED (
      SELECT id, length(CAST(content_html AS BLOB)) AS bytes,
        CASE WHEN content_html IS NULL OR content_html = '' THEN 1 ELSE 0 END AS bodyMissing
      FROM articles WHERE mp_id = ${mpId} AND id IN (${Prisma.join(ids)})
    ), flags AS MATERIALIZED (
      SELECT s.*,
        CASE WHEN bytes > ${MAX_PROBE_BYTES} THEN 1
          WHEN a.content_html LIKE '%data-wewe-image-retryable="true"%'
            OR a.content_html LIKE '%data-wewe-image-retryable=''true''%' THEN 1 ELSE 0 END AS retryable,
        CASE WHEN bytes > ${MAX_PROBE_BYTES} THEN 1
          WHEN a.content_html LIKE '%data-wewe-image-pending=%' THEN 1 ELSE 0 END AS pending,
        CASE WHEN bytes > ${MAX_PROBE_BYTES} THEN 1
          WHEN a.content_html LIKE '% src="http%' OR a.content_html LIKE '% src=''http%'
            OR a.content_html LIKE '% data-src="http%' OR a.content_html LIKE '% data-src=''http%'
          THEN 1 ELSE 0 END AS hint
      FROM sizes s JOIN articles a ON a.id = s.id
    ), budget AS (
      SELECT *, sum(CASE WHEN hint = 1 AND NOT (retryable = 1 AND pending = 1)
        AND bytes <= ${MAX_PROBE_BYTES} THEN bytes ELSE 0 END) OVER (ORDER BY id) AS probeBytes
      FROM flags
    ) SELECT b.id, b.bodyMissing, b.retryable, b.pending, b.hint,
      CASE WHEN hint = 1 AND NOT (retryable = 1 AND pending = 1)
        AND bytes <= ${MAX_PROBE_BYTES} AND probeBytes <= ${MAX_PROBE_BYTES}
        THEN a.content_html ELSE NULL END AS probe
      FROM budget b JOIN articles a ON a.id = b.id`);
  return rows.map((row) => {
    const deferred =
      Number(row.hint) === 1 &&
      row.probe === null &&
      !(Number(row.retryable) === 1 && Number(row.pending) === 1);
    const remote = row.probe !== null && remoteImageTag(row.probe);
    return {
      id: row.id,
      bodyMissing: Number(row.bodyMissing),
      remoteImages: Number(deferred || remote || Number(row.retryable) === 1),
      mediaPending: Number(deferred || remote || Number(row.pending) === 1),
    };
  });
}
