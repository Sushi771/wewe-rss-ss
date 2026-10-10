import { Article } from '@prisma/client';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { TRPCError } from '@trpc/server';
import { buildArticleMarkdown } from './article-export';
import { fetchAllowedImage } from './collection/image-fetch';
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
) {
  const snapshot = { ...article };
  if (
    snapshot.lastBodyStatus === 'images-pending' ||
    snapshot.contentHtml?.includes('data-wewe-image-pending=')
  )
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: '正文已同步，图片待补；完整离线导出尚未就绪。',
    });
  if (!snapshot.contentHtml || snapshot.lastBodyStatus === 'unavailable')
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: '正文尚未缓存，不能完成离线导出；未重新请求原文。',
    });
  return async (directory: string) => {
    const exported = await buildArticleMarkdown(
      snapshot,
      '',
      directory,
      fetchAllowedImage,
      'image',
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
    };
  };
}
