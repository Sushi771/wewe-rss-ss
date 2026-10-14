import { z } from 'zod';
import type { RedbookClient } from './redbook-client';
import type { RedbookListedNote } from './redbook-response';
import type { FileRedbookStateStore } from './redbook-scan-state';

export const diagnosticConfirm = z
  .object({ confirmRequest: z.literal(true) })
  .strict();
export const diagnosticDetailInput = diagnosticConfirm
  .extend({ noteId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) })
  .strict();
export const diagnosticImageInput = z
  .object({
    confirmImages: z.literal(true),
    maxImages: z.number().int().min(1).max(2),
    maxBytes: z.number().int().min(1024).max(1_000_000),
  })
  .strict();
export const diagnosticReviewInput = z
  .object({
    authorIdentityChecked: z.literal(true),
    fullTextChecked: z.literal(true),
    allImagesChecked: z.literal(true),
    publicationTimeChecked: z.literal(true),
    allowFutureArchive: z.literal(true),
    observedText: z.string().max(1_000_000),
    observedImageCount: z.number().int().min(0).max(60),
    publishedAt: z.number().int().positive(),
  })
  .strict();
export type DiagnosticSession = {
  cookies: Record<string, string>;
  expiresAt: number;
  creatorId: string;
  authorId: string;
  profileUrl: string;
  client: RedbookClient;
  store: FileRedbookStateStore;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
  phase: 'ready' | 'listed' | 'sample-ready' | 'paused';
  listSpent: boolean;
  detailSpent: boolean;
  imagesSpent: boolean;
  imageAttempts: number;
  notes: RedbookListedNote[];
  list?: unknown;
  detail?: unknown;
  noteId?: string;
  stopCategory?: string;
  images: { ordinal: number; inlineData: string; bytes: number }[];
  flight?: Promise<void>;
};

/** Private preview/export: redact account/session/signature fields and URL queries.
 * No secret is persisted; depth/item/string limits also bound unknown schemas.
 */
export function diagnosticPreview(
  raw: unknown,
  secrets: string[],
  depth = 0,
  key = '',
): unknown {
  if (
    /(token|cookie|authorization|signature|password|session|secret|^a1$|^x[-_])/i.test(
      key,
    )
  )
    return '[redacted]';
  if (depth > 8) return '[depth limited]';
  if (typeof raw === 'string') {
    if (secrets.some((secret) => secret && raw.includes(secret)))
      return '[redacted]';
    // Also cover HTML, leading whitespace and JSON-escaped URLs in unknown fields.
    return raw
      .replace(/https?:\/(?:\\?\/)[^\s<>"']+/gi, (candidate) => {
        try {
          const url = new URL(candidate.replace(/\\\//g, '/'));
          return url.origin + url.pathname;
        } catch {
          return '[invalid URL]';
        }
      })
      .replace(/https?:\\\/\\\/[^\s<>"']+/gi, (candidate) => {
        try {
          const url = new URL(candidate.replace(/\\\//g, '/'));
          return url.origin + url.pathname;
        } catch {
          return '[invalid URL]';
        }
      })
      .slice(0, key === 'desc' ? 1_000_000 : 4096);
  }
  if (Array.isArray(raw))
    return raw
      .slice(0, 60)
      .map((value) => diagnosticPreview(value, secrets, depth + 1, key));
  if (raw && typeof raw === 'object')
    return Object.fromEntries(
      Object.entries(raw)
        .slice(0, 100)
        .map(([name, value]) => [
          name,
          diagnosticPreview(value, secrets, depth + 1, name),
        ]),
    );
  return raw;
}
export function diagnosticSummary(session?: DiagnosticSession) {
  if (!session)
    return {
      configured: false,
      reviewed: false,
      archiveAllowed: false,
      phase: 'empty',
      listRequests: 0,
      detailRequests: 0,
      imageRequests: 0,
    };
  return {
    configured: session.expiresAt > Date.now() && !session.abort.signal.aborted,
    reviewed: false,
    archiveAllowed: false,
    phase: session.phase,
    expiresAt: session.expiresAt,
    creatorId: session.creatorId,
    authorId: session.authorId,
    profileUrl: session.profileUrl,
    listRequests: Number(session.listSpent),
    detailRequests: Number(session.detailSpent),
    imageRequests: session.imageAttempts,
    stopCategory: session.stopCategory || null,
    notes: session.notes.map((note) => ({ noteId: note.noteId })),
    noteId: session.noteId || null,
    listBudget: 1,
    detailBudget: 1,
    maxImageBudget: 2,
    maxImageBytes: 1_000_000,
    imagesAttempted: session.imagesSpent,
  };
}
