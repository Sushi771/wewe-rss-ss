import { load } from 'cheerio';
import { decodeInlineImage } from './collection/image-fetch';
import { inertDownloadBody } from './wechat2rss-cache-body';

const unavailable = () =>
  Object.assign(new Error('CACHE_UNAVAILABLE'), { code: 'CACHE_UNAVAILABLE' });

/** Cached Wechat HTML only: no network, caller, database, path or write access.
 * Narrow extraction of the strict verifiedDownloadBody policy from production
 * 8a3141c, reusing main's byte decoder and inert-body policy. Pending media is
 * refused rather than silently yielding a partial offline article. The unchanged
 * Sites contract applies its tighter per-response limits after projection.
 */
export function verifySitesWechatCachedBody(html: unknown): string {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 35_000_000)
    throw unavailable();
  try {
    const $ = load(html);
    if (
      $(
        '#js_verify, #verify, .weui_msg, iframe[src*="captcha."], form[action*="/mp/verify"], form[action*="login"], input[type="password"]',
      ).length
    )
      throw unavailable();
    const body = $('#js_content, .rich_media_content').first();
    const images = body.find('img').toArray();
    if (
      !body.length ||
      (!body.text().trim() && !images.length) ||
      images.length > 60 ||
      body.is('[data-wewe-image-pending]') ||
      body.find('[data-wewe-image-pending], [data-wewe-image-unconfirmed]')
        .length
    )
      throw unavailable();
    let totalBytes = 0;
    let encodedBytes = 0;
    for (const image of images) {
      const source = $(image).attr('src') || '';
      totalBytes += decodeInlineImage(source).bytes.length;
      encodedBytes += Buffer.byteLength(source);
      if (totalBytes > 20_000_000) throw unavailable();
    }
    if (Buffer.byteLength($.html(body)) - encodedBytes > 5_000_000)
      throw unavailable();
    const content = inertDownloadBody($.html(body));
    const clean = load(content)('#js_content');
    if (!clean.text().trim() && !clean.find('img').length) throw unavailable();
    return content;
  } catch {
    throw unavailable();
  }
}
