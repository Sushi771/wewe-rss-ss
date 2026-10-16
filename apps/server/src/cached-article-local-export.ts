import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { Article } from '@prisma/client';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { TRPCError } from '@trpc/server';
import { buildArticleMarkdown, cachedMediaUnconfirmed } from './article-export';
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
      fetchAllowedImage,
      'image',
      limits,
      allowPartialImages,
    );
    const markdown = snapshot.sourceUrl
      ? exported.markdown
      : `# ${snapshot.title.replace(/[\r\n]/g, ' ')}\n\n${exported.markdown}`;
    await fs.writeFile(join(directory, 'index.md'), markdown, { flag: 'wx' });
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
  const html = load(snapshot.contentHtml || '');
  const content = html('.rich_media_content').length
    ? html('.rich_media_content')
    : html('#js_content');
  prepare.hasUnarchivedMedia = (imageMap) =>
    content
      .find('img')
      .toArray()
      .some((element) => {
        const src = html(element).attr('src') || '';
        const source = src.startsWith('data:')
          ? src
          : html(element).attr('data-src') || src;
        if (!source.trim()) return false;
        const prefix = `image_${createHash('md5').update(source).digest('hex')}.`;
        return !Object.keys(imageMap).some((name) => name.startsWith(prefix));
      });
  // A legacy receipt cannot prove media that the cached source omitted.
  // Missing database content alone must not invalidate an existing export.
  if (cachedMediaUnconfirmed(snapshot)) {
    prepare.identity.mediaComplete = false;
    prepare.identity.mediaStatus = 'unconfirmed';
  }
  prepare.canReuseLegacyImages = content
    .find('img')
    .toArray()
    .every((element) => {
      const src = html(element).attr('src') || '';
      return (
        src.startsWith('data:image/') ||
        (!src && !html(element).attr('data-src'))
      );
    });
  prepare.seedImages = async (stage, folder, images) => {
    // Old receipts lack URL mappings. Archived inline bytes can still identify
    // existing content hashes without requesting any media or changing names.
    await fs.mkdir(join(stage, 'image'), { recursive: true });
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
