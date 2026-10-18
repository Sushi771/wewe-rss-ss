// Pure URL/body guards extracted from the deployed cache-selection dependency.
import { load } from 'cheerio';
import { publicArticleRequestUrl } from './collection/public-album';
import { ArticleVerification } from '../../../packages/shared/src/article-verification';
type RedirectKind = 'verification' | 'login' | 'article' | 'other' | 'missing';

export type PublicRedirectDiagnostic = {
  hostKind: 'official-article' | 'official-login' | 'other' | 'missing';
  pathKind: RedirectKind;
  verificationReason?: Extract<
    ArticleVerification,
    { status: 'unavailable' }
  >['reason'];
};

export type DownloadDiagnostic = {
  code: string;
  stage?: 'article' | 'image';
  upstreamStatus?: number;
  redirectKind?: RedirectKind;
};

export class ArticleDownloadError extends Error {
  readonly officialVerification?: ArticleVerification;
  constructor(
    message: string,
    readonly status = 422,
    readonly diagnostic: DownloadDiagnostic = { code: 'DOWNLOAD_FAILED' },
    officialVerification?: ArticleVerification,
  ) {
    super(message);
    // Full Location belongs only to this local request, never diagnostic logs.
    if (officialVerification)
      Object.defineProperty(this, 'officialVerification', {
        value: officialVerification,
        enumerable: false,
      });
  }
}

export function downloadArticleUrl(raw: unknown): string {
  try {
    if (typeof raw !== 'string' || raw.length > 2000) throw new Error();
    const input = raw.trim();
    if (/[\\\s\x00-\x1f\x7f]/.test(input)) throw new Error();
    const url = new URL(input);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'mp.weixin.qq.com' ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error();
    if (/^\/s\/[A-Za-z0-9_-]{22}$/.test(url.pathname))
      return `${url.origin}${url.pathname}`;
    if (
      ['__biz', 'mid', 'idx', 'sn', 'chksm', 'appmsgid', 'itemidx'].some(
        (key) => url.searchParams.getAll(key).length > 1,
      )
    )
      throw new Error();
    const result = publicArticleRequestUrl(input);
    if (
      !/^[a-fA-F0-9]{4,64}$/.test(new URL(result).searchParams.get('sn') || '')
    )
      throw new Error();
    return result;
  } catch {
    throw new ArticleDownloadError(
      '请粘贴有效的 HTTPS 微信公众号文章链接（mp.weixin.qq.com/s）。',
      400,
      { code: 'INVALID_ARTICLE_URL', stage: 'article' },
    );
  }
}

/** Detect media before articleContentHtml removes embedded players or attributes.
 * This single-article path has no verified audio/video acquisition contract.
 */
function assertDownloadMediaSupported(
  body: ReturnType<ReturnType<typeof load>>,
) {
  if (
    body.find(
      'video, audio, mp-common-video, mpvoice, qqmusic, .video_iframe, .js_video_channel_container, iframe[data-vid], iframe[src*="video.qq.com"], iframe[data-src*="video.qq.com"]',
    ).length
  )
    throw new ArticleDownloadError(
      '文章包含音视频，本工具尚不能取得并核验这些资源；未保存正文或图片，请在官方页面查看。',
      422,
      { code: 'ARTICLE_MEDIA_UNAVAILABLE', stage: 'article' },
    );
}

/** Same inert body policy for remote articles and already verified local bodies. */
export function inertDownloadBody(content: string) {
  const $ = load(content);
  const body = $('#js_content, .rich_media_content').first();
  if (!body.length)
    throw new ArticleDownloadError('未取得有效文章正文，未生成下载文件。');
  assertDownloadMediaSupported(body);
  const tags = new Set(
    'div section p span br h1 h2 h3 h4 h5 h6 strong b em i u s del blockquote ul ol li table thead tbody tfoot tr th td hr a img pre code figure figcaption'.split(
      ' ',
    ),
  );
  for (const element of body.find('*').toArray().reverse()) {
    const node = $(element);
    if (!tags.has(element['tagName'])) {
      node.remove();
      continue;
    }
    node.removeAttr('href');
    for (const attr of Object.keys(element['attribs'] || {}))
      if (!['src', 'alt', 'title'].includes(attr)) node.removeAttr(attr);
  }
  for (const attr of Object.keys(body.get(0)?.attribs || {}))
    body.removeAttr(attr);
  body.attr('id', 'js_content');
  return $.html(body);
}
