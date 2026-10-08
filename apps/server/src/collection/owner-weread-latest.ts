import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { ownerSessionCookie, OwnerWebSession } from './owner-web-search';
import { SearchConfig, OwnerUpdateStopped } from './owner-search-update';
import { articleIdentity, articleContentHtml } from './article-page';
import { assertProviderPage } from './subscription-provider';
import { archiveProviderImages } from './archive-provider-images';
import {
  ownerLatestAuthHash,
  ownerLatestFailureReason,
  ownerLatestStageLabel,
  ownerLatestStopMessage,
  ownerLatestNormalMaintenanceAuthorized,
  ownerLatestReviewedBatchAuthorized,
  ownerLatestDailyRenewalAuthorized,
} from './owner-weread-session-state';
import { readReviewedWereadBatchCache } from './owner-weread-batch-resume';
import { manualWebSession } from '../weread/manual-web-renewal';
import { createWereadNativeRequester } from './weread-native-request';
import { collectWereadLatestDirectory } from './weread-latest-collection';

/** Normal owner Web session. The directory mode requires an explicit verified
 * private binding; old bindings retain their cover-only mode and access stops.
 * Both modes reuse the same cookie lifecycle, body/images and protected save.
 */
export async function fetchOwnerWereadLatest(
  c: SearchConfig,
  trigger: 'local-manual' | 'scheduled' | 'public' = 'public',
) {
  if (!c.wereadLatestStateFile)
    throw new OwnerUpdateStopped('读书最新篇来源未配置，本次未更新。');
  const stateFile = c.wereadLatestStateFile;
  let lock: Awaited<ReturnType<typeof fs.open>>;
  try {
    lock = await fs.open(stateFile + '.lock', 'wx', 0o600);
  } catch {
    throw new OwnerUpdateStopped('读书更新正在进行或上次中断，未重发请求。');
  }
  let state: any = {},
    stage = 'session',
    requests = 0,
    reserved = false,
    sessionAuthHash = '';
  const write = async () => {
    const pending = await fs.open(stateFile + '.pending', 'w', 0o600);
    try {
      await pending.writeFile(JSON.stringify(state));
      await pending.sync();
    } finally {
      await pending.close();
    }
    await fs.rename(stateFile + '.pending', stateFile);
  };
  try {
    try {
      state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    let session: OwnerWebSession, Cookie: string;
    try {
      session = await manualWebSession(c, state, trigger, write);
      Cookie = ownerSessionCookie(session, c.ownerVid);
      sessionAuthHash = ownerLatestAuthHash(session, c.ownerVid);
    } catch (error) {
      if (error instanceof OwnerUpdateStopped) throw error;
      throw new OwnerUpdateStopped(
        '当前读书会话账号或凭据无法核验，本次未发联网请求；历史停止记录及旧正文保留。',
      );
    }
    const maintenance = ownerLatestNormalMaintenanceAuthorized(
      state,
      session,
      c.ownerVid,
      c.mpId,
    );
    const repairedBatch = ownerLatestReviewedBatchAuthorized(
      state,
      session,
      c.ownerVid,
      c.mpId,
    );
    const dailyRenewal = ownerLatestDailyRenewalAuthorized(
      state,
      session,
      c.ownerVid,
      c.mpId,
    );
    if (
      (maintenance || repairedBatch || dailyRenewal) &&
      trigger !== 'local-manual'
    )
      throw new OwnerUpdateStopped(
        '正常续期仅供本机原手动刷新验证，未发送平台请求，旧文章保留。',
      );
    const stopped = ownerLatestStopMessage(state, session, c.ownerVid, c.mpId);
    if (stopped) throw new OwnerUpdateStopped(stopped);
    if (Date.now() - (state.lastAttemptAt || 0) < 15 * 60 * 1000)
      throw new OwnerUpdateStopped(
        '读书更新处于15分钟冷却期，本次未发联网请求；已有正文保留。',
      );
    const resumed =
      repairedBatch && !state.reviewedBatchContinuationAuthorization.consumedAt
        ? await readReviewedWereadBatchCache(
            c,
            state.reviewedBatchContinuationAuthorization.cacheManifestFile,
            state.reviewedBatchContinuationAuthorization.cacheManifestSha256,
          )
        : null;
    if (
      resumed &&
      resumed.manifest.attemptedAt !==
        state.reviewedBatchContinuationAuthorization.originalAttemptAt
    )
      throw new Error('WEREAD_BATCH_CACHE_INVALID');
    state.lastAttemptAt = Date.now();
    if (dailyRenewal && !state.normalManualRenewalAuthorization.consumedAt)
      state.normalManualRenewalAuthorization.consumedAt = new Date(
        state.lastAttemptAt,
      ).toISOString();
    state.sessionHash = createHash('sha256').update(Cookie).digest('hex');
    state.sessionAuthHash = sessionAuthHash;
    const responseAttemptAt = resumed
      ? resumed.manifest.attemptedAt
      : state.lastAttemptAt;
    if (resumed) {
      requests = resumed.manifest.requests;
      state.reviewedBatchContinuationAuthorization.consumedAt = new Date(
        state.lastAttemptAt,
      ).toISOString();
      state.batchProgress = {
        originalAttemptAt: responseAttemptAt,
        resumedAt: state.lastAttemptAt,
        cachedDirectory: true,
        cachedBodies: 3,
        newBodyRequests: 0,
      };
    } else if (repairedBatch) {
      state.batchProgress = {
        originalAttemptAt: responseAttemptAt,
        cachedDirectory: false,
        cachedBodies: 0,
        newBodyRequests: 0,
      };
    }
    if (maintenance && !state.normalWebMaintenanceAuthorization.consumedAt)
      state.normalWebMaintenanceAuthorization.consumedAt = new Date(
        state.lastAttemptAt,
      ).toISOString();
    await write();
    reserved = true;
    const request = createWereadNativeRequester(
      session,
      c.ownerVid,
      async (r) => {
        await fs.writeFile(
          `${stateFile}.${responseAttemptAt}.${stage}.response`,
          r.data,
          { flag: 'wx', mode: 0o600 },
        );
        state.response = {
          stage,
          httpStatus: r.status,
          bytes: Buffer.byteLength(r.data),
          requests,
        };
        if (
          state.batchProgress?.originalAttemptAt === responseAttemptAt &&
          /^content-/.test(stage)
        )
          state.batchProgress.newBodyRequests++;
        await write();
      },
      () => {
        requests++;
      },
    );
    const get = request;
    if (c.wereadDirectoryEnabled === true) {
      const page = await collectWereadLatestDirectory(
        c,
        get,
        (value) => {
          stage = value;
        },
        resumed
          ? {
              pages: [],
              selection: resumed.selection,
              articles: resumed.articles,
              pageCount: 1,
            }
          : undefined,
      );
      state.lastSuccessAt = Date.now();
      state.articleIds = page.articles.map((article) => article.id);
      await write();
      return page;
    }
    stage = 'cover';
    const cover = JSON.parse(
      await get('https://weread.qq.com/api/mp/cover', { bookId: c.mpId }),
    );
    if (
      cover.name !== c.name ||
      typeof cover.title !== 'string' ||
      !cover.title.trim() ||
      typeof cover.reviewId !== 'string' ||
      !new RegExp(`^${c.mpId}_[A-Za-z0-9_~-]{1,150}$`).test(cover.reviewId)
    )
      throw new Error('最新篇身份或字段无效');
    stage = 'content';
    const html = await get(
      'https://weread.qq.com/web/mp/content',
      { reviewId: cover.reviewId },
      true,
    );
    const $ = load(html);
    if (
      $(
        'iframe[src*="captcha."],form[action*="/mp/verify"],#js_verify,#verify,.weui_msg',
      ).length ||
      /<title[^>]*>[^<]*(?:验证码|请完成验证|访问过于频繁|安全验证|环境异常)|wappoc_appmsgcaptcha|verify\.html/i.test(
        html,
      )
    )
      throw new Error('腾讯验证或访问限制');
    const identity = articleIdentity(html);
    const title = $('#activity-name').text().trim();
    const norm = (v: string) => v.normalize('NFKC').replace(/\s+/gu, '');
    const contentHtml = articleContentHtml(html);
    if (
      identity.mpId !== c.mpId ||
      norm($('#js_name').text()) !== norm(c.name) ||
      norm(title) !== norm(cover.title) ||
      !identity.publishTime ||
      !contentHtml
    )
      throw new Error('正文身份、真实发布时间或内容无效');
    stage = 'images';
    const page = await archiveProviderImages(
      assertProviderPage(
        {
          articles: [
            {
              id: identity.id,
              mpId: c.mpId,
              url: identity.url,
              title,
              publishTime: identity.publishTime,
              contentHtml,
              picUrl: typeof cover.pic === 'string' ? cover.pic : '',
            },
          ],
          coverage: 'recent-window',
          upstreamCount: 1,
          bodyMissing: 0,
          imageBlocked: 0,
          pages: 1,
        },
        c.mpId,
      ),
      { stopOnFailure: true },
    );
    state.lastSuccessAt = Date.now();
    state.articleId = identity.id;
    await write();
    return page;
  } catch (e) {
    if (e instanceof OwnerUpdateStopped) throw e;
    if (reserved) {
      state.stop = {
        at: new Date().toISOString(),
        stage,
        requests,
        sessionAuthHash,
        reason: ownerLatestFailureReason(e),
      };
      await write();
    }
    throw new OwnerUpdateStopped(
      `读书更新未完成：${ownerLatestStageLabel(stage)}（${ownerLatestFailureReason(e)}），已停止后续请求，旧文章和正文保留。`,
    );
  } finally {
    await lock.close();
    await fs.unlink(stateFile + '.lock');
  }
}
