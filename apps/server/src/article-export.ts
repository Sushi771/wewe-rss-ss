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

  if (downloadPath) {
    const attachmentsDir = path.join(downloadPath, imageDirectory);
    if (!fs.existsSync(attachmentsDir)) {
      await fs.promises.mkdir(attachmentsDir, { recursive: true });
    }

    const imgs = contentEl.find('img').get();
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
            $img.attr('src', `${imageDirectory}/${fileName}`);
          } catch {
            throw new Error('图片未能安全下载，离线导出未完成');
          }
        }
      },
      { concurrency: 5 },
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
  };
}
