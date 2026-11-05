import { PrismaClient } from '@prisma/client';

/** Frozen c80d240 predicate, for equivalence tests and the isolated benchmark. */
export function legacyCachedFlags(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  mpId: string,
) {
  return prisma.$queryRaw<
    Array<{
      id: string;
      bodyMissing: number;
      remoteImages: number;
      mediaPending: number;
    }>
  >`WITH RECURSIVE image_tags(id, remaining, tag) AS (
    SELECT id, lower(coalesce(content_html, '')), '' FROM articles WHERE mp_id = ${mpId}
    UNION ALL SELECT id,
      substr(remaining, instr(remaining, '<img') + instr(substr(remaining, instr(remaining, '<img')), '>')),
      substr(remaining, instr(remaining, '<img'), instr(substr(remaining, instr(remaining, '<img')), '>'))
    FROM image_tags WHERE instr(remaining, '<img') > 0 AND instr(substr(remaining, instr(remaining, '<img')), '>') > 0
  ), remote_flags AS (
    SELECT id, max(CASE WHEN tag LIKE '% src="http%' OR tag LIKE '% src=''http%'
      OR ((tag LIKE '% data-src="http%' OR tag LIKE '% data-src=''http%')
        AND tag NOT LIKE '% src="data:image/%' AND tag NOT LIKE '% src=''data:image/%') THEN 1 ELSE 0 END) AS remoteImages
    FROM image_tags GROUP BY id
  ) SELECT a.id, CASE WHEN a.content_html IS NULL OR a.content_html = '' THEN 1 ELSE 0 END AS bodyMissing,
    CASE WHEN r.remoteImages = 1 OR a.content_html LIKE '%data-wewe-image-retryable="true"%'
      OR a.content_html LIKE '%data-wewe-image-retryable=''true''%' THEN 1 ELSE 0 END AS remoteImages,
    CASE WHEN r.remoteImages = 1 OR a.content_html LIKE '%data-wewe-image-pending=%' THEN 1 ELSE 0 END AS mediaPending
    FROM articles a JOIN remote_flags r ON a.id = r.id WHERE a.mp_id = ${mpId}`;
}
