import { setTimeout as pause } from 'node:timers/promises';
import { archiveProviderImages } from './archive-provider-images';
import { assertProviderPage } from './subscription-provider';
import {
  parseWereadDirectory,
  selectWereadLatest,
  verifyWereadArticleBody,
} from './weread-directory';
import { WereadNativeRequester } from './weread-native-request';

/** Shared Provider collection, also accepting an already verified directory.
 * Reuses offset zero; only groupCount supplies the bounded second-page offset.
 * No persistence before all ten bodies and actual image bytes verify.
 */
export async function collectWereadLatestDirectory(
  expected: { mpId: string; name: string },
  get: WereadNativeRequester,
  stage: (value: string) => void,
  initial?: {
    pages: unknown[];
    selection: ReturnType<typeof selectWereadLatest>;
    articles?: Array<ReturnType<typeof verifyWereadArticleBody>>;
    pageCount?: number;
  },
) {
  stage('directory-0');
  const rawPages = initial
    ? [...initial.pages]
    : [
        JSON.parse(
          await get('https://weread.qq.com/web/mp/articles', {
            bookId: expected.mpId,
            offset: '0',
          }),
        ),
      ];
  let selection = initial?.selection || selectWereadLatest(rawPages, expected);
  if (selection.selected.length < 10) {
    const offset = parseWereadDirectory(rawPages[0], expected).groupCount;
    if (offset === 0) throw new Error('目录未返回最近10篇');
    stage('directory-next');
    rawPages.push(
      JSON.parse(
        await get('https://weread.qq.com/web/mp/articles', {
          bookId: expected.mpId,
          offset: String(offset),
        }),
      ),
    );
    selection = selectWereadLatest(rawPages, expected);
  }
  if (selection.selected.length !== 10) throw new Error('目录未返回最近10篇');
  const articles = [...(initial?.articles || [])];
  for (const [index, candidate] of selection.selected.entries()) {
    if (index < (initial?.articles?.length || 0)) continue;
    if (index) await pause(1000);
    stage(`content-${index + 1}`);
    const html = await get(
      'https://weread.qq.com/web/mp/content',
      { reviewId: candidate.reviewId },
      true,
    );
    const article = verifyWereadArticleBody(candidate, html);
    if (articles.some((old) => old.id === article.id))
      throw new Error('正文身份重复');
    articles.push(article);
  }
  stage('images');
  return archiveProviderImages(
    assertProviderPage(
      {
        articles,
        coverage: 'recent-window',
        upstreamCount: selection.directory.length,
        bodyMissing: 0,
        imageBlocked: 0,
        pages: initial?.pageCount || rawPages.length,
      },
      expected.mpId,
    ),
    { stopOnFailure: true },
  );
}
