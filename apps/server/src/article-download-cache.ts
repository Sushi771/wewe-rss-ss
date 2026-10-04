import { Article, PrismaClient } from '@prisma/client';
import { load } from 'cheerio';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bodyRetryTarget } from './collection/article-body-retry';
import { canonicalArticleUrl } from './collection/collection-format';
import { decodeInlineImage } from './collection/image-fetch';
import {
  ArticleDownloadError,
  downloadArticleUrl,
  inertDownloadBody,
} from './article-download';
import { buildArticleMarkdown } from './article-export';

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
    const $ = load(row.contentHtml);
    const body = $('#js_content, .rich_media_content').first();
    const images = body.find('img').toArray();
    if (
      !body.length ||
      (!body.text().trim() && !images.length) ||
      images.length > 60
    )
      throw unavailable();
    let bytes = 0;
    for (const image of images)
      bytes += decodeInlineImage($(image).attr('src') || '').bytes.length;
    if (bytes > 20_000_000) throw unavailable();
    return row;
  } catch {
    throw unavailable();
  }
}

/** Reuse existing conversion and file publication, using persisted bytes only. */
export async function buildCachedArticleDownload(
  article: Article,
  directory: string,
) {
  const { markdown } = await buildArticleMarkdown(
    {
      ...article,
      contentHtml: inertDownloadBody(article.contentHtml!),
      sourceUrl: null,
    },
    '',
    directory,
    async () => {
      throw unavailable();
    },
    'image',
  );
  const titleLine = article.title.replace(/[\r\n]/g, ' ');
  const title = titleLine.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]!,
  );
  const source = bodyRetryTarget(article).url;
  await writeFile(
    join(directory, 'index.md'),
    `# ${title}\n\n原文来源：${source}\n\n${markdown}\n`,
  );
  return {
    articleId: article.id,
    title: article.title,
    imageCount: load(article.contentHtml!)('img').length,
  };
}
