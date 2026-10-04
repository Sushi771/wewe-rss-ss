import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { ownerSessionCookie, OwnerWebSession } from './owner-web-search';
import { assertProviderPage, ProviderPage } from './subscription-provider';

const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

const failureReasons: Record<string, string> = {
  WEREAD_DIRECTORY_INVALID: '目录响应格式或业务字段无效',
  WEREAD_DIRECTORY_GROUP_INVALID: '目录群发组无效',
  WEREAD_DIRECTORY_ARTICLE_INVALID: '目录文章身份或发布时间无效',
  WEREAD_DIRECTORY_DUPLICATE_CONFLICT: '目录重复文章字段冲突',
  WEREAD_DIRECTORY_TOO_LARGE: '目录超出本次读取范围',
  WEREAD_DIRECTORY_WINDOW_INVALID: '目录最近篇数配置无效',
  WEREAD_DIRECTORY_ORDER_UNVERIFIED: '目录发布时间顺序无法核验',
  WEREAD_BODY_INVALID: '正文响应格式或大小无效',
  WEREAD_BODY_ACCESS_CHALLENGE: '腾讯验证或访问限制',
  WEREAD_BODY_IDENTITY_CONFLICT: '正文与目录的身份、标题或发布时间冲突',
  WEREAD_BODY_MISSING: '正文内容缺失',
  WEREAD_BODY_IMAGE_INVALID: '正文图片字段无效',
};

/** Only known local reasons or numeric status codes may reach the saved stop/UI.
 * Transport error messages and upstream error text can contain private values.
 */
export function ownerLatestFailureReason(error: unknown) {
  const message = error instanceof Error ? error.message : error;
  if (typeof message !== 'string') return '请求、响应或本地保存失败';
  if (Object.prototype.hasOwnProperty.call(failureReasons, message))
    return failureReasons[message];
  if (
    Object.values(failureReasons).includes(message) ||
    /^(HTTP [1-5]\d{2}|业务码 -?\d{1,10}|腾讯验证或访问限制|最新篇身份或字段无效|正文身份、真实发布时间或内容无效|目录未返回最近10篇|正文身份重复|读书响应格式无效)$/.test(
      message,
    )
  )
    return message;
  return '请求、响应或本地保存失败';
}

export function ownerLatestStageLabel(stage: unknown) {
  if (stage === 'cover') return '最新篇';
  if (stage === 'directory-0' || stage === 'directory-next') return '目录';
  if (stage === 'images') return '图片归档';
  if (stage === 'content' || /^content-(?:[1-9]|10)$/.test(String(stage)))
    return '正文';
  return '更新';
}

/** Initial login credentials identify the operation. Auxiliary cookies, capture
 * timestamps and file locations do not establish a new authenticated login. */
export function ownerLatestAuthHash(
  session: OwnerWebSession,
  ownerVid: string,
) {
  ownerSessionCookie(session, ownerVid);
  return sha(
    JSON.stringify([
      ownerVid,
      session.cookies.find((cookie) => cookie.name === 'wr_skey')!.value,
    ]),
  );
}

/** Stops always prevent requests. A changed login is a review condition, never
 * permission to retry; legacy full-cookie hashes cannot establish changed auth. */
export function ownerLatestStopMessage(
  state: any,
  session: OwnerWebSession,
  ownerVid: string,
  mpId: string,
) {
  const authHash = ownerLatestAuthHash(session, ownerVid);
  const cookieHash = sha(ownerSessionCookie(session, ownerVid));
  if (!state.stop) {
    if (
      (state.sessionAuthHash && state.sessionAuthHash !== authHash) ||
      (!state.sessionAuthHash &&
        state.sessionHash &&
        state.sessionHash !== cookieHash)
    )
      return '读书会话已变化，当前会话尚未核实；后续刷新验证需要单独授权，本次未发联网请求，旧正文保留。';
    return null;
  }
  const stoppedAuthHash = state.stop.sessionAuthHash || state.sessionAuthHash;
  if (
    stoppedAuthHash === authHash ||
    (!stoppedAuthHash && state.sessionHash === cookieHash)
  )
    return `当前读书会话${ownerLatestStageLabel(state.stop.stage)}已停止：${ownerLatestFailureReason(state.stop.reason)}；本次未发联网请求，旧正文保留。`;
  const verified = state.offlineSessionVerification;
  if (
    verified?.status === 'single-article-verified-refresh-not-authorized' &&
    verified.authHash === authHash &&
    verified.target === mpId &&
    verified.stopHash === sha(JSON.stringify(state.stop)) &&
    verified.responseHash === sha(JSON.stringify(state.response))
  )
    return '当前读书会话的一篇正文及图片已由保存证据核实；历史停止记录保留，后续刷新验证需要单独授权，本次未发联网请求。公众号最新10篇及持续更新仍未通过，旧正文保留。';
  return '历史读书停止记录保留，不能据此判定当前会话失败；当前会话尚未核实，后续刷新验证需要单独授权，本次未发联网请求，旧正文保留。';
}

/** Explicit offline review of an already consumed attempt. This neither writes
 * files nor authorizes another request, and leaves historical stop/response intact. */
export function recordOwnerLatestOfflineVerification(input: {
  stateText: string;
  sessionText: string;
  ownerVid: string;
  mpId: string;
  attempt: any;
  result: any;
  probeState: any;
  page: ProviderPage;
  savedImages: Buffer[];
}) {
  const state = JSON.parse(input.stateText);
  const session: OwnerWebSession = JSON.parse(input.sessionText);
  const authHash = ownerLatestAuthHash(session, input.ownerVid);
  const cookieHash = sha(ownerSessionCookie(session, input.ownerVid));
  const { attempt: a, result: r, probeState: p } = input;
  const page = assertProviderPage(input.page, input.mpId);
  const article = page.articles[0];
  const reservedAt = Date.parse(a?.reservedAt);
  const finishedAt = Date.parse(r?.finishedAt);
  const stoppedAt = Date.parse(state.stop?.at);
  if (
    !state.stop ||
    !state.response ||
    session.source !== 'owner-confirmed-native-web-login' ||
    (state.stop.sessionAuthHash &&
      state.sessionAuthHash &&
      state.stop.sessionAuthHash !== state.sessionAuthHash) ||
    (state.stop.sessionAuthHash || state.sessionAuthHash) === authHash ||
    state.sessionHash === cookieHash ||
    a?.target !== input.mpId ||
    a?.sessionCapturedAt !== session.capturedAt ||
    a?.sessionSha !== sha(input.sessionText) ||
    a?.freshCookieHash !== cookieHash ||
    a?.oldStopSha !== sha(input.stateText) ||
    a?.oldStopStage !== state.stop.stage ||
    a?.oldStopReason !== state.stop.reason ||
    !/^[a-f0-9]{40}$/.test(a?.commit) ||
    r?.commit !== a.commit ||
    a?.approvedCase !==
      'one cover, one body, at most 60 unique images; no article DB writes' ||
    a?.noRetry !== true ||
    r?.noRetry !== true ||
    r?.success !== true ||
    r?.oldMarkersUnchanged !== true ||
    r?.savedSessionUnchanged !== true ||
    r?.productionArticleWrites !== 0 ||
    r?.directoryRequests !== 0 ||
    r?.textRequests !== 2 ||
    r?.bodyMissing !== 0 ||
    r?.imageBlocked !== 0 ||
    r?.coverage !== 'recent-window' ||
    p?.stop ||
    p?.sessionHash !== cookieHash ||
    !Number.isFinite(reservedAt) ||
    !Number.isFinite(finishedAt) ||
    !Number.isFinite(stoppedAt) ||
    stoppedAt >= Date.parse(session.capturedAt) ||
    Date.parse(session.capturedAt) > reservedAt ||
    reservedAt > p?.lastAttemptAt ||
    p?.lastAttemptAt > p?.lastSuccessAt ||
    p?.lastSuccessAt > finishedAt ||
    !Number.isSafeInteger(p?.lastAttemptAt) ||
    !Number.isSafeInteger(p?.lastSuccessAt) ||
    !Array.isArray(r?.textResponses) ||
    r.textResponses.length !== 2 ||
    !r.textResponses.every(
      (v, index) =>
        v.stage === ['cover', 'content'][index] &&
        v.status === 200 &&
        Number.isSafeInteger(v.bytes) &&
        v.bytes > 0 &&
        /^[a-f0-9]{64}$/.test(v.requestCookieSha),
    ) ||
    r.textResponses[0].requestCookieSha !== cookieHash ||
    page.coverage !== 'recent-window' ||
    page.articles.length !== 1 ||
    page.upstreamCount !== 1 ||
    page.bodyMissing !== 0 ||
    page.imageBlocked !== 0 ||
    !article?.contentHtml?.trim() ||
    r?.article?.id !== article.id ||
    p?.articleId !== article.id ||
    r?.article?.mpId !== article.mpId ||
    r?.article?.title !== article.title ||
    r?.article?.publishTime !== article.publishTime ||
    r?.article?.allBodyImagesInline !== true ||
    r?.article?.bodyBytes !== Buffer.byteLength(article.contentHtml)
  )
    throw new Error('OWNER_LATEST_OFFLINE_EVIDENCE_INVALID');
  const $ = load(article.contentHtml);
  const imageHashes = new Set<string>();
  $('img').each((_, element) => {
    const src = $(element).attr('src') || '';
    const match =
      /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        src,
      );
    if (!match) throw new Error('OWNER_LATEST_OFFLINE_EVIDENCE_INVALID');
    const bytes = Buffer.from(match[1], 'base64');
    if (!bytes.length || bytes.toString('base64') !== match[1])
      throw new Error('OWNER_LATEST_OFFLINE_EVIDENCE_INVALID');
    imageHashes.add(sha(bytes));
  });
  const savedHashes = new Set(input.savedImages.map(sha));
  if (
    r.article.imageOccurrences !== $('img').length ||
    r.savedUniqueImages !== imageHashes.size ||
    savedHashes.size !== imageHashes.size ||
    input.savedImages.length !== imageHashes.size ||
    imageHashes.size > 60 ||
    [...savedHashes].some((hash) => !imageHashes.has(hash)) ||
    r.imageRequests !== imageHashes.size ||
    r.uniqueImageRequests !== imageHashes.size
  )
    throw new Error('OWNER_LATEST_OFFLINE_EVIDENCE_INVALID');
  return {
    ...state,
    offlineSessionVerification: {
      status: 'single-article-verified-refresh-not-authorized',
      authHash,
      stopHash: sha(JSON.stringify(state.stop)),
      responseHash: sha(JSON.stringify(state.response)),
      target: input.mpId,
      articleId: article.id,
      lastAttemptAt: p.lastAttemptAt,
      verifiedAt: r.finishedAt,
    },
  };
}
