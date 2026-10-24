import { allowedRedbookMediaUrl } from './redbook-response';

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
