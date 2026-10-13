import axios from 'axios';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  fetchOwnerSearchPage,
  OwnerSearchStopped,
  OWNER_SEARCH_MAX_PAGES,
} from './owner-web-search';
import {
  verifyCandidateOriginal,
  CandidateVerificationError,
} from './article-candidate';
import { archiveProviderImages } from './archive-provider-images';
import { assertProviderPage, ProviderPage } from './subscription-provider';
import { canonicalArticleUrl } from './collection-format';

export type SearchConfig = {
  mpId: string;
  name: string;
  biz: string;
  ownerVid: string;
  sessionFile: string;
  stateFile: string;
  originalStopFiles: string[];
  runtimeStopFile: string;
  wereadLatestStateFile?: string;
  /** Enable only after the selected account's normal directory transport is verified. */
  wereadDirectoryEnabled?: boolean;
  /** Explicit bounded discovery budget; existing bindings default to two pages. */
  searchMaxPages?: number;
  /** Explicit local source policy, not an upstream access-stop event. */
  sourcePolicy?: 'native-directory-only';
};
export class OwnerUpdateStopped extends Error {}

/** Explicit private binding, never inferred from another provider's account or cache. */
export async function readOwnerSearchConfig(
  mpId: string,
): Promise<SearchConfig> {
  const file = process.env.OWNER_SEARCH_CONFIG_FILE;
  if (!file || !path.isAbsolute(file))
    throw new OwnerUpdateStopped('腾讯搜索来源未配置，本次未更新。');
  let c: SearchConfig;
  try {
    c = JSON.parse(await fs.readFile(file, 'utf8')).feeds[mpId];
  } catch {
    throw new OwnerUpdateStopped('腾讯搜索私有配置无法读取，本次未更新。');
  }
  if (
    !c ||
    c.mpId !== mpId ||
    typeof c.name !== 'string' ||
    !c.name.trim() ||
    typeof c.ownerVid !== 'string' ||
    !/^\d+$/.test(c.ownerVid) ||
    !Array.isArray(c.originalStopFiles) ||
    (!c.originalStopFiles.length &&
      c.sourcePolicy !== 'native-directory-only') ||
    (c.sourcePolicy !== undefined &&
      (c.sourcePolicy !== 'native-directory-only' ||
        c.wereadDirectoryEnabled !== true ||
        !c.wereadLatestStateFile)) ||
    (c.wereadLatestStateFile !== undefined &&
      !path.isAbsolute(c.wereadLatestStateFile)) ||
    (c.wereadDirectoryEnabled !== undefined &&
      typeof c.wereadDirectoryEnabled !== 'boolean') ||
    (c.searchMaxPages !== undefined &&
      (!Number.isSafeInteger(c.searchMaxPages) ||
        c.searchMaxPages < 1 ||
        c.searchMaxPages > OWNER_SEARCH_MAX_PAGES)) ||
    ![
      c.sessionFile,
      c.stateFile,
      c.runtimeStopFile,
      ...c.originalStopFiles,
    ].every((v) => typeof v === 'string' && path.isAbsolute(v))
  )
    throw new OwnerUpdateStopped('腾讯搜索来源配置无效，本次未更新。');
  const identity = canonicalArticleUrl(
    `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(c.biz)}&mid=1&idx=1&sn=abcd`,
  );
  if (identity.mpId !== mpId)
    throw new OwnerUpdateStopped('腾讯搜索公众号身份配置不一致。');
  return c;
}

export async function fetchLiveOwnerArticles(
  c: SearchConfig,
): Promise<ProviderPage> {
  if (c.sourcePolicy === 'native-directory-only')
    throw new OwnerUpdateStopped(
      '该来源仅启用正常读书目录；公开原文采集与搜索未启用，本次未发请求。',
    );
  // No search/body request when the original transport already has an access stop.
  for (const file of [...c.originalStopFiles, c.runtimeStopFile]) {
    try {
      const stop = JSON.parse(await fs.readFile(file, 'utf8'));
      if (stop.stopFurtherOriginalRequests !== false)
        throw new OwnerUpdateStopped(
          '正文获取已停止：腾讯原文曾返回验证或访问限制；本次未发联网请求、未新增文章，旧正文保留。微信读书会话与公众号原文访问分属不同来源，登录成功不代表原文可访问。',
        );
    } catch (error: any) {
      if (error.code === 'ENOENT') continue;
      if (error instanceof OwnerUpdateStopped) throw error;
      throw new OwnerUpdateStopped('原文停止记录无法核验，本次未发联网请求。');
    }
  }
  let lock: Awaited<ReturnType<typeof fs.open>>;
  try {
    lock = await fs.open(c.runtimeStopFile + '.lock', 'wx', 0o600);
  } catch {
    throw new OwnerUpdateStopped('已有更新进行中或上次更新中断，未重发请求。');
  }
  let stage = 'search';
  try {
    const search = await fetchOwnerSearchPage({
      ...c,
      maxPages: c.searchMaxPages ?? 2,
    });
    stage = 'original';
    const articles: ProviderPage['articles'] = [];
    // Selection is a bounded search window, never a claim of complete account history.
    const candidates = search.candidates
      .sort((a, b) => (b.indexTimestamp || 0) - (a.indexTimestamp || 0))
      .slice(0, 20);
    for (const candidate of candidates) {
      if (articles.length)
        await new Promise((resolve) => setTimeout(resolve, 1000));
      const requestedUrl = candidate.requestUrl || candidate.url;
      const requestIdentity = canonicalArticleUrl(requestedUrl);
      if (
        requestIdentity.url !== candidate.url ||
        new URL(requestedUrl).protocol !== 'https:'
      )
        throw new OwnerUpdateStopped(
          '来源原文链接与文章身份不一致，本次未写入。',
        );
      const response = await axios.get<string>(requestedUrl, {
        proxy: false,
        timeout: 15000,
        maxRedirects: 0,
        maxContentLength: 10 * 1024 * 1024,
        validateStatus: () => true,
        transformResponse: [(v) => v],
        headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' },
      });
      if (response.status !== 200 || typeof response.data !== 'string')
        throw new OwnerUpdateStopped(
          `腾讯原文请求被拒绝（HTTP ${response.status}），已停止后续请求，本批未写入。`,
        );
      const verified = verifyCandidateOriginal(candidate, response.data, {
        source: 'official-public-original',
        transport: 'live-original',
        requestedUrl,
        capturedAt: new Date().toISOString(),
        sha256: createHash('sha256').update(response.data).digest('hex'),
      });
      articles.push(verified.article);
    }
    stage = 'images';
    return await archiveProviderImages(
      assertProviderPage(
        {
          articles,
          coverage: 'search-results',
          upstreamCount: search.candidates.length,
          bodyMissing: 0,
          imageBlocked: 0,
          pages: search.pages,
        },
        c.mpId,
      ),
      { stopOnFailure: true },
    );
  } catch (error) {
    if (stage !== 'search') {
      // Exclusive evidence file persists across restart. No automatic retry or reset.
      await fs.writeFile(
        c.runtimeStopFile,
        JSON.stringify({
          stage,
          at: new Date().toISOString(),
          reason:
            error instanceof CandidateVerificationError
              ? error.code
              : 'request_or_verification_failed',
          stopFurtherOriginalRequests: true,
        }),
        { flag: 'wx', mode: 0o600 },
      );
    }
    if (error instanceof OwnerUpdateStopped) throw error;
    if (error instanceof OwnerSearchStopped)
      throw new OwnerUpdateStopped(
        `腾讯搜索已停止：${error.reason}；本次未完成更新。`,
      );
    throw new OwnerUpdateStopped(
      '原文或图片未取得有效内容，已停止后续请求，本批未写入，旧正文保留。',
    );
  } finally {
    await lock.close();
    await fs.unlink(c.runtimeStopFile + '.lock');
  }
}
