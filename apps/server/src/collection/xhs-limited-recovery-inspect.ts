import { createHash } from 'node:crypto';
import { inspectRedbookDetail } from './redbook-response';
import { selectXhsNativeDetail } from './xhs-native-media';
import { xhsNoteMetrics } from './xhs-engagement-contract';

/** Offline projection only: no transport, storage or risk-state mutation. */
export function inspectLimitedRecovery(
  raw: unknown,
  expectedAuthorId: string,
  expectedNoteId: string,
) {
  const selected = selectXhsNativeDetail(raw, expectedAuthorId, expectedNoteId);
  const detail = inspectRedbookDetail(
    selected,
    expectedAuthorId,
    expectedNoteId,
  );
  const card = selected.items[0].note_card;
  return {
    authorId: detail.authorId,
    noteId: detail.noteId,
    title: detail.title,
    text: detail.text,
    publishedAt: detail.publishedAt,
    metrics: xhsNoteMetrics(card),
    media: detail.urls.map((url, index) => ({
      ordinal: index + 1,
      state: 'not-downloaded' as const,
      sourceFingerprint: createHash('sha256').update(url.href).digest('hex'),
      sourceUrl: url.origin + url.pathname,
      sourceQueryOmitted: !!url.search,
    })),
  };
}
