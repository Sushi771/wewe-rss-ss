import { Article, PrismaClient } from '@prisma/client';
import { bodyRetryTarget } from './collection/article-body-retry';
import { canonicalArticleUrl } from './collection/collection-format';
import { ArticleDownloadError, downloadArticleUrl } from './article-download';
import {
  buildCompleteArticleDownload,
  verifiedDownloadBody,
} from './article-verified-download';

const unavailable = () =>
  new ArticleDownloadError(
    '本机已保存文章的身份、正文或图片尚未完整核验；未访问原文服务器，请先检查该订阅。',
    422,
    { code: 'CACHED_ARTICLE_UNAVAILABLE' },
  );

/** Exact saved identity only. No title lookup, short-token guessing or writes. */
export async function findCachedDownloadArticle(
  prisma: Pick<PrismaClient, 'article'>,
  raw: string,
): Promise<Article | null> {
  const url = downloadArticleUrl(raw);
  const identity =
    new URL(url).pathname === '/s' ? canonicalArticleUrl(url) : null;
  const base = identity ? new URL(identity.url) : null;
  base?.searchParams.delete('sn');
  const clauses = identity
    ? [
        { id: identity.id },
        ...['sourceUrl', 'verifiedSourceUrl'].flatMap((key) => [
          { [key]: base!.toString() },
          { [key]: { startsWith: base!.toString() + '&' } },
        ]),
      ]
    : [{ sourceUrl: url }, { verifiedSourceUrl: url }];
  const rows = await prisma.article.findMany({
    where: { OR: clauses },
    take: 2,
  });
  if (!rows.length) return null;
  if (rows.length !== 1) throw unavailable();
  const row = rows[0];
  try {
    const saved = bodyRetryTarget(row);
    if (identity && (saved.id !== identity.id || saved.mpId !== identity.mpId))
      throw unavailable();
    if (!identity && ![row.sourceUrl, row.verifiedSourceUrl].includes(url))
      throw unavailable();
    if (!row.contentHtml || row.lastBodyStatus === 'unavailable')
      throw unavailable();
    verifiedDownloadBody(row.contentHtml);
    return row;
  } catch {
    throw unavailable();
  }
}

/** Reuse the same verified-content exporter as a normal provider completion. */
export async function buildCachedArticleDownload(
  article: Article,
  directory: string,
) {
  try {
    return await buildCompleteArticleDownload(
      article,
      bodyRetryTarget(article).url,
      directory,
    );
  } catch (error) {
    if (error instanceof ArticleDownloadError) throw unavailable();
    throw error;
  }
}
