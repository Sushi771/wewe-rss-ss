import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ownerLatestStageLabel } from './owner-weread-session-state';

export type OwnerVerificationNotice = {
  feedId: string;
  feedName: string;
  accountName: string | null;
  accountTail: string;
  kind: 'weread-verification' | 'weread-login-expired';
  state: 'verification_required' | 'expired';
  stage: string;
  stoppedAt: string;
  backendStatus: 'stopped';
  canResume: false;
  officialUrl: 'https://weread.qq.com/';
  verificationUrlAvailable: false;
};

async function readJson(file: string) {
  if (!path.isAbsolute(file)) throw new Error('Invalid private state');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
    throw new Error('Invalid private state');
  const bytes = await fs.readFile(file);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Invalid private state');
  return JSON.parse(bytes.toString('utf8'));
}

/** Read existing stops only. Viewing/opening an official page grants no retry.
 * A later verified backend success supersedes the retained historical stop.
 * No arbitrary upstream URL, text, cookie, private path or full VID reaches UI.
 */
async function readStops(
  configFile: string | undefined,
  feeds: { id: string; mpName: string; collectionChannel: string | null }[],
) {
  const stops: {
    accountId: string;
    feedId: string;
    feedName: string;
    state: OwnerVerificationNotice['state'];
    stage: string;
    stoppedAt: string;
  }[] = [];
  if (!configFile) return { stops, unavailable: false };
  let config: any;
  try {
    config = await readJson(configFile);
  } catch {
    return { stops, unavailable: true };
  }
  let unavailable = false;
  for (const feed of feeds) {
    const binding = config.feeds?.[feed.id];
    if (
      feed.collectionChannel !== 'owner-weread-latest' ||
      binding?.mpId !== feed.id ||
      !/^\d+$/.test(binding?.ownerVid || '') ||
      typeof binding?.wereadLatestStateFile !== 'string'
    )
      continue;
    try {
      const state = await readJson(binding.wereadLatestStateFile);
      const stop = state.stop;
      const at = Date.parse(stop?.at);
      const stateKind = [
        '业务码 -2041',
        '微信读书需要官方人工验证（业务码 -2041）',
      ].includes(stop?.reason)
        ? 'verification_required'
        : ['业务码 -2012', '微信读书登录超时（业务码 -2012）'].includes(
              stop?.reason,
            )
          ? 'expired'
          : null;
      if (
        !Number.isFinite(at) ||
        (Number.isSafeInteger(state.lastSuccessAt) &&
          state.lastSuccessAt >= at) ||
        !stateKind
      )
        continue;
      stops.push({
        accountId: binding.ownerVid,
        feedId: feed.id,
        feedName: feed.mpName,
        state: stateKind,
        stage: ownerLatestStageLabel(stop.stage),
        stoppedAt: new Date(at).toISOString(),
      });
    } catch {
      unavailable = true;
    }
  }
  return { stops, unavailable };
}

/** A newer confirmed scan supersedes an expiry label only. It cannot grant a
 * retry or supersede an official challenge; retained stops are never written. */
function needsLogin(
  stop: { stoppedAt: string },
  nativeLoginAt?: string | null,
) {
  return !(Date.parse(nativeLoginAt || '') > Date.parse(stop.stoppedAt));
}

export async function readOwnerVerificationStatus(
  configFile: string | undefined,
  feeds: { id: string; mpName: string; collectionChannel: string | null }[],
  profile: (ownerVid: string) => Promise<{
    name: string | null;
    nativeLoginAt?: string | null;
  } | null>,
) {
  const { stops, unavailable } = await readStops(configFile, feeds);
  const notices: OwnerVerificationNotice[] = [];
  for (const stop of stops) {
    const account = await profile(stop.accountId);
    if (stop.state === 'expired' && !needsLogin(stop, account?.nativeLoginAt))
      continue;
    notices.push({
      feedId: stop.feedId,
      feedName: stop.feedName,
      accountName: account?.name || null,
      accountTail: stop.accountId.slice(-4),
      kind:
        stop.state === 'expired'
          ? 'weread-login-expired'
          : 'weread-verification',
      state: stop.state,
      stage: stop.stage,
      stoppedAt: stop.stoppedAt,
      backendStatus: 'stopped',
      canResume: false,
      // Kept for older clients as ordinary homepage only. Saved -2041 has no
      // observed verification Location; arbitrary callback/state URLs are ignored.
      officialUrl: 'https://weread.qq.com/',
      verificationUrlAvailable: false,
    });
  }
  return { notices, unavailable };
}

/** Internal account-ID association, not a nickname/tail match. Only the small
 * state projection is attached to existing authenticated account metadata. */
export async function readOwnerAccountAccess(
  configFile: string | undefined,
  feeds: { id: string; mpName: string; collectionChannel: string | null }[],
  accounts: { id: string; status: number; nativeLoginAt: string | null }[],
) {
  const { stops, unavailable } = await readStops(configFile, feeds);
  return new Map(
    accounts.map((account) => [
      account.id,
      {
        loginState:
          account.status === 0 ||
          stops.some(
            (stop) =>
              stop.accountId === account.id &&
              stop.state === 'expired' &&
              needsLogin(stop, account.nativeLoginAt),
          )
            ? ('expired' as const)
            : ('unverified' as const),
        verificationRequired: stops.some(
          (stop) =>
            stop.accountId === account.id &&
            stop.state === 'verification_required',
        ),
        accessStateUnavailable: unavailable,
      },
    ]),
  );
}
