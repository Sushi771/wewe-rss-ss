import { decodeInlineImage } from './image-fetch';
import { XhsNormalizedCandidate } from './xiaohongshu-contract';

/**
 * Provisional, fail-closed contract, NOT a real-response evidence assertion.
 * Audited redbook v0.8.2 CLI uses notes/cursor/has_more and items[].note_card;
 * analyze.ts uses image_list. url_default and these CDN hosts are assumptions
 * requiring a separately reviewed sanitized real sample before live enablement.
 * No upstream implementation is copied here.
 */
export const REDBOOK_RESPONSE_CONTRACT = 'redbook-v0.8.2-url-default-v1';
const MEDIA_HOSTS = new Set([
  'sns-webpic-qc.xhscdn.com',
  'sns-webpic.xhscdn.com',
]);
const MEDIA_BUDGET = 20_000_000;
const IMAGE_BUDGET = 10_000_000;

export interface RedbookListedNote {
  noteId: string;
  authorId: string;
  /** Ephemeral request token: never put it in persisted scan state or logs. */
  xsecToken: string;
}
export interface RedbookMappedPage {
  notes: RedbookListedNote[];
  nextCursor: string | null;
  hasMore: boolean;
}

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('REDBOOK_SCHEMA_REJECTED');
  return raw as Record<string, unknown>;
}
function identifier(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    !raw ||
    raw.length > 128 ||
    /\s|[\u0000-\u001f\u007f]/.test(raw)
  )
    throw new Error('REDBOOK_IDENTITY_REJECTED');
  return raw;
}
function boundedString(raw: unknown, limit: number): string {
  if (typeof raw !== 'string' || raw.length > limit)
    throw new Error('REDBOOK_SCHEMA_REJECTED');
  return raw;
}

export function mapRedbookPage(
  raw: unknown,
  expectedAuthorId: string,
): RedbookMappedPage {
  const authorId = identifier(expectedAuthorId);
  const page = record(raw);
  if (
    !Array.isArray(page.notes) ||
    page.notes.length > 30 ||
    typeof page.has_more !== 'boolean'
  )
    throw new Error('REDBOOK_SCHEMA_REJECTED');
  const cursor = boundedString(page.cursor, 4096);
  if (page.has_more && !cursor) throw new Error('REDBOOK_CURSOR_REJECTED');
  const notes = page.notes.map((rawNote) => {
    const note = record(rawNote);
    if (identifier(record(note.user).user_id) !== authorId)
      throw new Error('REDBOOK_AUTHOR_MISMATCH');
    const xsecToken = boundedString(note.xsec_token, 4096);
    if (!xsecToken || /[\u0000-\u001f\u007f]/.test(xsecToken))
      throw new Error('REDBOOK_TOKEN_REJECTED');
    return { noteId: identifier(note.note_id), authorId, xsecToken };
  });
  return {
    notes,
    nextCursor: page.has_more ? cursor : null,
    hasMore: page.has_more,
  };
}

export function allowedRedbookMediaUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('REDBOOK_MEDIA_SOURCE_REJECTED');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    /^https?:\/\/[^/]*:\d+(?:\/|$)/i.test(raw) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !MEDIA_HOSTS.has(url.hostname)
  )
    throw new Error('REDBOOK_MEDIA_SOURCE_REJECTED');
  // Audited CDN-only compatibility: never send cleartext media requests.
  // Cookies remain omitted by the separate media transport.
  url.protocol = 'https:';
  return url;
}

/** Inject a reviewed transport explicitly. No ambient fetch or account headers. */
export type RedbookMediaTransport = (
  url: URL,
  options: {
    redirect: 'manual';
    credentials: 'omit';
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  },
) => Promise<Response>;
const blockedMediaTransport: RedbookMediaTransport = async () => {
  throw new Error('REDBOOK_MEDIA_TRANSPORT_DISABLED');
};

async function downloadMedia(
  url: URL,
  remainingBytes: number,
  transport: RedbookMediaTransport,
): Promise<{ inlineData: string; byteLength: number }> {
  let response: Response;
  try {
    response = await transport(url, {
      redirect: 'manual',
      credentials: 'omit',
      headers: Object.freeze({
        accept: 'image/png,image/jpeg,image/gif,image/webp',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Transport errors can contain signed URLs or secrets: return a fixed code.
    throw new Error('REDBOOK_MEDIA_REQUEST_FAILED');
  }
  const type = (response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (
    response.status !== 200 ||
    response.redirected ||
    (response.url && response.url !== url.href) ||
    !/^image\/(png|jpeg|gif|webp)$/.test(type) ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error('REDBOOK_MEDIA_RESPONSE_REJECTED');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > Math.min(IMAGE_BUDGET, remainingBytes)) {
        await reader.cancel();
        throw new Error('REDBOOK_MEDIA_BUDGET_EXCEEDED');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'REDBOOK_MEDIA_BUDGET_EXCEEDED'
    )
      throw error;
    throw new Error('REDBOOK_MEDIA_REQUEST_FAILED');
  }
  const inlineData = `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
  // Existing archive validator checks actual container bytes, including MIME.
  decodeInlineImage(inlineData);
  return { inlineData, byteLength: length };
}

export function inspectRedbookDetail(
  raw: unknown,
  expectedAuthorId: string,
  expectedNoteId: string,
) {
  const authorId = identifier(expectedAuthorId);
  const noteId = identifier(expectedNoteId);
  const detail = record(raw);
  if (!Array.isArray(detail.items) || detail.items.length !== 1)
    throw new Error('REDBOOK_SCHEMA_REJECTED');
  const item = record(detail.items[0]);
  const card = record(item.note_card);
  if (identifier(item.id) !== noteId || identifier(card.note_id) !== noteId)
    throw new Error('REDBOOK_NOTE_MISMATCH');
  if (identifier(record(card.user).user_id) !== authorId)
    throw new Error('REDBOOK_AUTHOR_MISMATCH');
  if (card.type !== 'normal') throw new Error('REDBOOK_NOTE_KIND_REJECTED');
  if (
    !Number.isSafeInteger(card.time) ||
    (card.time as number) < 1356998400000 ||
    (card.time as number) > Date.now() + 5 * 60_000
  )
    throw new Error('REDBOOK_PUBLICATION_TIME_REJECTED');
  const title = boundedString(card.title, 100_000);
  const text = boundedString(card.desc, 1_000_000);
  if (!Array.isArray(card.image_list) || card.image_list.length > 60)
    throw new Error('REDBOOK_IMAGE_COUNT_REJECTED');
  // Validate every URL before any image request; do not select variants/fallbacks.
  const urls = card.image_list.map((image) =>
    allowedRedbookMediaUrl(boundedString(record(image).url_default, 8192)),
  );
  if (!text.trim() && urls.length === 0)
    throw new Error('REDBOOK_BODY_REJECTED');
  return {
    authorId,
    noteId,
    title,
    text,
    urls,
    publishedAt: Math.floor((card.time as number) / 1000),
  };
}

export async function mapRedbookDetail(
  raw: unknown,
  expectedAuthorId: string,
  expectedNoteId: string,
  transport: RedbookMediaTransport = blockedMediaTransport,
): Promise<XhsNormalizedCandidate> {
  const { authorId, noteId, title, text, urls, publishedAt } =
    inspectRedbookDetail(raw, expectedAuthorId, expectedNoteId);
  let totalBytes = 0;
  const images: XhsNormalizedCandidate['images'] = [];
  for (const url of urls) {
    const media = await downloadMedia(
      url,
      MEDIA_BUDGET - totalBytes,
      transport,
    );
    totalBytes += media.byteLength;
    images.push({ ordinal: images.length + 1, inlineData: media.inlineData });
  }
  return {
    authorId,
    noteId,
    kind: 'image-text',
    // Existing archive contract stores epoch seconds, truncating milliseconds.
    publishedAt,
    title,
    text,
    textStatus: 'full',
    expectedImageCount: urls.length,
    images,
  };
}
