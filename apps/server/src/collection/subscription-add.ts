import { Feed, Prisma, PrismaClient } from '@prisma/client';
import {
  articleVerificationLocation,
  verificationArticleUrl,
  TimedArticleVerification,
  ARTICLE_VERIFICATION_TTL_MS,
} from '../../../../packages/shared/src/article-verification';

export const SUBSCRIPTION_DISCOVERY = Symbol('SUBSCRIPTION_DISCOVERY');
export type SubscriptionDiscoveryInput = {
  articleUrl: string;
  accountId: string;
  trigger: 'local-manual-add';
};
/** Only a server-side directory validator can supply this; never an HTTP input. */
export type VerifiedPublisher = {
  mpId: string;
  name: string;
  evidenceRevision: string;
  /** Server-only account revision check executed inside Feed transactions. */
  assertAccount?: (tx: Prisma.TransactionClient) => Promise<void>;
};
export type StagedSubscription = {
  feedId: string;
  created: boolean;
  /** Publish the validated private binding first, then activate this row. */
  activate(): Promise<void>;
  /** Withdraw unpublished binding first. Do not discard concurrent user changes. */
  rollback(): Promise<void>;
};
export type DiscoveryStage =
  | 'identity'
  | 'session'
  | 'directory'
  | 'binding'
  | 'bodies'
  | 'images'
  | 'save';
export type DiscoveryOutcome = {
  status:
    | 'needs-verification'
    | 'blocked'
    | 'failed'
    | 'directory-confirmed'
    | 'updated'
    | 'already-subscribed';
  stage: DiscoveryStage;
  code: string;
  httpStatus?: number;
  businessCode?: number;
  officialVerification?: TimedArticleVerification;
  update?: {
    articles: number;
    created: number;
    updated: number;
    bodyMissing: number;
    imageBlocked: number;
    saved: boolean;
  };
};
export interface SubscriptionDiscoveryValidator {
  /** Resolve selected normal account independently of target binding. Persist a
   * pending candidate and bounded attempt; retain stops/locks. Only a real valid
   * nonempty directory may invoke stageFeed. Publish binding -> activate -> use
   * that SAME directory in the existing latest-ten body/image/save pipeline.
   * On binding publication failure withdraw its pointer and call rollback.
   * No account fallback, challenge solving, renewal privilege or automatic retry.
   */
  discover(
    input: SubscriptionDiscoveryInput,
    stageFeed: (target: VerifiedPublisher) => Promise<StagedSubscription>,
  ): Promise<DiscoveryOutcome>;
}

export class SubscriptionRegistrationError extends Error {
  constructor(readonly code: 'FEED_IDENTITY_CONFLICT' | 'FEED_CHANGED') {
    super(code);
  }
}

/** URL shape is not identity evidence. Actual identity parsing belongs to adapter. */
export function subscriptionArticleUrl(raw: string) {
  if (typeof raw !== 'string' || raw.length > 4096)
    throw new Error('请输入不超过4096字符的官方文章链接。');
  const url = new URL(raw.trim());
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mp.weixin.qq.com' ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/s(?:\/[A-Za-z0-9_-]{1,256})?$/.test(url.pathname)
  )
    throw new Error('仅接受 HTTPS 的 mp.weixin.qq.com 文章链接。');
  for (const key of url.searchParams.keys())
    if (
      url.searchParams.getAll(key).length !== 1 ||
      /token|ticket|cookie|authorization/i.test(key)
    )
      throw new Error('文章链接含重复或认证参数，请使用公开分享链接。');
  return url.toString();
}

const normalize = (name: string) => name.normalize('NFKC').replace(/\s+/gu, '');
const fingerprint = (feed: Feed) => JSON.stringify(feed);
const stages: DiscoveryStage[] = [
  'identity',
  'session',
  'directory',
  'binding',
  'bodies',
  'images',
  'save',
];
const statuses = [
  'needs-verification',
  'blocked',
  'failed',
  'directory-confirmed',
  'updated',
  'already-subscribed',
];
const codes = new Set([
  'IDENTITY_UNRESOLVED',
  'IDENTITY_CONFLICT',
  'ACCOUNT_LOGIN_REQUIRED',
  'ACCOUNT_UNAVAILABLE',
  'SOURCE_UNAVAILABLE',
  'ATTEMPT_STOPPED',
  'ATTEMPT_BUSY',
  'COOLDOWN',
  'DIRECTORY_REFUSED',
  'DIRECTORY_EMPTY',
  'DIRECTORY_INVALID',
  'BINDING_FAILED',
  'FEED_IDENTITY_CONFLICT',
  'FEED_CHANGED',
  'BODY_PENDING',
  'BODY_FAILED',
  'IMAGE_FAILED',
  'SAVE_FAILED',
  'DIRECTORY_CONFIRMED',
  'UPDATED',
  'DISCOVERY_FAILED',
  'ALREADY_SUBSCRIBED',
  'PUBLIC_ORIGINAL_VERIFICATION_REQUIRED',
  'PUBLIC_ORIGINAL_REFUSED',
]);

/** Never forward raw errors, response objects, paths, or unrecognized fields. */
function publicOutcome(raw: DiscoveryOutcome): DiscoveryOutcome {
  if (!raw || !statuses.includes(raw.status) || !stages.includes(raw.stage))
    return { status: 'failed', stage: 'binding', code: 'DISCOVERY_FAILED' };
  const result: DiscoveryOutcome = {
    status: raw.status,
    stage: raw.stage,
    code: codes.has(raw.code) ? raw.code : 'DISCOVERY_FAILED',
  };
  if (
    Number.isSafeInteger(raw.httpStatus) &&
    raw.httpStatus! >= 100 &&
    raw.httpStatus! <= 599
  )
    result.httpStatus = raw.httpStatus;
  if (
    Number.isSafeInteger(raw.businessCode) &&
    Math.abs(raw.businessCode!) <= 999999
  )
    result.businessCode = raw.businessCode;
  const u = raw.update;
  const v = raw.officialVerification;
  if (v && raw.stage === 'identity') {
    let articleUrl: string | undefined;
    try {
      articleUrl = verificationArticleUrl(v.articleUrl);
    } catch {
      // A validator must not smuggle unrelated/private input through a label.
    }
    if (articleUrl) {
      if (v.status === 'available') {
        const checked = articleVerificationLocation(v.url, articleUrl);
        const expires = Date.parse(v.expiresAt);
        if (
          checked.status === 'available' &&
          expires > Date.now() &&
          expires <= Date.now() + ARTICLE_VERIFICATION_TTL_MS
        )
          result.officialVerification = { ...checked, expiresAt: v.expiresAt };
        else if (checked.status !== 'available')
          result.officialVerification = checked;
      } else if (
        [
          'missing-location',
          'unsafe-location',
          'sensitive-location',
          'expired',
        ].includes(v.reason)
      ) {
        result.officialVerification = {
          status: 'unavailable',
          articleUrl,
          reason: v.reason,
        };
      }
    }
  }
  if (
    u &&
    [u.articles, u.created, u.updated, u.bodyMissing, u.imageBlocked].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= 1000,
    ) &&
    u.created + u.updated <= u.articles &&
    typeof u.saved === 'boolean'
  )
    result.update = {
      articles: u.articles,
      created: u.created,
      updated: u.updated,
      bodyMissing: u.bodyMissing,
      imageBlocked: u.imageBlocked,
      saved: u.saved,
    };
  return result;
}

function outcomeMessage(outcome: DiscoveryOutcome, subscribed: boolean) {
  if (!subscribed) {
    if (outcome.code === 'PUBLIC_ORIGINAL_VERIFICATION_REQUIRED')
      return '本次公开原文要求验证或返回跳转，未添加订阅；已停止请求，未自动重试。';
    if (outcome.code === 'PUBLIC_ORIGINAL_REFUSED')
      return '本次未取得可核验的公开原文，未添加订阅；拒绝记录保留，不自动重试。';
    if (outcome.code === 'IDENTITY_UNRESOLVED')
      return '待验证：尚未取得该文章的可信公众号身份；未添加订阅，链接保留。';
    if (
      ['ACCOUNT_LOGIN_REQUIRED', 'ACCOUNT_UNAVAILABLE'].includes(outcome.code)
    )
      return '所选账号需要正常Web登录；未添加订阅，未自动续期或切换账号。';
    if (outcome.code === 'DIRECTORY_EMPTY')
      return '候选目录为空，不能证明公众号目录可用；未添加订阅。';
    if (['FEED_IDENTITY_CONFLICT', 'IDENTITY_CONFLICT'].includes(outcome.code))
      return '公众号身份与现有数据不一致；未添加或覆盖订阅。';
    return '公众号添加未完成；候选与已验证订阅分开，旧数据和停止记录保留。';
  }
  if (outcome.status === 'updated')
    return '公众号已添加，本次十篇正文和图片已由原保存流程处理；最近窗口不代表全史或未来更新已验收。';
  if (outcome.status === 'already-subscribed')
    return '该公众号已经订阅；本次未重复添加，也未自动重抓文章。后续更新使用原刷新入口。';
  if (outcome.status === 'directory-confirmed')
    return '公众号目录已核验并添加；正文和图片尚未完成，不能视为取文成功。';
  return '公众号目录已核验并添加，但正文或图片更新未完成；停止记录保留，不自动重试。';
}

/** Read-only unavailable state, also used before the adapter is registered. */
export function subscriptionDiscoveryUnavailable(
  code: 'SOURCE_UNAVAILABLE' | 'ACCOUNT_UNAVAILABLE',
) {
  const outcome: DiscoveryOutcome = {
    status: 'needs-verification',
    stage: 'session',
    code,
  };
  return {
    ...outcome,
    source: 'owner-weread-latest' as const,
    accepted: false,
    directoryValidated: false,
    pending: true,
    created: false,
    feed: null,
    message: outcomeMessage(outcome, false),
  };
}

/** DB and private binding are separate stores. New rows are inactive until
 * validated binding publication. Failed publication rolls back unchanged rows;
 * concurrent user edits remain inactive and require explicit recovery.
 */
export async function addNativeSubscription(
  db: Pick<PrismaClient, 'feed' | 'article' | '$transaction'>,
  validator: SubscriptionDiscoveryValidator,
  input: SubscriptionDiscoveryInput,
  backup: () => Promise<unknown>,
) {
  let staged: StagedSubscription | undefined;
  let current: Feed | undefined;
  let active = false;
  let invoked = false;
  const stageFeed = async (
    target: VerifiedPublisher,
  ): Promise<StagedSubscription> => {
    if (invoked) throw new SubscriptionRegistrationError('FEED_CHANGED');
    invoked = true;
    if (
      !target ||
      !/^MP_WXS_\d{5,15}$/.test(target.mpId) ||
      typeof target.name !== 'string' ||
      !target.name.trim() ||
      target.name.length > 200 ||
      /[\x00-\x1f\x7f]/.test(target.name) ||
      !/^[a-f0-9]{64}$/.test(target.evidenceRevision)
    )
      throw new SubscriptionRegistrationError('FEED_IDENTITY_CONFLICT');
    const old = await db.feed.findUnique({ where: { id: target.mpId } });
    if (old && normalize(old.mpName) !== normalize(target.name))
      throw new SubscriptionRegistrationError('FEED_IDENTITY_CONFLICT');
    if (!old) await backup();
    let created = false;
    current = await db.$transaction(async (tx) => {
      await target.assertAccount?.(tx);
      const existing = await tx.feed.findUnique({ where: { id: target.mpId } });
      if (existing) {
        if (normalize(existing.mpName) !== normalize(target.name))
          throw new SubscriptionRegistrationError('FEED_IDENTITY_CONFLICT');
        return existing;
      }
      created = true;
      return tx.feed.create({
        data: {
          id: target.mpId,
          mpName: target.name,
          mpCover: '',
          mpIntro: '',
          updateTime: 0,
          syncTime: 0,
          status: 0,
          collectionChannel: 'unavailable',
        },
      });
    });
    staged = {
      feedId: target.mpId,
      created,
      activate: async () => {
        if (active) return;
        if (
          current!.collectionChannel === 'owner-weread-latest' &&
          current!.status === 1
        ) {
          await db.$transaction(async (tx) => {
            await target.assertAccount?.(tx);
            const before = await tx.feed.findUnique({
              where: { id: target.mpId },
            });
            if (!before || fingerprint(before) !== fingerprint(current!))
              throw new SubscriptionRegistrationError('FEED_CHANGED');
          });
          active = true;
          return;
        }
        if (!created) await backup();
        current = await db.$transaction(async (tx) => {
          await target.assertAccount?.(tx);
          const before = await tx.feed.findUnique({
            where: { id: target.mpId },
          });
          if (!before || fingerprint(before) !== fingerprint(current!))
            throw new SubscriptionRegistrationError('FEED_CHANGED');
          return tx.feed.update({
            where: { id: target.mpId },
            data: {
              status: 1,
              collectionChannel: 'owner-weread-latest',
            },
          });
        });
        active = true;
      },
      rollback: async () => {
        if (active || !created) return;
        await db.$transaction(async (tx) => {
          const before = await tx.feed.findUnique({
            where: { id: target.mpId },
          });
          if (!before) return;
          if (
            fingerprint(before) !== fingerprint(current!) ||
            (await tx.article.count({ where: { mpId: target.mpId } }))
          )
            throw new SubscriptionRegistrationError('FEED_CHANGED');
          await tx.feed.delete({ where: { id: target.mpId } });
        });
        current = undefined;
      },
    };
    return staged;
  };
  let result: DiscoveryOutcome;
  try {
    result = publicOutcome(await validator.discover(input, stageFeed));
  } catch (error) {
    result = {
      status: 'failed',
      stage: active ? 'bodies' : 'binding',
      code:
        error instanceof SubscriptionRegistrationError
          ? error.code
          : 'DISCOVERY_FAILED',
    };
  }
  if (!active) {
    if (staged) {
      try {
        await staged.rollback();
      } catch {
        result = { status: 'failed', stage: 'binding', code: 'FEED_CHANGED' };
      }
    }
    if (
      ['updated', 'directory-confirmed', 'already-subscribed'].includes(
        result.status,
      )
    )
      result = { status: 'failed', stage: 'binding', code: 'BINDING_FAILED' };
  }
  if (result.status === 'already-subscribed' && staged?.created)
    result = { ...result, status: 'directory-confirmed', code: 'BODY_PENDING' };
  if (
    result.status === 'updated' &&
    (!result.update?.saved ||
      result.update.articles !== 10 ||
      result.update.bodyMissing ||
      result.update.imageBlocked)
  )
    result = { ...result, status: 'directory-confirmed', code: 'BODY_PENDING' };
  return {
    ...result,
    source: 'owner-weread-latest' as const,
    accepted: active,
    directoryValidated: active,
    pending: !['updated', 'already-subscribed'].includes(result.status),
    created: active && staged!.created,
    feed: active ? { id: current!.id, mpName: current!.mpName } : null,
    message: outcomeMessage(result, active),
  };
}
