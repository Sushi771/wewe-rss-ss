import { load } from 'cheerio';

/** Read channel metadata from an already-subscribed RSS cache, never item images.
 * The caller must use the receipt/list-proved numeric feed path on its own
 * configured instance. Missing/bad metadata must not block article imports. */
export function parseWechat2RssFeedAvatar(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4_000_000)
    return undefined;
  try {
    const $ = load(raw, { xmlMode: true });
    const value = $('rss > channel > image > url').first().text().trim();
    if (!value || value.length > 2048) return undefined;
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.searchParams.has('k') ||
      !/(^|\.)(qlogo\.cn|qpic\.cn)$/.test(url.hostname)
    )
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
