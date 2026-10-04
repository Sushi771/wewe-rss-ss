import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { OwnerWebSession, ownerSessionCookie } from './owner-web-search';
import { readOwnerSearchConfig } from './owner-search-update';
import { ownerLatestAuthHash } from './owner-weread-session-state';
import { NativeAccountProfile } from '../weread/native-account-profile';

type Account = { id: string; name: string; status: number; token: string };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const indexFile = (configFile: string, accountId: string) =>
  path.join(
    path.dirname(configFile),
    `native-account-${hash(accountId).slice(0, 24)}.json`,
  );

export function ownerConfigFile() {
  const file = process.env.OWNER_SEARCH_CONFIG_FILE;
  if (!file || !path.isAbsolute(file))
    throw new Error('未配置读书私有会话目录。');
  return file;
}

async function immutable(file: string, text: string) {
  try {
    await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 });
  } catch (e: any) {
    if (e.code !== 'EEXIST' || (await fs.readFile(file, 'utf8')) !== text)
      throw e;
  }
}

async function replace(file: string, text: string) {
  const pending = file + '.pending';
  await fs.writeFile(pending, text, { flag: 'wx', mode: 0o600 });
  try {
    await fs.rename(pending, file);
  } catch (error) {
    // This invocation created the pending file exclusively. A prior pending
    // file is never removed: its write fails above before this cleanup runs.
    await fs.unlink(pending);
    throw error;
  }
}

/** Called only while the existing native-login/config lock is held. Persist the
 * server-issued normal login even before an owner selects a subscription. No
 * browser export, account-token conversion, upstream request or source binding.
 */
export async function saveNativeAccountSession(
  configFile: string,
  session: OwnerWebSession,
) {
  if (
    !path.isAbsolute(configFile) ||
    session.source !== 'owner-confirmed-native-web-login'
  )
    throw new Error('正常Web登录来源无效。');
  ownerSessionCookie(session, session.ownerVid);
  const text = JSON.stringify(session);
  const file = path.join(
    path.dirname(configFile),
    `native-session-${hash(text).slice(0, 24)}.json`,
  );
  await immutable(file, text);
  await replace(
    indexFile(configFile, session.ownerVid),
    JSON.stringify({ sessionFile: file }),
  );
  return file;
}

/** Read existing immutable normal-login evidence, never infer a scan from the
 * account update timestamp. Only its time is returned; no credentials or paths.
 */
export async function nativeAccountLoginAt(accountId: string) {
  try {
    const configFile = ownerConfigFile();
    const index = JSON.parse(
      await fs.readFile(indexFile(configFile, accountId), 'utf8'),
    );
    const file = index.sessionFile;
    if (
      typeof file !== 'string' ||
      path.resolve(path.dirname(file)) !==
        path.resolve(path.dirname(configFile)) ||
      !/^native-session-[a-f0-9]{24}\.json$/.test(path.basename(file))
    )
      return null;
    const text = await fs.readFile(file, 'utf8');
    if (
      path.basename(file) !== `native-session-${hash(text).slice(0, 24)}.json`
    )
      return null;
    const session: OwnerWebSession = JSON.parse(text);
    if (
      session.source !== 'owner-confirmed-native-web-login' ||
      session.ownerVid !== accountId ||
      !Number.isFinite(Date.parse(session.capturedAt)) ||
      Date.parse(session.capturedAt) > Date.now() + 300000
    )
      return null;
    return new Date(session.capturedAt).toISOString();
  } catch {
    // Legacy accounts need no scan record; damaged records confer no label.
    return null;
  }
}

const profileFile = (configFile: string, accountId: string) =>
  path.join(
    path.dirname(configFile),
    `native-profile-${hash(accountId).slice(0, 24)}.json`,
  );

/** Metadata cache tied to the exact normal Web login, never a nickname-to-ID map. */
export async function saveNativeAccountProfile(
  configFile: string,
  profile: NativeAccountProfile,
  session: OwnerWebSession,
) {
  if (
    profile.source !== 'owner-confirmed-native-profile' ||
    profile.ownerVid !== session.ownerVid ||
    profile.nativeLoginAt !== session.capturedAt ||
    typeof profile.name !== 'string' ||
    !profile.name.trim() ||
    profile.name.length > 200 ||
    /[\x00-\x1f\x7f]/.test(profile.name)
  )
    throw new Error('本人资料与正常登录不符。');
  await replace(
    profileFile(configFile, session.ownerVid),
    JSON.stringify(profile),
  );
}

export async function nativeAccountProfile(
  accountId: string,
  nativeLoginAt: string | null,
) {
  try {
    if (!nativeLoginAt) return null;
    const profile: NativeAccountProfile = JSON.parse(
      await fs.readFile(profileFile(ownerConfigFile(), accountId), 'utf8'),
    );
    if (
      profile.source !== 'owner-confirmed-native-profile' ||
      profile.ownerVid !== accountId ||
      profile.nativeLoginAt !== nativeLoginAt ||
      !Number.isFinite(Date.parse(profile.capturedAt)) ||
      typeof profile.name !== 'string' ||
      !profile.name.trim() ||
      profile.name.length > 200 ||
      /[\x00-\x1f\x7f]/.test(profile.name)
    )
      return null;
    // Only public image URLs from supported Tencent image hosts reach the UI.
    let avatar: string | undefined;
    try {
      const url = new URL(profile.avatar || '');
      if (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        ['qpic.cn', 'qlogo.cn', 'rescdn.qq.com'].some(
          (host) => url.hostname === host || url.hostname.endsWith('.' + host),
        )
      )
        avatar = url.href;
    } catch {
      /* A real name is useful even without an avatar. */
    }
    return { name: profile.name, ...(avatar ? { avatar } : {}) };
  } catch {
    return null;
  }
}

async function inputs(account: Account, mpId: string) {
  if (account.status !== 1 || !/^\d+$/.test(account.id))
    throw new Error('请选择已启用的正常Web登录账号。');
  const configFile = ownerConfigFile();
  const configText = await fs.readFile(configFile, 'utf8');
  const config = JSON.parse(configText);
  const binding = await readOwnerSearchConfig(mpId);
  if (!binding.wereadLatestStateFile)
    throw new Error('该公众号未配置手动读书更新。');
  const index = JSON.parse(
    await fs.readFile(indexFile(configFile, account.id), 'utf8'),
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
      session.cookies.find((c) => c.name === 'wr_skey')?.value ||
    token.wr_vid !== account.id
  )
    throw new Error('请用选定账号完成一次本软件的正常Web登录。');
  let stateText = '{}';
  try {
    stateText = await fs.readFile(binding.wereadLatestStateFile, 'utf8');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  const state = JSON.parse(stateText);
  const authHash = ownerLatestAuthHash(session, account.id);
  const authorization = state.manualRefreshAuthorization;
  const retainedStop =
    authorization?.source === 'owner-confirmed-native-web-login' &&
    authorization.target === mpId &&
    authorization?.stopHash === hash(JSON.stringify(state.stop ?? null)) &&
    authorization.authHash === state.sessionAuthHash &&
    (!state.stop?.sessionAuthHash ||
      state.stop.sessionAuthHash === authorization.priorAuthHash) &&
    /^[a-f0-9]{64}$/.test(authorization.priorAuthHash || '');
  if (
    state.stop?.sessionAuthHash &&
    state.sessionAuthHash &&
    state.stop.sessionAuthHash !== state.sessionAuthHash &&
    !retainedStop
  )
    throw new Error('历史停止的会话归属冲突，未解除门禁。');
  let priorAuthHash =
    state.stop?.sessionAuthHash ||
    (retainedStop ? authorization.priorAuthHash : state.sessionAuthHash);
  if (!priorAuthHash && (state.stop || state.sessionHash)) {
    const oldSession: OwnerWebSession = JSON.parse(
      await fs.readFile(binding.sessionFile, 'utf8'),
    );
    const captured = Date.parse(oldSession.capturedAt);
    const oldCookie = ownerSessionCookie(
      oldSession,
      binding.ownerVid,
      captured,
    );
    if (hash(oldCookie) !== state.sessionHash)
      throw new Error('历史停止的会话归属无法核验，未解除门禁。');
    priorAuthHash = ownerLatestAuthHash(oldSession, binding.ownerVid, captured);
  }
  if (state.stop && (!priorAuthHash || priorAuthHash === authHash))
    throw new Error(
      '该登录凭据已经停止，不能重复授权重试；请先由本人处理官方登录或验证。',
    );
  if (
    state.stop &&
    (!Number.isFinite(Date.parse(state.stop.at)) ||
      Date.parse(session.capturedAt) <= Date.parse(state.stop.at))
  )
    throw new Error('请选择历史停止之后由本人完成的正常Web登录。');
  const revision = hash(
    JSON.stringify([
      account.id,
      account.status,
      mpId,
      configText,
      stateText,
      sessionText,
    ]),
  );
  return {
    configFile,
    configText,
    config,
    binding,
    sessionFile,
    session,
    stateText,
    state,
    authHash,
    priorAuthHash,
    revision,
  };
}

/** Read-only concrete preview; no token, cookie, file path or raw stop reaches UI. */
export async function previewManualWereadBinding(
  account: Account,
  mpId: string,
) {
  try {
    const i = await inputs(account, mpId);
    return {
      mpId,
      name: i.binding.name,
      revision: i.revision,
      ready: true,
      message: '连接后，点击原刷新按钮读取最近10篇正文和图片；遇限制即停止。',
    };
  } catch {
    return {
      mpId,
      name: '',
      revision: '',
      ready: false,
      message:
        '需要本软件保存的正常Web登录，且不能使用已失败的同一凭据。请用选定微信账号在账号页登录；旧停止保持。',
    };
  }
}

/** Explicit local confirmation only. Preserves old config/state byte-for-byte in
 * immutable private snapshots and keeps the active historical stop. No requests
 * are issued here; the existing manual Provider consumes the approved session.
 */
export async function confirmManualWereadBinding(
  account: Account,
  mpId: string,
  revision: string,
) {
  const configFile = ownerConfigFile();
  const configLock = await fs.open(
    configFile + '.native-login.lock',
    'wx',
    0o600,
  );
  let stateLock: Awaited<ReturnType<typeof fs.open>> | undefined;
  let stateFile: string | undefined;
  try {
    const first = await inputs(account, mpId);
    stateFile = first.binding.wereadLatestStateFile!;
    stateLock = await fs.open(stateFile + '.lock', 'wx', 0o600);
    const i = await inputs(account, mpId);
    if (i.revision !== revision)
      throw new Error('账号或订阅状态已变化，请重新预览后确认。');
    await immutable(configFile + `.before-manual-${revision}`, i.configText);
    await immutable(stateFile + `.before-manual-${revision}`, i.stateText);
    i.state.manualRefreshAuthorization = {
      source: 'owner-confirmed-native-web-login',
      target: mpId,
      authHash: i.authHash,
      priorAuthHash: i.priorAuthHash,
      stopHash: hash(JSON.stringify(i.state.stop ?? null)),
      sessionCapturedAt: i.session.capturedAt,
      approvedAt: new Date().toISOString(),
    };
    // An in-flight caller holding a stale config must not request the former
    // owner's session after this explicit account selection.
    i.state.sessionAuthHash = i.authHash;
    await replace(stateFile, JSON.stringify(i.state));
    const binding = i.config.feeds[mpId];
    binding.ownerVid = account.id;
    binding.sessionFile = i.sessionFile;
    binding.wereadDirectoryEnabled = true;
    try {
      await replace(configFile, JSON.stringify(i.config));
    } catch (error) {
      // Preserve the old live authorization if the config commit failed. Both
      // locks remain held; only roll back while the config is provably unchanged.
      if ((await fs.readFile(configFile, 'utf8')) === i.configText)
        await replace(stateFile, i.stateText);
      throw error;
    }
    return {
      connected: true,
      mpId,
      accountLabel: `${account.name}（VID …${account.id.slice(-4)}）`,
      message: '已连接手动更新；尚未取文，请在公众号页点击原刷新按钮。',
    };
  } finally {
    if (stateLock) {
      await stateLock.close();
      await fs.unlink(stateFile! + '.lock');
    }
    await configLock.close();
    await fs.unlink(configFile + '.native-login.lock');
  }
}
