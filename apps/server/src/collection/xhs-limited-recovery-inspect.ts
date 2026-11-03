import { createHash } from 'node:crypto';
import { allowedRedbookMediaUrl, mapRedbookBasicDetail } from './redbook-response';
import { selectXhsNativeDetail } from './xhs-native-media';

/** Offline projection only: no transport, storage or risk-state mutation. */
export function inspectLimitedRecovery(
  raw: unknown,
  expectedAuthorId: string,
  expectedNoteId: string,
) {
  const detail = mapRedbookBasicDetail(raw, expectedAuthorId, expectedNoteId);
  let urls: URL[] = [], mediaFailure: 'XHS_MEDIA_MANIFEST_UNAVAILABLE' | undefined;
  try {
    const selected = selectXhsNativeDetail(raw, expectedAuthorId, expectedNoteId);
    urls = selected.items[0].note_card.image_list.map((image: {url_default:unknown}) => {
      if (typeof image.url_default !== 'string' || image.url_default.length > 8192) throw Error();
      return allowedRedbookMediaUrl(image.url_default);
    });
  } catch { mediaFailure = 'XHS_MEDIA_MANIFEST_UNAVAILABLE'; }
  if (detail.kind === 'video') mediaFailure = 'XHS_MEDIA_MANIFEST_UNAVAILABLE';
  return {
    authorId: detail.authorId,
    noteId: detail.noteId,
    kind: detail.kind,
    title: detail.title ?? '',
    text: detail.text ?? '',
    publishedAt: detail.publishedAt ?? 0,
    metrics: detail.metrics,
    mediaFailure,
    media: urls.map((url, index) => ({
      ordinal: index + 1,
      state: 'not-downloaded' as const,
      sourceFingerprint: createHash('sha256').update(url.href).digest('hex'),
      sourceUrl: url.origin + url.pathname,
      sourceQueryOmitted: !!url.search,
    })),
  };
}
