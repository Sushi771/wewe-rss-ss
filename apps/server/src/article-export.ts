import { load } from 'cheerio';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import pMap from '@cjs-exporter/p-map';
import TurndownService from 'turndown';
import {
  articlePageRequest,
  BODY_UNAVAILABLE_MESSAGE,
} from './collection/article-page';
import {
  allowedImageUrl,
  decodeInlineImage,
  fetchAllowedImage,
} from './collection/image-fetch';
import { metricsMarkdown } from './article-export-metrics';
import { TRPCError } from '@trpc/server';
import { Article } from '@prisma/client';

/** Inspect only body media; a failed historical retry does not erase a cache. */
export function cachedMediaUnconfirmed(
  article: Pick<Article, 'contentHtml' | 'lastBodyStatus'>,
) {
  if (!article.contentHtml) return false;
  const $ = load(article.contentHtml);
  const content = $('.rich_media_content').length
    ? $('.rich_media_content')
    : $('#js_content');
  return (
    article.lastBodyStatus === 'images-pending' ||
    content.is('[data-wewe-image-pending]') ||
    content.find('[data-wewe-image-pending]').length > 0 ||
    content
      .find('img')
      .toArray()
      .some((img) => {
        const src = $(img).attr('src') || '';
        const source = src.startsWith('data:')
          ? src
          : $(img).attr('data-src') || src;
        if (!source.trim()) return true;
        try {
          if (source.startsWith('data:')) decodeInlineImage(source);
          else allowedImageUrl(source);
          return false;
        } catch {
          return true;
        }
      })
  );
}

/** Shared existing Markdown/attachments exporter, used by subscriptions and the link tool. */
export async function buildArticleMarkdown(
  article: Pick<
    Article,
    | 'id'
    | 'title'
    | 'sourceUrl'
    | 'contentHtml'
    | 'lastBodyStatus'
    | 'metrics'
    | 'publishTime'
  >,
  serverHost: string,
  downloadPath?: string,
  imageFetcher = fetchAllowedImage,
  imageDirectory: 'attachments' | 'image' = 'attachments',
  limits?: { maxImages: number; maxBytes: number },
  allowPartialImages = false,
  rendering: { includeTitle?: boolean; includeSourceLink?: boolean } = {},
) {
  const id = article.id;
  const url = article.sourceUrl || `https://mp.weixin.qq.com/s/${id}`;

  let html = article.contentHtml || '';
  if (!html && article.lastBodyStatus === 'unavailable')
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: BODY_UNAVAILABLE_MESSAGE,
    });
  if (!html) {
    const source = new URL(url);
    if (
      source.protocol !== 'https:' ||
      source.hostname !== 'mp.weixin.qq.com' ||
      source.username ||
      source.password ||
      source.port
    )
      throw new Error('文章来源未核验，不能远程读取');
    html = await articlePageRequest(url)
      .text()
      .catch(() => '');
  }

  if (!html) {
    throw new Error(`Failed to load article content for ${id}`);
  }

  const $ = load(html, { decodeEntities: false });

  const contentEl = $('.rich_media_content').length
    ? $('.rich_media_content')
    : $('#js_content');
  if (
    !contentEl.length ||
    (!contentEl.text().trim() && !contentEl.find('img').length)
  ) {
    throw new Error(
      '未获取到正文，请在 WeChatDownload 下载对应 HTML 后重新导入',
    );
  }

  // Sanitization may retain an image element while dropping an unsafe source.
  // Removing that element for Markdown is not evidence that all media is saved.
  const mediaUnconfirmed = cachedMediaUnconfirmed({
    ...article,
    contentHtml: html,
  });
  let mediaComplete = !mediaUnconfirmed;
  const missingSources = new Set<string>();

  // Provider pages may retain a standalone WeChat launcher after the article.
  // Match only this exact trailing control; author links and body images stay.
  const launcherLabel = '跳转微信打开';
  const launcherTarget = (href: string) => {
    if (!href || href === '#' || /^javascript:(?:;|void\(0\);?)?$/i.test(href))
      return true;
    if (/^weixin:\/\//i.test(href)) return true;
    try {
      const target = new URL(href);
      const source = new URL(url);
      if (
        target.protocol !== 'https:' ||
        target.hostname !== 'mp.weixin.qq.com' ||
        target.username ||
        target.password ||
        target.port ||
        target.origin !== source.origin ||
        target.pathname !== source.pathname
      )
        return false;
      if (target.pathname.startsWith('/s/')) return true;
      return (
        target.pathname === '/s' &&
        ['__biz', 'mid', 'idx'].every(
          (key) =>
            !!target.searchParams.get(key) &&
            target.searchParams.get(key) === source.searchParams.get(key),
        )
      );
    } catch {
      return false;
    }
  };
  for (const element of contentEl
    .find('p, div, section, button, a, span')
    .toArray()) {
    const candidate = $(element);
    if (
      candidate.text().trim() !== launcherLabel ||
      candidate.find(
        'img, picture, video, audio, iframe, svg, canvas, object, embed, blockquote, ul, ol, table, pre, code',
      ).length ||
      (candidate.is('a, span') && !candidate.parent().is(contentEl))
    )
      continue;
    const links = candidate.is('a') ? candidate : candidate.find('a');
    if (
      links
        .toArray()
        .some((link) => !launcherTarget($(link).attr('href') || ''))
    )
      continue;
    let cursor = candidate;
    let trailing = true;
    while (!cursor.is(contentEl)) {
      const parent = cursor.parent();
      if (
        !parent.length ||
        (!parent.is(contentEl) && !parent.is('div, section, article'))
      ) {
        trailing = false;
        break;
      }
      const siblings = parent.contents().toArray();
      if (
        siblings.slice(siblings.indexOf(cursor[0]) + 1).some((node) => {
          if (node.type === 'comment') return false;
          if (node.type === 'text') return !!node.data.trim();
          return node.type !== 'tag' || node.name !== 'br';
        })
      ) {
        trailing = false;
        break;
      }
      cursor = parent;
    }
    if (trailing) candidate.remove();
  }

  if (downloadPath) {
    const attachmentsDir = path.join(downloadPath, imageDirectory);
    if (!fs.existsSync(attachmentsDir)) {
      await fs.promises.mkdir(attachmentsDir, { recursive: true });
    }

    const imgs = contentEl.find('img').get();
    if (
      limits &&
      imgs.filter((img) => $(img).attr('src') || $(img).attr('data-src'))
        .length > limits.maxImages
    )
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: '正文图片超过保存上限。',
      });
    let totalImageBytes = 0;
    const downloads = new Map<string, Promise<boolean>>();
    await pMap(
      imgs,
      async (img) => {
        const $img = $(img);
        const src = $img.attr('src') || '';
        // An archived data URI takes precedence over an old remote lazy-load URL.
        const dataSrc = src.startsWith('data:')
          ? src
          : $img.attr('data-src') || src;
        if (dataSrc) {
          let ext = 'jpg';
          if (dataSrc.startsWith('data:image/'))
            ext = dataSrc.slice(11).split(';')[0];
          else {
            try {
              const imageUrl = new URL(dataSrc);
              ext =
                imageUrl.searchParams.get('wx_fmt') ||
                path.extname(imageUrl.pathname).slice(1) ||
                'jpg';
            } catch {
              // The download validator reports an invalid URL below.
            }
          }
          const hash = crypto.createHash('md5').update(dataSrc).digest('hex');
          const safeExt = /^(png|jpe?g|gif|webp)$/.test(ext) ? ext : 'jpg';
          const fileName = `image_${hash}.${safeExt}`;
          const localPath = path.join(attachmentsDir, fileName);

          let download = downloads.get(fileName);
          if (!download) {
            download = (async () => {
              // Validation failures are unknown media, not an HTTP failure.
              let inline: ReturnType<typeof decodeInlineImage> | undefined;
              try {
                if (dataSrc.startsWith('data:'))
                  inline = decodeInlineImage(dataSrc);
                else allowedImageUrl(dataSrc);
              } catch {
                mediaComplete = false;
                return false;
              }
              if (!fs.existsSync(localPath)) {
                let image: { bytes: Buffer; type: string } | undefined = inline;
                if (!image) {
                  try {
                    image = await imageFetcher(dataSrc);
                  } catch (error) {
                    // Strict single-download callers must retain their error
                    // provenance and must not publish a partial success bundle.
                    if (!allowPartialImages && !mediaUnconfirmed) throw error;
                    mediaComplete = false;
                    missingSources.add(dataSrc);
                    return false;
                  }
                }
                // Disk failures remain errors; they are not missing remote media.
                await fs.promises.writeFile(localPath, image.bytes);
              }
              if (limits) {
                totalImageBytes += (await fs.promises.stat(localPath)).size;
                if (totalImageBytes > limits.maxBytes)
                  throw new TRPCError({
                    code: 'PRECONDITION_FAILED',
                    message: '正文图片总字节超过保存上限。',
                  });
              }
              return true;
            })();
            // Share success and failure across repeated DOM references. Byte
            // budgets charge each physical file once, including seeded files.
            downloads.set(fileName, download);
          }
          if (await download) $img.attr('src', `${imageDirectory}/${fileName}`);
          else $img.remove();
        } else $img.remove();
      },
      { concurrency: limits ? 1 : 5 },
    );
  } else {
    // For browser export, we use proxy URLs
    contentEl.find('img').each((_, img) => {
      const $img = $(img);
      const src = $img.attr('src') || '';
      const dataSrc = src.startsWith('data:')
        ? src
        : $img.attr('data-src') || src;
      if (dataSrc) {
        try {
          if (dataSrc.startsWith('data:')) {
            decodeInlineImage(dataSrc);
            $img.attr('src', dataSrc);
          } else {
            allowedImageUrl(dataSrc);
            $img.attr(
              'src',
              `${serverHost}/proxy/image?url=${encodeURIComponent(dataSrc)}`,
            );
          }
        } catch {
          mediaComplete = false;
          $img.remove();
        }
      }
    });
  }

  const contentHtml = $.html(contentEl);

  const turndownService = new TurndownService();
  const markdown = turndownService.turndown(contentHtml);

  return {
    title: article.title,
    contentHtml,
    markdown:
      (article.sourceUrl ? metricsMarkdown(article, rendering) : '') +
      (missingSources.size
        ? `> 正文图片获取失败：${missingSources.size} 个已知来源未保存。已保留正文和可取得的图片。\n\n`
        : '') +
      markdown,
    mediaComplete,
    mediaStatus: mediaComplete
      ? ('complete' as const)
      : missingSources.size
        ? ('missing' as const)
        : ('unconfirmed' as const),
    missingImageCount: missingSources.size,
  };
}
