import { load } from 'cheerio';
import { articleIdentity } from './collection/article-page';
import { canonicalArticleUrl } from './collection/collection-format';
import { decodeInlineImage } from './collection/image-fetch';
import { validateImageSignature } from './collection/browser-dom-adapter';
import {
  prepareVerifiedProviderDownload,
  verifiedDownloadBody,
} from './article-verified-download';

/** Internal, one-article owner confirmation. Never accept this record from a
 * browser payload or use it as a directory/automatic-completeness policy. */
export type ConfirmedDomArticle = {
  pageUrl: string;
  originalUrl: string;
  title: string;
  publisher: string;
  publishTime: number;
  imageCount: number;
  confirmedComplete: true;
};

const exact = (value: unknown, keys: string[]) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const refuse = (): never => {
  throw new Error('MANUAL_DOM_ARTICLE_UNVERIFIED');
};
const normalize = (value: string) =>
  value.normalize('NFKC').replace(/\s+/g, ' ').trim();

/** Offline content adapter only. No HTTP ingress, activation, browser state,
 * network, database or new exporter. Future transport must bind this observation
 * to the authenticated one-shot task before calling it. */
export function verifyConfirmedDomArticle(
  confirmation: ConfirmedDomArticle,
  raw: unknown,
) {
  if (
    !confirmation ||
    confirmation.confirmedComplete !== true ||
    !/^https:\/\/weread\.qq\.com\/web\/mp\/reader\/[A-Za-z0-9_-]{1,256}$/.test(
      confirmation.pageUrl,
    ) ||
    !confirmation.title?.trim() ||
    !confirmation.publisher?.trim() ||
    !Number.isSafeInteger(confirmation.imageCount) ||
    confirmation.imageCount < 0 ||
    confirmation.imageCount > 60
  )
    refuse();
  const expected = canonicalArticleUrl(confirmation.originalUrl);
  if (!exact(raw, ['pageUrl', 'html', 'images', 'omittedEmptyImageNodes']))
    refuse();
  const observation = raw as {
    pageUrl: string;
    html: string;
    images: Array<{ index: number; inline: string }>;
    omittedEmptyImageNodes: number;
  };
  if (
    observation.pageUrl !== confirmation.pageUrl ||
    typeof observation.html !== 'string' ||
    Buffer.byteLength(observation.html) > 5_000_000 ||
    !Array.isArray(observation.images) ||
    observation.images.length !== confirmation.imageCount ||
    !Number.isSafeInteger(observation.omittedEmptyImageNodes) ||
    observation.omittedEmptyImageNodes < 0 ||
    observation.omittedEmptyImageNodes > 60
  )
    refuse();
  const $ = load(observation.html);
  if (
    $('#js_content').length !== 1 ||
    $('script').length !== 1 ||
    $(
      'iframe,form,input,object,embed,video,audio,svg,base,link,style,#js_verify,#verify,.weui_msg',
    ).length ||
    !/^(?:var (?:biz|mid|idx|sn|ct|create_time)="[A-Za-z0-9+/=]+";)+$/.test(
      $('script').html() || '',
    )
  )
    refuse();
  const identity = articleIdentity(observation.html);
  if (
    !identity.canonical ||
    new URL(identity.canonical).pathname !== '/s' ||
    canonicalArticleUrl(identity.canonical).url !== expected.url ||
    identity.url !== expected.url ||
    identity.id !== expected.id ||
    identity.mpId !== expected.mpId ||
    identity.publishTime !== confirmation.publishTime ||
    normalize($('#activity-name').text()) !== normalize(confirmation.title) ||
    normalize($('#js_name').text()) !== normalize(confirmation.publisher)
  )
    refuse();
  const images = $('#js_content').find('img').toArray();
  if (images.length !== confirmation.imageCount) refuse();
  let total = 0;
  images.forEach((image, index) => {
    const entry = observation.images[index];
    if (
      !exact(entry, ['index', 'inline']) ||
      entry.index !== index ||
      typeof entry.inline !== 'string' ||
      $(image).attr('src') !== `wewe-image:${index}`
    )
      refuse();
    const decoded = decodeInlineImage(entry.inline);
    total += decoded.bytes.length;
    if (
      total > 20_000_000 ||
      !validateImageSignature(decoded.bytes, decoded.type)
    )
      refuse();
    $(image).attr('src', entry.inline);
  });
  return {
    id: identity.id,
    mpId: identity.mpId,
    url: identity.url,
    shortUrl: null,
    title: $('#activity-name').text().trim(),
    publishTime: identity.publishTime!,
    contentHtml: verifiedDownloadBody($.html($('#js_content'))),
    picUrl: '',
  };
}

export function prepareConfirmedDomDownload(
  confirmation: ConfirmedDomArticle,
  raw: unknown,
) {
  const article = verifyConfirmedDomArticle(confirmation, raw);
  return prepareVerifiedProviderDownload(article.url, article);
}
