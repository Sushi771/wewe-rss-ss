import { XhsSubscriptionError } from './xhs-subscription-errors';
import { xhsPublicInputUrl } from './xhs-short-link';
/** Only a supplied URL whose note/author relationship was checked by resolve.
 * An API token plus a locally chosen source constant is not a PC-link contract. */
export function sourceOriginalLink(
  raw: string,
  resolved: URL,
  noteId: string,
): string | undefined {
  try {
    if (
      resolved.pathname.split('/').filter(Boolean).pop() !== noteId ||
      !/^\/(?:explore|discovery\/item)\//.test(resolved.pathname)
    )
      return;
    const input = xhsPublicInputUrl(raw);
    const pc = xhsPublicInputUrl(resolved.href);
    const short = ['xhslink.com', 'xhslink.cn'].includes(input.hostname);
    if (!short && input.href !== pc.href) return;
    const keys = [...pc.searchParams.keys()];
    if (
      keys.every((k) =>
        [
          'xsec_token',
          'xsec_source',
          'm_source',
          'note_flow_source',
          'source',
        ].includes(k),
      ) &&
      keys.every(
        (k) =>
          pc.searchParams.getAll(k).length === 1 &&
          pc.searchParams.get(k)!.length <= 4096 &&
          !/[\x00-\x20\x7f]/.test(pc.searchParams.get(k)!),
      ) &&
      pc.searchParams.getAll('xsec_token').length === 1 &&
      pc.searchParams.getAll('xsec_source').length === 1 &&
      pc.searchParams.get('xsec_token') &&
      pc.searchParams.get('xsec_source') &&
      pc.searchParams.get('xsec_token')!.length <= 4096 &&
      pc.searchParams.get('xsec_source')!.length <= 128 &&
      !/[\x00-\x20\x7f]/.test(
        pc.searchParams.get('xsec_token')! +
          pc.searchParams.get('xsec_source')!,
      )
    )
      return pc.href;
    if (['xhslink.com', 'xhslink.cn'].includes(input.hostname))
      return input.href;
  } catch {
    /* Fixed not-ready result; no URL or provider text escapes. */
  }
}

/** Official PC Web index.a9f61821.js: User context -> pc_user; ExplorePath=/explore.
 * Use only the token of the checked same-author list item. */
export function sourceUserPcLink(noteId: string, token: string): string {
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(noteId) ||
    !token ||
    token.length > 4096 ||
    /[\x00-\x20\x7f]/.test(token)
  )
    throw new XhsSubscriptionError('XHS_ORIGINAL_LINK_CONTEXT_UNAVAILABLE');
  const url = new URL('https://www.xiaohongshu.com/explore/' + noteId);
  url.searchParams.set('xsec_token', token);
  url.searchParams.set('xsec_source', 'pc_user');
  if (url.href.length > 8192)
    throw new XhsSubscriptionError('XHS_ORIGINAL_LINK_CONTEXT_UNAVAILABLE');
  return url.href;
}
