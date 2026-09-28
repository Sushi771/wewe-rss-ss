import axios from 'axios';
import { load } from 'cheerio';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import {
  articleContentHtml,
  articleIdentity,
  articlePublishTime,
} from './article-page';

const SHORT_URL = /^https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]{22}$/;
const ARTICLE_COUNT = 20;
const MAX_HELPER_OUTPUT = 128 * 1024;
const MAX_HELPER_ERRORS = 64 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';

// Only these symbols may leave the helper boundary. Never persist raw stderr,
// exception text, window titles, or clipboard values as an error message.
const HELPER_ERROR_CODES = new Set([
  'INVALID_MP_ID',
  'EMPTY_MP_NAME',
  'UIA_OR_WIN32_UNAVAILABLE',
  'INTERNAL_ERROR',
  'USER_CANCELLED',
  'USER_PAUSED',
  'GLOBAL_COLLECTOR_BUSY',
  'WINDOW_NOT_FOREGROUND',
  'TOP_OF_PAGE_UNVERIFIED',
  'TAB_OWNERSHIP_UNVERIFIED',
  'TAB_SET_CHANGED',
  'CARD_LAYOUT_CHANGED',
  'CARD_ID_REUSED',
  'CARD_SEQUENCE_CHANGED',
  'ACCOUNT_APP_GROUP_NOT_FOUND',
  'AMBIGUOUS_ARTICLE_TEXT_OR_CARD',
  'ARTICLE_BODY_GROUP_MISMATCH',
  'ARTICLE_BODY_GROUP_NOT_FOUND',
  'ARTICLE_COUNT_MISMATCH',
  'ARTICLE_DID_NOT_OPEN_OR_VALIDATE',
  'ARTICLE_DOCUMENT_NOT_ACTIVE',
  'ARTICLE_PUBLISHER_MISMATCH',
  'ARTICLE_PUBLISHER_NOT_FOUND',
  'ARTICLE_TAB_NOT_FOUND',
  'ARTICLE_TITLE_ID_NOT_FOUND',
  'ARTICLE_TITLE_MISMATCH',
  'CARD_DATE_NOT_PRECEDING_TITLE',
  'CARD_DATE_NOT_PREVIOUS_SIBLING',
  'CARD_DATE_NOT_RECOGNIZED',
  'CARD_DATE_SIBLING_UNAVAILABLE',
  'CARD_DISAPPEARED_BEFORE_CLICK',
  'CLICK_POINT_NOT_OWNED_BY_WECHAT',
  'CLIPBOARD_CHANGED_BEFORE_READ',
  'CLIPBOARD_CHANGED_DURING_READ',
  'CLIPBOARD_LOCK_FAILED',
  'CLIPBOARD_NOT_UNICODE_TEXT',
  'CLIPBOARD_OPEN_FAILED',
  'CLIPBOARD_OWNER_NOT_TARGET_WECHAT',
  'CLIPBOARD_SEQUENCE_UNAVAILABLE',
  'COLLAPSED_ARTICLE_GROUP_UNSUPPORTED',
  'COPY_DID_NOT_CHANGE_CLIPBOARD',
  'COPY_EMPTY',
  'COPY_MENU_ITEM_AMBIGUOUS',
  'COPY_MENU_ITEM_NOT_FOUND',
  'COPY_NOT_CLEAN_SHORT_URL',
  'CURSOR_MOVE_FAILED',
  'ELEMENT_HAS_NO_CLICKABLE_RECT',
  'ELEMENT_OUTSIDE_WECHAT_WINDOW',
  'FEWER_THAN_REQUESTED_UNIQUE_ARTICLES',
  'FIRST_TAB_IS_NOT_TARGET_ARTICLE_PAGE',
  'FOREGROUND_IS_NOT_WECHAT',
  'FOREGROUND_PROCESS_IS_NOT_WECHATAPPEX',
  'NO_FOREGROUND_WINDOW',
  'PINNED_CARD_CHANGED',
  'PINNED_CARD_COUNT_UNVERIFIED',
  'PINNED_CARD_UNVERIFIED',
  'PINNED_GROUP_DID_NOT_EXPAND',
  'PINNED_GROUP_TOO_LARGE',
  'PINNED_GROUPS_AMBIGUOUS',
  'PINNED_SECTION_AMBIGUOUS',
  'PINNED_SECTION_UNVERIFIED',
  'PROBE_CARD_NOT_VISIBLE',
  'SCROLL_POINT_NOT_OWNED_BY_WECHAT',
  'SCROLL_POINT_OUTSIDE_WECHAT',
  'TARGET_ACCOUNT_DOCUMENT_NOT_ACTIVE',
  'TARGET_ACCOUNT_LABEL_NOT_FOUND',
  'TARGET_ELEMENT_NOT_FULLY_VISIBLE',
  'TARGET_ELEMENT_NOT_VISIBLE',
  'TARGET_ELEMENT_PROCESS_MISMATCH',
  'TARGET_HOME_NOT_RESTORED',
  'TIME_BUDGET_EXCEEDED',
  'WECHAT_BROWSER_ACTIVATION_FAILED',
  'WECHAT_BROWSER_NOT_FOREGROUND',
  'WECHAT_BROWSER_WINDOW_NOT_UNIQUE',
  'WECHAT_HWND_CHANGED',
  'WECHAT_WINDOW_CHANGED',
  'WECHAT_WINDOW_HAS_NO_PROCESS',
]);
const HELPER_STAGES = new Set([
  'INITIALIZE',
  'VERIFY_HOME',
  'RESET_HOME_TOP',
  'SCAN_PINNED',
  'OPEN_ARTICLE',
  'COPY_LINK',
  'CLOSE_ARTICLE',
  'SCAN_REGULAR',
  'SCROLL_LIST',
]);

export class DesktopCollectionError extends Error {
  constructor(
    public readonly code: string,
    public readonly stage?: string,
  ) {
    super(
      `电脑微信列表采集未完成（${code}${stage ? `，阶段 ${stage}` : ''}）；本次未写入文章`,
    );
    this.name = 'DesktopCollectionError';
  }
}

function helperFailure(stderr: string, fallback = 'HELPER_FAILED') {
  const codes = [
    ...stderr.matchAll(/^COLLECT_FAILED: ([A-Z][A-Z0-9_]+)\r?$/gm),
  ];
  const stages = [
    ...stderr.matchAll(/^COLLECT_STAGE: ([A-Z][A-Z0-9_]+)\r?$/gm),
  ];
  const code =
    codes.length === 1 && HELPER_ERROR_CODES.has(codes[0][1])
      ? codes[0][1]
      : fallback;
  const stage =
    stages.length === 1 && HELPER_STAGES.has(stages[0][1])
      ? stages[0][1]
      : undefined;
  return new DesktopCollectionError(code, stage);
}

// Per-account locks cannot protect a shared desktop. Keep this lock until the
// child has actually closed, even if its timeout already rejected the request.
let activeDesktopHelper: symbol | undefined;

function normalizedTitle(title: string) {
  return title.normalize('NFKC').replace(/\s+/gu, '');
}

type DesktopCard = {
  rank: number;
  title: string;
  shortUrl: string;
  pinned: boolean;
};
export type VerifiedDesktopArticle = ReturnType<typeof articleIdentity> & {
  rank: number;
  title: string;
  shortUrl: string;
  publishTime: number;
  contentHtml?: string;
  lastBodyStatus: 'available' | 'unavailable';
  picUrl: string;
};

function requestProxy():
  | false
  | {
      protocol: string;
      host: string;
      port: number;
    } {
  const raw = process.env.WECHAT_PUBLIC_PROXY_URL;
  if (!raw) return false;
  const url = new URL(raw);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error('公开文章仅支持无凭据的本机 HTTP 代理');
  return {
    protocol: 'http',
    host: url.hostname,
    port: Number(url.port || 80),
  };
}

async function helperPath() {
  const relative = path.join(
    'tools',
    'wechat-desktop-collector',
    'collect.ps1',
  );
  for (const candidate of [
    path.resolve(process.cwd(), relative),
    // 版本化本机产物以 release/server 为工作目录；helper 随同一版本固定。
    path.resolve(process.cwd(), '..', relative),
    path.resolve(process.cwd(), '..', '..', relative),
  ]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next repository root layout.
    }
  }
  throw new Error('内置电脑微信采集组件未安装');
}

type DesktopCollectionOptions = { resumeAfterUserConsent?: boolean };

async function runDesktopHelper(
  mpId: string,
  mpName: string,
  options: DesktopCollectionOptions,
) {
  if (process.platform !== 'win32')
    throw new Error('电脑微信采集仅可在已登录微信的 Windows 用户会话运行');
  if (activeDesktopHelper)
    throw new DesktopCollectionError('GLOBAL_COLLECTOR_BUSY');
  const helperToken = Symbol('desktop-helper');
  activeDesktopHelper = helperToken;
  const release = () => {
    if (activeDesktopHelper === helperToken) activeDesktopHelper = undefined;
  };
  let script: string;
  try {
    script = await helperPath();
  } catch (error) {
    release();
    throw error;
  }
  return new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'pwsh',
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          script,
          '-MpId',
          mpId,
          '-MpName',
          mpName,
          '-Limit',
          String(ARTICLE_COUNT),
          ...(options.resumeAfterUserConsent === true
            ? ['-ResumeAfterUserConsent']
            : []),
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      release();
      reject(new DesktopCollectionError('HELPER_START_FAILED'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let outputExceeded = false;
    let settled = false;
    const fail = (error: DesktopCollectionError) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const stop = (error: DesktopCollectionError) => {
      // A failed kill must not release the lock while UI operations can continue.
      fail(error);
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // Only a close event proves that this helper can no longer use the UI.
      }
    };
    const timer = setTimeout(
      () => {
        stop(helperFailure(stderr, 'HELPER_TIMEOUT'));
      },
      5 * 60 * 1000,
    );
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (settled || outputExceeded) return;
      if (
        Buffer.byteLength(stdout) + Buffer.byteLength(chunk) >
        MAX_HELPER_OUTPUT
      ) {
        outputExceeded = true;
        stop(new DesktopCollectionError('HELPER_OUTPUT_LIMIT'));
      } else stdout += chunk;
    });
    child.stderr!.on('data', (chunk: string) => {
      if (settled || outputExceeded) return;
      if (
        Buffer.byteLength(stderr) + Buffer.byteLength(chunk) >
        MAX_HELPER_ERRORS
      ) {
        outputExceeded = true;
        stop(new DesktopCollectionError('HELPER_OUTPUT_LIMIT'));
      } else stderr += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      if (!child.pid) release();
      fail(new DesktopCollectionError('HELPER_START_FAILED'));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      release();
      if (settled) return;
      // A failure marker must stop the run even if a broken helper exits zero or
      // prints a plausible partial JSON payload before failing.
      if (code !== 0 || signal || stderr.includes('COLLECT_FAILED:')) {
        fail(helperFailure(stderr));
        return;
      }
      settled = true;
      resolve(stdout.trim());
    });
  });
}

async function listDesktopCards(
  mpId: string,
  mpName: string,
  providedOutput?: string,
  options: DesktopCollectionOptions = {},
) {
  const live = providedOutput == null;
  const output =
    providedOutput ?? (await runDesktopHelper(mpId, mpName, options));
  if (Buffer.byteLength(output) > MAX_HELPER_OUTPUT)
    throw new DesktopCollectionError('HELPER_OUTPUT_LIMIT');
  let result: {
    protocolVersion?: unknown;
    source?: unknown;
    account?: unknown;
    mpId?: unknown;
    articles?: unknown;
    pinnedArticles?: unknown;
  };
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error('电脑微信采集结果格式无效；本次未写入文章');
  }
  if (
    result?.source !== 'desktop-wechat' ||
    (live && result.protocolVersion !== 2) ||
    (!live && result.protocolVersion != null && result.protocolVersion !== 2)
  )
    throw new DesktopCollectionError('HELPER_PROTOCOL_INVALID');
  if (
    result?.account !== mpName ||
    result?.mpId !== mpId ||
    !Array.isArray(result?.articles) ||
    result.articles.length !== ARTICLE_COUNT
  )
    throw new Error('电脑微信账号或最新20篇列表不完整；本次未写入文章');
  const cards: DesktopCard[] = result.articles.map((item, index) => {
    if (
      !item ||
      item.rank !== index + 1 ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      item.title.length > 1000 ||
      typeof item.shortUrl !== 'string' ||
      !SHORT_URL.test(item.shortUrl)
    )
      throw new Error('电脑微信卡片标题或链接无效；本次未写入文章');
    return {
      rank: item.rank,
      title: item.title.trim(),
      shortUrl: item.shortUrl,
      pinned: false,
    };
  });
  if (new Set(cards.map((item) => item.shortUrl)).size !== cards.length)
    throw new Error('电脑微信列表存在重复链接，未取得20篇唯一文章');
  if (!Array.isArray(result.pinnedArticles) || result.pinnedArticles.length > 5)
    throw new Error('电脑微信置顶文章列表不完整；本次未写入文章');
  const pinned: DesktopCard[] = result.pinnedArticles.map((item, index) => {
    if (
      !item ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      item.title.length > 1000 ||
      typeof item.shortUrl !== 'string' ||
      !SHORT_URL.test(item.shortUrl)
    )
      throw new Error('电脑微信置顶文章标题或链接无效；本次未写入文章');
    return {
      rank: ARTICLE_COUNT + index + 1,
      title: item.title.trim(),
      shortUrl: item.shortUrl,
      pinned: true,
    };
  });
  if (new Set(pinned.map((item) => item.shortUrl)).size !== pinned.length)
    throw new Error('电脑微信置顶文章存在重复链接；本次未写入文章');
  for (const item of pinned) {
    const regular = cards.find((card) => card.shortUrl === item.shortUrl);
    if (
      regular &&
      normalizedTitle(regular.title) !== normalizedTitle(item.title)
    )
      throw new Error('电脑微信置顶与普通卡片标题不一致；本次未写入文章');
  }
  return [...cards, ...pinned];
}

/** Verify all original pages before handing the latest 20 to the database layer. */
async function verifyCards(mpId: string, cards: DesktopCard[]) {
  const proxy = requestProxy();
  const articles: VerifiedDesktopArticle[] = [];
  const seen = new Map<string, VerifiedDesktopArticle>();
  const verifiedUrls = new Set<string>();
  let previousRegularTime = Number.POSITIVE_INFINITY;
  for (const card of cards) {
    // A pinned card can also appear in the chronological stream. Its matching
    // title was checked above; one original-page request proves both occurrences.
    if (card.pinned && verifiedUrls.has(card.shortUrl)) continue;
    if (articles.length)
      await new Promise((resolve) => setTimeout(resolve, 500));
    let html: string;
    try {
      const response = await axios.get<string>(card.shortUrl, {
        proxy,
        timeout: 15000,
        maxContentLength: 10 * 1024 * 1024,
        headers: { 'User-Agent': USER_AGENT },
      });
      html = String(response.data);
    } catch {
      throw new Error('近期原文请求失败；本次未写入文章');
    }
    const $ = load(html);
    // 原文外壳可能仍在，但验证/错误界面不能作为正文缺失的成功证据。
    if (
      $(
        'iframe[src*="captcha."], form[action*="/mp/verify"], #js_verify, #verify, .weui_msg',
      ).length
    )
      throw new Error('近期链接返回验证或错误页面；本次未写入文章');
    let identity: ReturnType<typeof articleIdentity>;
    try {
      identity = articleIdentity(html);
    } catch {
      throw new Error('近期链接未返回可核验的原文；本次未写入文章');
    }
    const title = $('#activity-name').text().trim();
    const publishTime = articlePublishTime(html);
    const contentHtml = articleContentHtml(html);
    if (
      identity.mpId !== mpId ||
      identity.canonical !== card.shortUrl ||
      normalizedTitle(title) !== normalizedTitle(card.title) ||
      publishTime == null ||
      (seen.has(identity.id) && !card.pinned)
    )
      throw new Error('近期文章身份、标题或日期不一致；本次未写入文章');
    verifiedUrls.add(card.shortUrl);
    if (!card.pinned) {
      if (publishTime > previousRegularTime)
        throw new Error('电脑微信列表与原文发布时间顺序不一致；本次未写入文章');
      previousRegularTime = publishTime;
    }
    if (seen.has(identity.id)) continue;
    const candidateImage = $('meta[property="og:image"]').attr('content') || '';
    let picUrl = '';
    try {
      const image = new URL(candidateImage);
      if (
        image.protocol === 'https:' &&
        !image.username &&
        !image.password &&
        !image.port &&
        /(^|\.)(qpic\.cn|qlogo\.cn|qq\.com)$/.test(image.hostname)
      )
        picUrl = image.toString();
    } catch {
      // 封面缺失不影响已核验的文章身份、标题与日期。
    }
    const verified: VerifiedDesktopArticle = {
      ...identity,
      rank: card.rank,
      title,
      shortUrl: card.shortUrl,
      publishTime,
      contentHtml,
      lastBodyStatus: contentHtml ? 'available' : 'unavailable',
      picUrl,
    };
    seen.set(identity.id, verified);
    articles.push(verified);
  }
  if (articles.length < ARTICLE_COUNT)
    throw new Error('未取得20篇唯一原文；本次未写入文章');
  return articles
    .sort((a, b) => b.publishTime - a.publishTime || a.rank - b.rank)
    .slice(0, ARTICLE_COUNT)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function validateAccount(mpId: string, mpName: string) {
  if (!/^MP_WXS_\d{5,15}$/.test(mpId) || !mpName?.trim())
    throw new Error('需要有效的订阅公众号');
}

export async function verifyDesktopEvidence(
  mpId: string,
  mpName: string,
  evidenceJson: string,
) {
  validateAccount(mpId, mpName);
  const cards = await listDesktopCards(mpId, mpName, evidenceJson);
  return verifyCards(mpId, cards);
}

export async function fetchDesktopRecent20(
  mpId: string,
  mpName: string,
  options: DesktopCollectionOptions = {},
) {
  validateAccount(mpId, mpName);
  const cards = await listDesktopCards(mpId, mpName, undefined, options);
  return verifyCards(mpId, cards);
}
