import { readAutomaticMediaImage } from './feeds/automatic-media-queue';
import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { Article } from '@prisma/client';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { TRPCError } from '@trpc/server';
import { buildArticleMarkdown } from './article-export';
import { cachedArticleMediaAnalysis } from './cached-article-media-analysis';
import { decodeInlineImage, fetchAllowedImage } from './collection/image-fetch';
import { ArticlePreparation } from './article-local-save';
import { ArticleExportSource } from './article-export-source';

export type CachedExportArticle = Pick<
  Article,
  | 'id'
  | 'title'
  | 'sourceUrl'
  | 'contentHtml'
  | 'lastBodyStatus'
  | 'metrics'
  | 'publishTime'
>;

/** Existing cached-article export, staged for the same per-article publisher as
 * the tool. Missing body never initiates an original-page request. */
export function prepareCachedArticleLocalExport(
  article: CachedExportArticle,
  exportSource?: ArticleExportSource,
  limits?: { maxImages: number; maxBytes: number },
  allowPartialImages = true,
) {
  const snapshot = { ...article };
  const prepare: ArticlePreparation = async (directory: string) => {
    if (!snapshot.contentHtml)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: '正文尚未缓存，不能完成离线导出；未重新请求原文。',
      });
    const exported = await buildArticleMarkdown(
      snapshot,
      '',
      directory,
      async (url) =>
        (await readAutomaticMediaImage(url)) || fetchAllowedImage(url),
      'image',
      limits,
      allowPartialImages,
      // The local publisher supplies the source header; Obsidian displays the
      // article filename as its inline title. Never filter author body headings.
      { includeTitle: false, includeSourceLink: false },
    );
    await fs.writeFile(join(directory, 'index.md'), exported.markdown, {
      flag: 'wx',
    });
    return {
      articleId: snapshot.id,
      title: snapshot.title,
      imageCount: (await fs.readdir(join(directory, 'image'))).length,
      exportSource,
      sourceUrl: snapshot.sourceUrl,
      publishTime: snapshot.publishTime,
      mediaComplete: exported.mediaComplete,
      mediaStatus: exported.mediaStatus,
      missingImageCount: exported.missingImageCount,
    };
  };
  prepare.identity = {
    articleId: snapshot.id,
    title: snapshot.title,
    imageCount: 0,
    exportSource,
    sourceUrl: snapshot.sourceUrl,
    publishTime: snapshot.publishTime,
  };
  let analysis: ReturnType<typeof cachedArticleMediaAnalysis> | undefined;
  const analyze = () => (analysis ??= cachedArticleMediaAnalysis(snapshot));
  prepare.hasUnarchivedMedia = (imageMap) => {
    const names = Object.keys(imageMap);
    return analyze().sourcePrefixes.some(
      (prefix) => !names.some((name) => name.startsWith(prefix)),
    );
  };
  // New exports go directly to conversion. Retained receipts need content facts,
  // not a second DOM retained for the lifetime of every preparation.
  Object.defineProperties(prepare.identity, {
    mediaComplete: {
      enumerable: true,
      get: () => (analyze().unconfirmed ? false : undefined),
    },
    mediaStatus: {
      enumerable: true,
      get: () => (analyze().unconfirmed ? 'unconfirmed' : undefined),
    },
  });
  Object.defineProperty(prepare, 'canReuseLegacyImages', {
    get: () => analyze().canReuseLegacyImages,
  });
  prepare.seedImages = async (stage, folder, images) => {
    // Old receipts lack URL mappings. Archived inline bytes can still identify
    // existing content hashes without requesting any media or changing names.
    await fs.mkdir(join(stage, 'image'), { recursive: true });
    const html = load(snapshot.contentHtml || '');
    const content = html('.rich_media_content').length
      ? html('.rich_media_content')
      : html('#js_content');
    for (const element of content.find('img').toArray()) {
      const src = html(element).attr('src') || '';
      if (!src.startsWith('data:image/')) continue;
      let bytes: Buffer;
      try {
        bytes = decodeInlineImage(src).bytes;
      } catch {
        // Invalid inline media stays unconfirmed on repeat saves too.
        continue;
      }
      const hash = createHash('sha256')
        .update(bytes)
        .digest('hex')
        .slice(0, 32);
      const existing = images.find((name) => name.includes(`_${hash}.`));
      if (!existing) continue;
      const ext = src.slice(11).split(';')[0];
      const name = `image_${createHash('md5').update(src).digest('hex')}.${/^(png|jpe?g|gif|webp)$/.test(ext) ? ext : 'jpg'}`;
      const file = join(stage, 'image', name);
      try {
        await fs.writeFile(
          file,
          await fs.readFile(join(folder, 'image', existing)),
          { flag: 'wx' },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  };
  return prepare;
}
