import { createHash } from 'node:crypto';
import { xhsPublicInputUrl } from './xhs-short-link';
import { XhsSubscriptionError } from './xhs-subscription-errors';

export type BatchInput = {
  index: number;
  fingerprint: string;
  url?: string;
  code?: 'XHS_URL_INVALID';
  duplicateOf?: number;
  kind: 'note' | 'author' | 'short' | 'invalid';
};

/** Raw URLs are returned only to the caller's transient memory, never persisted. */
export function parseBatchInput(text: string): BatchInput[] {
  if (typeof text !== 'string' || text.length > 65536)
    throw new XhsSubscriptionError('XHS_BATCH_INPUT_INVALID');
  const candidates: string[] = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  if (!candidates.length || candidates.length > 100)
    throw new XhsSubscriptionError('XHS_BATCH_INPUT_INVALID');
  const seen = new Map<string, number>();
  return candidates.map<BatchInput>((raw, index) => {
    const standalone = candidates.length === 1 && text.trim() === raw;
    const value = standalone ? raw : raw.replace(/[，。！？）】,;!?)]+$/u, '');
    try {
      if (raw.includes('?') && value !== raw) throw Error();
      const url = xhsPublicInputUrl(value);
      const segments = url.pathname.split('/').filter(Boolean);
      const id = segments[segments.length - 1];
      const kind =
        url.hostname === 'www.xiaohongshu.com'
          ? url.pathname.startsWith('/user/profile/')
            ? 'author'
            : 'note'
          : 'short';
      const namespace =
        kind === 'short'
          ? url.hostname + ':' + segments.slice(0, -1).join('/')
          : kind;
      const fingerprint = createHash('sha256')
        .update(namespace + ':' + id)
        .digest('hex');
      const previous = seen.get(fingerprint);
      if (previous !== undefined)
        return { index, fingerprint, kind, duplicateOf: previous };
      seen.set(fingerprint, index);
      return { index, fingerprint, kind, url: url.href };
    } catch {
      // Hash only a per-item label; never retain a hash of a possibly secret URL.
      return {
        index,
        fingerprint: `invalid-${index}`,
        kind: 'invalid',
        code: 'XHS_URL_INVALID',
      };
    }
  });
}
