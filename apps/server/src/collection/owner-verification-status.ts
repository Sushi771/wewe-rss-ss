import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ownerLatestStageLabel } from './owner-weread-session-state';

export type OwnerVerificationNotice = {
  feedId: string;
  feedName: string;
  accountName: string | null;
  accountTail: string;
  kind: 'weread-verification';
  stage: string;
  stoppedAt: string;
  backendStatus: 'stopped';
  canResume: false;
  officialUrl: 'https://weread.qq.com/';
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
export async function readOwnerVerificationStatus(
  configFile: string | undefined,
  feeds: { id: string; mpName: string; collectionChannel: string | null }[],
  profile: (ownerVid: string) => Promise<{ name: string } | null>,
) {
  const notices: OwnerVerificationNotice[] = [];
  if (!configFile) return { notices, unavailable: false };
  let config: any;
  try {
    config = await readJson(configFile);
  } catch {
    return { notices, unavailable: true };
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
      if (
        !Number.isFinite(at) ||
        (Number.isSafeInteger(state.lastSuccessAt) &&
          state.lastSuccessAt >= at) ||
        !['业务码 -2041', '微信读书需要官方人工验证（业务码 -2041）'].includes(
          stop?.reason,
        )
      )
        continue;
      const account = await profile(binding.ownerVid);
      notices.push({
        feedId: feed.id,
        feedName: feed.mpName,
        accountName: account?.name || null,
        accountTail: binding.ownerVid.slice(-4),
        kind: 'weread-verification',
        stage: ownerLatestStageLabel(stop.stage),
        stoppedAt: new Date(at).toISOString(),
        backendStatus: 'stopped',
        canResume: false,
        officialUrl: 'https://weread.qq.com/',
      });
    } catch {
      unavailable = true;
    }
  }
  return { notices, unavailable };
}
