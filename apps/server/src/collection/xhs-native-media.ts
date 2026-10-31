import { createHash } from 'node:crypto';
import { allowedRedbookMediaUrl, downloadRedbookMedia, mapRedbookBasicDetail, RedbookMediaTransport } from './redbook-response';
import { XhsMediaError } from './xhs-media-error';
import { decodeInlineImage } from './image-fetch';

const FULL = new Set(['WB_DFT', 'CRD_WM_JPG', 'CRD_WM_WEBP', 'ND_DFT']);
const number = (v: unknown) =>
  Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 50000
    ? (v as number)
    : 0;
const dims = (v: any) => ({
  width: number(v?.width ?? v?.image_width),
  height: number(v?.height ?? v?.image_height),
});
/** Port of the previously tested single-note candidate selection. No request or
 * source URL is logged; only a proven full-image candidate on the two CDNs wins. */
export function chooseXhsNativeImage(image: any): string {
  const choices: { url: string; area: number; priority: number }[] = [];
  const compatibility: typeof choices = [];
  const slot = dims(image);
  const add = (
    raw: unknown,
    field: string,
    scene: unknown,
    full: boolean,
    container: unknown,
  ) => {
    if (
      typeof raw !== 'string' ||
      raw.length > 8192 ||
      /[\\\s\x00-\x1f\x7f]/.test(raw) ||
      field === 'url_pre' ||
      (typeof scene === 'string' && /PRV|PREVIEW|THUMB|SMALL/i.test(scene))
    )
      return;
    const size = dims(container);
    if (
      !full &&
      !(typeof scene === 'string' && FULL.has(scene)) &&
      !(
        size.width &&
        size.height &&
        slot.width &&
        slot.height &&
        size.width >= slot.width &&
        size.height >= slot.height
      )
    )
      return;
    try {
      // Reject normalization hazards before the shared validator upgrades HTTP.
      // Explicit default ports and empty userinfo/fragments must also fail closed.
      if (
        /^https?:\/\/[^/?#]*[:@]/i.test(raw) ||
        raw.includes('#') ||
        /[\\\x00-\x1f\x7f]/.test(decodeURI(raw))
      )
        return;
      const original = new URL(raw);
      const validated = allowedRedbookMediaUrl(raw);
      if (
        validated.hostname !== original.hostname ||
        validated.pathname !== original.pathname ||
        validated.search !== original.search
      )
        return;
      const pool = original.protocol === 'https:' ? choices : compatibility;
      pool.push({
        url: validated.href,
        area: size.width * size.height,
        priority:
          field === 'url_size_large' ? 3 : field === 'info_list' ? 2 : 1,
      });
    } catch {
      /* reject this candidate only */
    }
  };
  for (const object of [image, image?.image_info]) {
    if (!object || typeof object !== 'object' || Array.isArray(object))
      continue;
    for (const key of ['url_size_large', 'url_default', 'url', 'url_pre']) {
      const value = object[key];
      if (typeof value === 'string')
        add(
          value,
          key,
          null,
          key !== 'url_pre',
          object === image ? undefined : object,
        );
      else if (value && typeof value === 'object' && !Array.isArray(value))
        add(value.url, key, value.image_scene, key !== 'url_pre', value);
    }
    if (Array.isArray(object.info_list))
      for (const variant of object.info_list.slice(0, 60))
        if (variant && typeof variant === 'object')
          add(variant.url, 'info_list', variant.image_scene, false, variant);
  }
  // Compatibility is a fallback only after every native HTTPS candidate fails.
  const selected = choices.length ? choices : compatibility;
  selected.sort((a, b) => b.area - a.area || b.priority - a.priority);
  if (!selected.length) throw Error('XHS_NATIVE_MEDIA_UNAVAILABLE');
  return selected[0].url;
}
export function selectXhsNativeDetail(
  raw: any,
  authorId: string,
  noteId: string,
) {
  const item = raw?.items?.length === 1 ? raw.items[0] : null,
    card = item?.note_card;
  if (
    item?.id !== noteId ||
    card?.note_id !== noteId ||
    card?.user?.user_id !== authorId ||
    !Array.isArray(card.image_list) ||
    card.image_list.length > 60
  )
    throw Error('XHS_NATIVE_DETAIL_INVALID');
  const images = card.image_list.map((image: unknown) => ({
    ...(image as object),
    url_default: chooseXhsNativeImage(image),
  }));
  return {
    ...raw,
    items: [{ ...item, note_card: { ...card, image_list: images } }],
  };
}


/** Persist this projection only. URL-bearing accessors stay in memory. A key
 * binds the exact selected URL (including its query), not an assumed CDN path
 * identity. A changed signature therefore requires reconciliation, never reuse. */
export type XhsMediaManifest = {
  authorId: string; noteId: string; version: string;
  images: Array<{ ordinal: number; resourceKey: string | null }>;
};
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
export function extractXhsMediaManifest(raw: unknown, authorId: string, noteId: string) {
  // Validate identity before touching any URL. Basic parsing is independent of
  // image parsing, and caller can persist it even if this function rejects.
  mapRedbookBasicDetail(raw, authorId, noteId);
  const card = (raw as any).items[0].note_card;
  if (!Array.isArray(card.image_list) || card.image_list.length > 60)
    throw Error('XHS_MEDIA_MANIFEST_UNAVAILABLE');
  const urls = new Map<string, string>();
  const images = card.image_list.map((image: unknown, i: number) => {
    try {
      const url = chooseXhsNativeImage(image);
      const resourceKey = digest(url);
      urls.set(resourceKey, url);
      return { ordinal: i + 1, resourceKey };
    } catch { return { ordinal: i + 1, resourceKey: null }; }
  });
  const manifest: XhsMediaManifest = { authorId, noteId, images,
    version: digest(JSON.stringify([authorId, noteId, images])) };
  return { manifest, getUrl: (key: string) => urls.get(key) };
}

export type XhsMediaResumeStore = {
  /** Check durable bytes and version/ordinal binding, not just a status flag. */
  readVerifiedOrdinal: (manifest: XhsMediaManifest, ordinal: number) => Promise<string | null>;
  /** Return validated saved bytes for duplicate identities, or null. */
  readVerified: (manifest: XhsMediaManifest, resourceKey: string) => Promise<string | null>;
  /** Persisted attempt state: unknown/restricted stops; expired needs refresh. */
  attemptState: (manifest: XhsMediaManifest, ordinal: number) => Promise<'ready' | 'refresh' | 'stop'>;
  /** Atomically reserve this request and recheck the shared source gate. */
  begin: (manifest: XhsMediaManifest, ordinal: number) => Promise<void>;
  /** Atomically save validated data and its receipt for this ordinal. */
  commit: (manifest: XhsMediaManifest, ordinal: number, inlineData: string) => Promise<void>;
  /** Persist only this fixed classification, never the original exception or URL. */
  fail: (manifest: XhsMediaManifest, ordinal: number, code: string) => Promise<void>;
};
/** Caller persists manifest with the basic response before invoking. No URL or
 * exception text is persisted here. A refreshed manifest must be reconciled by
 * the owner before resuming; this function never changes versions itself. */
export async function resumeXhsMedia(
  manifest: XhsMediaManifest,
  getUrl: (key: string) => string | undefined,
  store: XhsMediaResumeStore,
  transport: RedbookMediaTransport,
  runAttempt: <T>(ordinal: number, work: () => Promise<T>) => Promise<T> = async (_ordinal, work) => work(),
) {
  const expectedVersion = digest(JSON.stringify([manifest.authorId, manifest.noteId, manifest.images]));
  if (manifest.version !== expectedVersion || manifest.images.length > 60 ||
      manifest.images.some((image, i) => image.ordinal !== i + 1 ||
        (image.resourceKey !== null && !/^[a-f0-9]{64}$/.test(image.resourceKey))))
    throw Error('XHS_MEDIA_MANIFEST_INVALID');
  const mediaLimit = 20_000_000;
  let saved = 0, pending = 0, totalBytes = 0;
  const completed = new Set<number>(), refreshKeys = new Set<string>();
  // Scan all persisted gates before any reuse or request. A stopped later slot
  // pauses the entire lane, even when an earlier duplicate has saved bytes.
  for (const image of manifest.images) {
    const attempt = await store.attemptState(manifest, image.ordinal);
    if (attempt === 'stop') throw new XhsMediaError('XHS_MEDIA_REVIEW_REQUIRED');
    if (attempt !== 'ready' && image.resourceKey) refreshKeys.add(image.resourceKey);
    const data = await store.readVerifiedOrdinal(manifest, image.ordinal);
    if (data !== null) {
      try { totalBytes += decodeInlineImage(data).bytes.length; }
      catch { throw new XhsMediaError('XHS_MEDIA_BYTES_INVALID'); }
      completed.add(image.ordinal);
    }
  }
  if (totalBytes > mediaLimit) throw new XhsMediaError('XHS_MEDIA_SIZE_REJECTED');
  for (const image of manifest.images) {
    if (completed.has(image.ordinal)) continue;
    const attempt = await store.attemptState(manifest, image.ordinal);
    if (attempt === 'stop') throw new XhsMediaError('XHS_MEDIA_REVIEW_REQUIRED');
    if (attempt !== 'ready' && image.resourceKey) refreshKeys.add(image.resourceKey);
    if (!image.resourceKey || refreshKeys.has(image.resourceKey)) { pending++; continue; }
    const existing = await store.readVerified(manifest, image.resourceKey);
    if (existing !== null) {
      let length: number;
      try { length = decodeInlineImage(existing).bytes.length; }
      catch { throw new XhsMediaError('XHS_MEDIA_BYTES_INVALID'); }
      if (totalBytes + length > mediaLimit) throw new XhsMediaError('XHS_MEDIA_SIZE_REJECTED');
      await store.commit(manifest, image.ordinal, existing);
      totalBytes += length; saved++; continue;
    }
    const raw = getUrl(image.resourceKey);
    if (!raw) { pending++; continue; }
    let url: URL;
    try { url = allowedRedbookMediaUrl(raw); } catch { throw Error('XHS_MEDIA_MANIFEST_INVALID'); }
    if (digest(url.href) !== image.resourceKey) throw Error('XHS_MEDIA_MANIFEST_INVALID');
    if (totalBytes >= mediaLimit) throw new XhsMediaError('XHS_MEDIA_SIZE_REJECTED');
    const outcome = await runAttempt(image.ordinal, async () => {
      await store.begin(manifest, image.ordinal);
      let media: { inlineData: string; byteLength: number };
      try { media = await downloadRedbookMedia(url, mediaLimit - totalBytes, transport); }
      catch (error) {
        const code = error instanceof XhsMediaError && /^XHS_MEDIA_(?:HTTP_[1-5][0-9]{2}|TRANSPORT_FAILED|TIMEOUT|EMPTY|TYPE_REJECTED|SIZE_REJECTED|BYTES_INVALID|RESPONSE_INVALID)$/.test(error.code) ? error.code : 'XHS_MEDIA_OUTCOME_UNKNOWN';
        await store.fail(manifest, image.ordinal, code);
        return { code } as const;
      }
      await store.commit(manifest, image.ordinal, media.inlineData);
      return { media } as const;
    });
    if (outcome.code !== undefined) {
      const code = outcome.code;
      // Missing/expired URLs are shared by identical resource keys.
      if (code === 'XHS_MEDIA_HTTP_404' || code === 'XHS_MEDIA_HTTP_410') { refreshKeys.add(image.resourceKey); pending++; continue; }
      throw new XhsMediaError(code);
    }
    totalBytes += outcome.media.byteLength; saved++;
  }
  return { saved, pending, needsDetailRefresh: pending > 0 };
}
