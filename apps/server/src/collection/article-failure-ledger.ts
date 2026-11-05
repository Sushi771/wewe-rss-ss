/** Caller must invoke inside the article transaction. It stores no URLs,
 * source HTML or exception messages. */
import { canonicalArticleUrl } from './collection-format';
import { ProviderPage } from './subscription-provider';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';

type Failure = {
  id: string;
  code: 'BODY_PARSE_FAILED' | 'BODY_TOO_LARGE' | 'BODY_MISSING';
};
type Page = ProviderPage & { bodyFailures?: Failure[] };
type Tx = {
  $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

/** Fallback identifies a verified parsed projection, not an individual attempt.
 * Different original bodies discarded by parsing can share this projection. */
export function snapshotFailureId(
  feedId: string,
  stage: 'list' | 'media',
  original: ProviderPage,
  archived: ProviderPage,
): string {
  const digest = (value: string | null) =>
    value === null ? null : createHash('sha256').update(value).digest('hex');
  const project = (page: ProviderPage) =>
    page.articles
      .map((item) => [
        item.id,
        item.mpId,
        item.url,
        item.title,
        item.publishTime,
        digest(item.contentHtml),
        item.picUrl,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const failures = [...(original.bodyFailures || [])]
    .map((item) => [item.id, item.code])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return createHash('sha256')
    .update(
      JSON.stringify([
        'failure-snapshot-v1',
        feedId,
        stage,
        project(original),
        project(archived),
        failures,
      ]),
    )
    .digest('hex');
}

export async function persistArticleFailures(
  tx: Tx,
  attemptId: string,
  feedId: string,
  validated: Page,
  archived: Page,
  listOnly: boolean,
  observedAt: number,
  identitySkippedIds: readonly string[] = [],
  preserveFirstObserved = false,
) {
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(attemptId) ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 1
  )
    throw new Error('FAILURE_LEDGER_INPUT_INVALID');
  const input = new Map(validated.articles.map((a) => [a.id, a]));
  if (
    input.size !== validated.articles.length ||
    archived.articles.length !== input.size
  )
    throw new Error('FAILURE_LEDGER_IDENTITY_INVALID');
  const archivedIds = new Set<string>();
  for (const article of archived.articles) {
    const identity = canonicalArticleUrl(article.url);
    if (
      article.mpId !== feedId ||
      identity.mpId !== feedId ||
      identity.id !== article.id ||
      !input.has(article.id) ||
      archivedIds.has(article.id)
    )
      throw new Error('FAILURE_LEDGER_IDENTITY_INVALID');
    archivedIds.add(article.id);
  }
  const events = new Map<
    string,
    { id: string; stage: 'body' | 'media'; code: string }
  >();
  const skipped = new Set(identitySkippedIds);
  if (
    skipped.size !== identitySkippedIds.length ||
    [...skipped].some((id) => !input.has(id))
  )
    throw new Error('FAILURE_LEDGER_SKIPPED_INVALID');
  for (const failure of validated.bodyFailures ?? []) {
    const article = input.get(failure.id);
    if (
      !article ||
      !['BODY_PARSE_FAILED', 'BODY_TOO_LARGE', 'BODY_MISSING'].includes(
        failure.code,
      ) ||
      article.contentHtml !== null
    )
      throw new Error('FAILURE_LEDGER_EVENT_INVALID');
    if (!skipped.has(failure.id))
      events.set(`${failure.id}:body`, {
        id: failure.id,
        stage: 'body',
        code: failure.code,
      });
  }
  if (!listOnly)
    for (const article of archived.articles) {
      if (skipped.has(article.id)) continue;
      const original = input.get(article.id)!;
      const originalMediaPending =
        original.contentHtml?.includes('data-wewe-image-pending=') ||
        (!!original.contentHtml &&
          !article.contentHtml &&
          load(original.contentHtml)('img').length > 0);
      if (
        article.contentHtml?.includes('data-wewe-image-pending=') ||
        originalMediaPending
      )
        events.set(`${article.id}:media`, {
          id: article.id,
          stage: 'media',
          code: 'MEDIA_PENDING',
        });
    }
  for (const event of events.values()) {
    // SQLite INTEGER may hold millisecond timestamps above the 32-bit range.
    // Return decimal text to avoid driver-dependent integer decoding while
    // preserving exact comparison with our validated safe integer input.
    const rows = await tx.$queryRawUnsafe<
      Array<{ feed_id: string; code: string; observed_at: string }>
    >(
      'SELECT feed_id, code, CAST(observed_at AS TEXT) AS observed_at FROM article_failure_events WHERE attempt_id=? AND article_id=? AND stage=?',
      attemptId,
      event.id,
      event.stage,
    );
    if (
      rows.length > 1 ||
      (rows[0] &&
        (rows[0].feed_id !== feedId ||
          rows[0].code !== event.code ||
          (!preserveFirstObserved &&
            String(rows[0].observed_at) !== String(observedAt))))
    )
      throw new Error('FAILURE_LEDGER_CONFLICT');
    if (!rows.length)
      await tx.$executeRawUnsafe(
        'INSERT INTO article_failure_events(attempt_id,feed_id,article_id,stage,code,observed_at) VALUES(?,?,?,?,?,?)',
        attemptId,
        feedId,
        event.id,
        event.stage,
        event.code,
        observedAt,
      );
  }
}
