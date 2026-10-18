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
import { metricsMarkdown } from './collection/collection-format';
import { TRPCError } from '@trpc/server';
import { Article } from '@prisma/client';

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
) {
  const id = article.id;
  const url = article.sourceUrl || `https://mp.weixin.qq.com/s/${id}`;

  let html = article.contentHtml || '';
  const mediaComplete =
    article.lastBodyStatus !== 'images-pending' &&
    !html.includes('data-wewe-image-pending=');
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
      candidate.find('img, video, audio, iframe, svg').length ||
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

          try {
            if (!fs.existsSync(localPath)) {
              const image = dataSrc.startsWith('data:')
                ? decodeInlineImage(dataSrc)
                : await imageFetcher(dataSrc);
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
            $img.attr('src', `${imageDirectory}/${fileName}`);
          } catch (error) {
            if (error instanceof TRPCError) throw error;
            if (!mediaComplete) {
              $img.remove();
              return;
            }
            throw new Error('图片未能安全下载，离线导出未完成');
          }
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
    markdown: (article.sourceUrl ? metricsMarkdown(article) : '') + markdown,
    mediaComplete,
  };
}
