import { createHash } from 'node:crypto';
import { decodeInlineImage } from './image-fetch';

// Internal normalized contract only. No A/B response mapping, URL fetch, database
// registration or trusted Provider is implemented here. Real evidence is pending.
function identity(kind: 'author' | 'note', value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 128 ||
    /\s|[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error('XHS_IDENTITY_INVALID');
  // Tuple encoding prevents collisions without guessing supplier ID syntax.
  return JSON.stringify(['xiaohongshu', kind, value]);
}

export interface XhsNormalizedCandidate {
  authorId: string;
  noteId: string;
  kind: 'image-text' | 'video';
  publishedAt: number;
  title: string;
  text: string;
  textStatus: 'full' | 'summary' | 'unknown';
  expectedImageCount: number | null;
  images: { ordinal: number; inlineData: string }[];
}

export function xhsArchiveDraft(
  expectedAuthorId: string,
  input: XhsNormalizedCandidate,
) {
  const authorKey = identity('author', input.authorId);
  if (authorKey !== identity('author', expectedAuthorId))
    throw new Error('XHS_AUTHOR_MISMATCH');
  const noteKey = identity('note', input.noteId);
  if (
    !Number.isSafeInteger(input.publishedAt) ||
    input.publishedAt <= 0 ||
    input.publishedAt > 253402300799
  )
    throw new Error('XHS_PUBLICATION_TIME_MISSING');
  if (!['image-text', 'video'].includes(input.kind))
    throw new Error('XHS_KIND_INVALID');
  if (input.kind === 'video')
    return {
      authorKey,
      noteKey,
      verified: false as const,
      status: 'video-skipped' as const,
    };
  if (
    typeof input.title !== 'string' ||
    typeof input.text !== 'string' ||
    !['full', 'summary', 'unknown'].includes(input.textStatus)
  )
    throw new Error('XHS_BODY_INVALID');
  if (
    input.expectedImageCount !== null &&
    (!Number.isSafeInteger(input.expectedImageCount) ||
      input.expectedImageCount < 0 ||
      input.expectedImageCount > 60)
  )
    throw new Error('XHS_IMAGE_COUNT_INVALID');
  if (!Array.isArray(input.images) || input.images.length > 60)
    throw new Error('XHS_IMAGE_COUNT_INVALID');
  let totalImageBytes = 0;
  // 逐位校验，包括稀疏数组空位；长度相等不能替代实际图片字节。
  const images = Array.from(input.images, (image, index) => {
    if (!image || image.ordinal !== index + 1)
      throw new Error('XHS_IMAGE_ORDER_INVALID');
    const decoded = decodeInlineImage(image.inlineData);
    totalImageBytes += decoded.bytes.length;
    if (totalImageBytes > 20_000_000)
      throw new Error('XHS_MEDIA_BUDGET_EXCEEDED');
    return {
      ordinal: image.ordinal,
      type: decoded.type,
      bytes: decoded.bytes,
      sha256: createHash('sha256').update(decoded.bytes).digest('hex'),
    };
  });
  const readyForEvidenceCheck =
    input.textStatus === 'full' &&
    (!!input.text.trim() || images.length > 0) &&
    input.expectedImageCount === images.length;
  return {
    authorKey,
    noteKey,
    verified: false as const,
    status: 'candidate' as const,
    publishedAt: input.publishedAt,
    title: input.title,
    text: input.text,
    images,
    readyForEvidenceCheck,
  };
}

export type XhsArchiveDraft = ReturnType<typeof xhsArchiveDraft>;

/** No edit/version history policy: keep an existing complete candidate intact. */
export function retainXhsArchiveDraft(
  previous: XhsArchiveDraft,
  incoming: XhsArchiveDraft,
): XhsArchiveDraft {
  if (
    previous.noteKey !== incoming.noteKey ||
    previous.authorKey !== incoming.authorKey
  )
    throw new Error('XHS_ARCHIVE_IDENTITY_CONFLICT');
  if (previous.status === 'candidate' && previous.readyForEvidenceCheck)
    return previous;
  if (incoming.status !== 'candidate' || !incoming.readyForEvidenceCheck)
    return previous;
  return incoming;
}

export interface XhsPageLedger {
  authorKey: string;
  nextCursor: string | null;
  requestedCursors: (string | null)[];
  noteKeys: string[];
  supplierReportedEnd: boolean;
}
export function xhsPageLedger(authorId: string): XhsPageLedger {
  return {
    authorKey: identity('author', authorId),
    nextCursor: null,
    requestedCursors: [],
    noteKeys: [],
    supplierReportedEnd: false,
  };
}

/** Cursor fields are internal. A/B cursor paths and termination remain unknown. */
export function appendXhsPage(
  ledger: XhsPageLedger,
  page: {
    authorId: string;
    requestCursor: string | null;
    nextCursor: string | null;
    items: { authorId: string; noteId: string }[];
  },
  maxPages: number,
): { ledger: XhsPageLedger; newNoteKeys: string[] } {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100)
    throw new Error('XHS_PAGE_BUDGET_INVALID');
  if (ledger.supplierReportedEnd || ledger.requestedCursors.length >= maxPages)
    throw new Error('XHS_PAGE_WINDOW_STOPPED');
  if (identity('author', page.authorId) !== ledger.authorKey)
    throw new Error('XHS_AUTHOR_MISMATCH');
  for (const cursor of [page.requestCursor, page.nextCursor])
    if (
      cursor !== null &&
      (typeof cursor !== 'string' || !cursor || cursor.length > 4096)
    )
      throw new Error('XHS_CURSOR_INVALID');
  if (
    page.requestCursor !== ledger.nextCursor ||
    ledger.requestedCursors.includes(page.requestCursor)
  )
    throw new Error('XHS_CURSOR_REPLAY');
  const requestedCursors = [...ledger.requestedCursors, page.requestCursor];
  if (page.nextCursor !== null && requestedCursors.includes(page.nextCursor))
    throw new Error('XHS_CURSOR_CYCLE');
  if (!Array.isArray(page.items) || page.items.length > 200)
    throw new Error('XHS_PAGE_TOO_LARGE');
  const noteKeys = new Set(ledger.noteKeys);
  const newNoteKeys: string[] = [];
  for (const item of page.items) {
    if (identity('author', item.authorId) !== ledger.authorKey)
      throw new Error('XHS_AUTHOR_MISMATCH');
    const key = identity('note', item.noteId);
    if (!noteKeys.has(key)) {
      noteKeys.add(key);
      newNoteKeys.push(key);
    }
  }
  return {
    ledger: {
      ...ledger,
      requestedCursors,
      noteKeys: [...noteKeys],
      nextCursor: page.nextCursor,
      supplierReportedEnd: page.nextCursor === null,
    },
    newNoteKeys,
  };
}
