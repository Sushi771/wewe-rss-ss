import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ownerSessionCookie, OwnerWebSession } from './owner-web-search';
import { ownerLatestAuthHash } from './owner-weread-session-state';

export type NativeWereadAccount = {
  id: string;
  name: string;
  status: number;
  token: string;
};
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const nativeAccountIndexFile = (configFile: string, accountId: string) =>
  path.join(
    path.dirname(configFile),
    `native-account-${hash(accountId).slice(0, 24)}.json`,
  );

/** Server-only normal-account resolution, independent of a publisher binding.
 * The immutable native-login, expiry and exact token/owner checks are shared
 * with existing binding. Never serialize this private context to an HTTP client.
 */
export async function resolveNativeWereadAccount(
  account: NativeWereadAccount,
  configFile: string,
) {
  if (
    !path.isAbsolute(configFile) ||
    account.status !== 1 ||
    !/^\d+$/.test(account.id)
  )
    throw new Error('请选择已启用的正常Web登录账号。');
  const index = JSON.parse(
    await fs.readFile(nativeAccountIndexFile(configFile, account.id), 'utf8'),
  );
  const sessionFile = index.sessionFile;
  if (
    typeof sessionFile !== 'string' ||
    path.resolve(path.dirname(sessionFile)) !==
      path.resolve(path.dirname(configFile)) ||
    !/^native-session-[a-f0-9]{24}\.json$/.test(path.basename(sessionFile))
  )
    throw new Error('正常Web登录记录无效，请在账号页重新登录。');
  const sessionText = await fs.readFile(sessionFile, 'utf8');
  if (
    path.basename(sessionFile) !==
    `native-session-${hash(sessionText).slice(0, 24)}.json`
  )
    throw new Error('正常Web登录记录已变化，请重新登录。');
  const session: OwnerWebSession = JSON.parse(sessionText);
  ownerSessionCookie(session, account.id);
  const token = JSON.parse(account.token);
  if (
    session.source !== 'owner-confirmed-native-web-login' ||
    token.wr_skey !==
      session.cookies.find((cookie) => cookie.name === 'wr_skey')?.value ||
    token.wr_vid !== account.id
  )
    throw new Error('请用选定账号完成一次本软件的正常Web登录。');
  return {
    session,
    sessionText,
    sessionFile,
    authHash: ownerLatestAuthHash(session, account.id),
    accountRevision: hash(
      JSON.stringify([account.id, account.status, account.token, sessionText]),
    ),
  };
}
