import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  OwnerWebSession,
  ownerSessionCookie,
} from '../collection/owner-web-search';
import {
  ownerLatestAuthHash,
  ownerLatestNormalMaintenanceAuthorized,
} from '../collection/owner-weread-session-state';
import {
  applyNormalWebRenewal,
  NormalWebRenewal,
  NormalWebRenewalResponse,
  normalWebSha256 as sha,
  normalWebJson,
} from './normal-web-renewal';

const invalid = () => new Error('WEB_MAINTENANCE_CONTEXT_INVALID');

/** Private maintenance evidence only. Existing refresh/connection gates do not
 * read this record; it is not a fresh login or permission to retry collection. */
export function prepareNormalWebMaintenance(input: {
  sessionText: string;
  stateText: string;
  mpId: string;
  renewal: NormalWebRenewal;
  now?: number;
}) {
  const { sessionText, stateText, mpId, renewal } = input;
  const parent: OwnerWebSession = normalWebJson(sessionText);
  const state = normalWebJson(stateText);
  const stopped = state.stop;
  const approved = state.manualRefreshAuthorization;
  const renewed = Date.parse(renewal.renewedAt);
  const now = input.now ?? Date.now();
  const key = renewal.session.cookies.find(
    (cookie) => cookie.name === 'wr_skey',
  );
  const keyMetadata = renewal.receivedCookieMetadata.find(
    (cookie) => cookie.name === 'wr_skey',
  );
  // Cookie parsing retains RFC Max-Age precedence. This reviewed continuation
  // additionally respects the earlier explicit server Expires as a conservative
  // deadline, so replaying a cached response can never prolong its lifetime.
  const validUntil = Math.min(
    key?.expires === -1 ? Infinity : (key?.expires ?? 0) * 1000,
    keyMetadata?.expires ? Date.parse(keyMetadata.expires) : Infinity,
  );
  if (
    !Number.isFinite(validUntil) ||
    now >= validUntil ||
    !/^MP_WXS_\d{5,12}$/.test(mpId) ||
    parent.source !== 'owner-confirmed-native-web-login' ||
    renewal.parentSessionSha256 !== sha(sessionText) ||
    renewal.parentAuthHash !==
      ownerLatestAuthHash(parent, parent.ownerVid, renewed) ||
    renewal.resultingAuthHash !==
      ownerLatestAuthHash(renewal.session, parent.ownerVid, now) ||
    renewal.resultingSessionSha256 !== sha(JSON.stringify(renewal.session)) ||
    !/^[a-f0-9]{64}$/.test(renewal.responseSha256 || '') ||
    renewal.resultingCookieHash !==
      sha(ownerSessionCookie(renewal.session, parent.ownerVid, now)) ||
    renewal.session.source !== parent.source ||
    renewal.session.ownerVid !== parent.ownerVid ||
    renewal.normalLoginAt !== parent.capturedAt ||
    renewal.session.capturedAt !== parent.capturedAt ||
    renewal.session.renewedAt !== renewal.renewedAt ||
    !Number.isFinite(renewed) ||
    renewed > now + 300000 ||
    stopped?.sessionAuthHash !== renewal.parentAuthHash ||
    state.sessionAuthHash !== renewal.parentAuthHash ||
    stopped.stage !== 'directory-0' ||
    stopped.requests !== 1 ||
    !['业务码 -2012', '微信读书登录超时（业务码 -2012）'].includes(
      stopped.reason,
    ) ||
    !Number.isFinite(Date.parse(stopped.at)) ||
    Date.parse(stopped.at) < Date.parse(parent.capturedAt) ||
    renewed < Date.parse(stopped.at) ||
    state.response?.stage !== stopped.stage ||
    state.response?.httpStatus !== 200 ||
    state.response?.requests !== 1 ||
    approved?.target !== mpId ||
    approved.source !== parent.source ||
    approved.authHash !== renewal.parentAuthHash ||
    approved.sessionCapturedAt !== parent.capturedAt ||
    !Number.isFinite(Date.parse(approved.approvedAt)) ||
    Date.parse(approved.approvedAt) < Date.parse(parent.capturedAt) ||
    Date.parse(approved.approvedAt) > Date.parse(stopped.at)
  )
    throw invalid();
  // Return a detached snapshot: downstream evidence cannot mutate the caller's
  // old stop, authorization, session or accepted response in memory.
  return JSON.parse(
    JSON.stringify({
      version: 1,
      source: 'normal-web-session-maintenance',
      requestPolicy: 'maintenance-only-no-collection',
      validUntil: new Date(validUntil).toISOString(),
      ownerVid: parent.ownerVid,
      target: mpId,
      parentStateSha256: sha(stateText),
      failedStopSha256: sha(JSON.stringify(stopped)),
      priorAuthorizationSha256: sha(JSON.stringify(approved)),
      retainedStop: stopped,
      ...renewal,
    }),
  );
}

async function publishPrivate(file: string, text: string) {
  const pending = `${file}.${randomUUID()}.pending`;
  const handle = await fs.open(pending, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(pending, file);
    } catch (error: any) {
      if (error.code !== 'EEXIST' || (await fs.readFile(file, 'utf8')) !== text)
        throw error;
    }
    if ((await fs.readFile(file, 'utf8')) !== text) throw invalid();
  } finally {
    await fs.unlink(pending);
  }
}

async function replacePrivate(file: string, text: string) {
  const pending = file + '.pending';
  const handle = await fs.open(pending, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(pending, file);
  } catch (error) {
    await fs.unlink(pending);
    throw error;
  }
}

/** Integration-only explicit adoption of an immutable cached response candidate.
 * Same private binding/state locks as normal connection confirmation. The old
 * stop and authorization remain; only this reviewed timeout can continue.
 * Take/verify the production SQLite backup before calling this utility. */
export async function activateNormalWebMaintenance(input: {
  configFile: string;
  mpId: string;
  maintenanceFile: string;
  expectedMaintenanceSha256: string;
  expectedConfigSha256: string;
  approval: 'same-owner-timeout-continuation';
  approvedAt: string;
  now?: number;
}) {
  const { configFile, mpId, maintenanceFile } = input;
  const directory = path.dirname(configFile);
  const within = (file: unknown): file is string =>
    typeof file === 'string' &&
    path.isAbsolute(file) &&
    path.resolve(path.dirname(file)) === path.resolve(directory);
  if (
    !path.isAbsolute(configFile) ||
    !within(maintenanceFile) ||
    input.approval !== 'same-owner-timeout-continuation'
  )
    throw invalid();
  const configLock = await fs.open(
    configFile + '.native-login.lock',
    'wx',
    0o600,
  );
  let stateLock: Awaited<ReturnType<typeof fs.open>> | undefined;
  let stateFile: string | undefined;
  try {
    const text = await fs.readFile(maintenanceFile, 'utf8');
    const record = normalWebJson(text);
    if (
      sha(text) !== input.expectedMaintenanceSha256 ||
      path.basename(maintenanceFile) !==
        `normal-maintenance-${sha(text)}.json` ||
      record.source !== 'normal-web-session-maintenance' ||
      record.requestPolicy !== 'maintenance-only-no-collection' ||
      record.version !== 1
    )
      throw invalid();
    const configText = await fs.readFile(configFile, 'utf8');
    const config = normalWebJson(configText);
    const binding = config.feeds?.[mpId];
    if (
      sha(configText) !== input.expectedConfigSha256 ||
      sha(configText) !== record.parentConfigSha256 ||
      binding?.mpId !== mpId ||
      binding.ownerVid !== record.ownerVid ||
      record.target !== mpId ||
      binding.wereadDirectoryEnabled !== true ||
      !within(binding.sessionFile) ||
      !within(binding.wereadLatestStateFile)
    )
      throw invalid();
    stateFile = binding.wereadLatestStateFile;
    stateLock = await fs.open(stateFile! + '.lock', 'wx', 0o600);
    const sessionText = await fs.readFile(binding.sessionFile, 'utf8');
    const stateText = await fs.readFile(stateFile!, 'utf8');
    const now = input.now ?? Date.now();
    const evidence = prepareNormalWebMaintenance({
      sessionText,
      stateText,
      mpId,
      renewal: record,
      now,
    });
    if (
      record.parentStateSha256 !== sha(stateText) ||
      record.failedStopSha256 !== evidence.failedStopSha256 ||
      record.priorAuthorizationSha256 !== evidence.priorAuthorizationSha256
    )
      throw invalid();
    const indexFile = path.join(
      directory,
      `native-account-${sha(binding.ownerVid).slice(0, 24)}.json`,
    );
    const indexText = await fs.readFile(indexFile, 'utf8');
    if (
      normalWebJson(indexText).sessionFile !== binding.sessionFile ||
      path.basename(binding.sessionFile) !==
        `native-session-${sha(sessionText).slice(0, 24)}.json`
    )
      throw invalid();
    const approved = Date.parse(input.approvedAt);
    if (
      !Number.isFinite(approved) ||
      approved < Date.parse(record.renewedAt) ||
      approved > now + 300000
    )
      throw invalid();
    const renewedText = JSON.stringify(record.session);
    const renewedFile = path.join(
      directory,
      `normal-maintenance-session-${sha(renewedText)}.json`,
    );
    await publishPrivate(renewedFile, renewedText);
    await publishPrivate(
      `${configFile}.before-maintenance-${sha(text)}`,
      configText,
    );
    await publishPrivate(
      `${stateFile}.before-maintenance-${sha(text)}`,
      stateText,
    );
    const state = normalWebJson(stateText);
    state.normalWebMaintenanceAuthorization = {
      source: 'same-owner-normal-web-maintenance',
      policy: 'one-validation-then-local-manual',
      target: mpId,
      maintenanceSha256: sha(text),
      parentAuthHash: record.parentAuthHash,
      resultingAuthHash: record.resultingAuthHash,
      parentSessionSha256: record.parentSessionSha256,
      resultingSessionSha256: record.resultingSessionSha256,
      failedStopSha256: record.failedStopSha256,
      failedResponseSha256: sha(JSON.stringify(state.response)),
      normalLoginAt: record.normalLoginAt,
      renewedAt: record.renewedAt,
      validUntil: evidence.validUntil,
      approvedAt: input.approvedAt,
    };
    if (
      !ownerLatestNormalMaintenanceAuthorized(
        state,
        record.session,
        binding.ownerVid,
        mpId,
        now,
      )
    )
      throw invalid();
    if (
      (await fs.readFile(configFile, 'utf8')) !== configText ||
      (await fs.readFile(stateFile!, 'utf8')) !== stateText ||
      (await fs.readFile(binding.sessionFile, 'utf8')) !== sessionText ||
      (await fs.readFile(indexFile, 'utf8')) !== indexText
    )
      throw invalid();
    await replacePrivate(stateFile!, JSON.stringify(state));
    binding.sessionFile = renewedFile;
    try {
      await replacePrivate(configFile, JSON.stringify(config));
    } catch (error) {
      if ((await fs.readFile(configFile, 'utf8')) === configText)
        await replacePrivate(stateFile!, stateText);
      throw error;
    }
    return {
      sessionFile: renewedFile,
      normalLoginAt: record.normalLoginAt,
      renewedAt: record.renewedAt,
      activated: true,
      platformRequests: 0,
    };
  } finally {
    try {
      if (stateLock) {
        await stateLock.close();
        await fs.unlink(stateFile! + '.lock');
      }
    } finally {
      await configLock.close();
      await fs.unlink(configFile + '.native-login.lock');
    }
  }
}

/** Read-only account preview for a maintained binding. Human QR evidence and
 * account token still identify the original login; no QR index is moved. */
export async function previewNormalWebMaintenanceBinding(
  configFile: string,
  account: { id: string; status: number; token: string },
  mpId: string,
) {
  try {
    const configText = await fs.readFile(configFile, 'utf8');
    const binding = normalWebJson(configText).feeds?.[mpId];
    if (
      account.status !== 1 ||
      binding?.ownerVid !== account.id ||
      !binding.wereadDirectoryEnabled
    )
      return null;
    const indexText = await fs.readFile(
      path.join(
        path.dirname(configFile),
        `native-account-${sha(account.id).slice(0, 24)}.json`,
      ),
      'utf8',
    );
    const originalFile = normalWebJson(indexText).sessionFile;
    const local = (file: unknown): file is string =>
      typeof file === 'string' &&
      path.isAbsolute(file) &&
      path.resolve(path.dirname(file)) ===
        path.resolve(path.dirname(configFile));
    if (
      !local(originalFile) ||
      !local(binding.sessionFile) ||
      !local(binding.wereadLatestStateFile)
    )
      return null;
    const originalText = await fs.readFile(originalFile, 'utf8');
    const original = normalWebJson(originalText);
    const stateText = await fs.readFile(binding.wereadLatestStateFile, 'utf8');
    const state = normalWebJson(stateText);
    const sessionText = await fs.readFile(binding.sessionFile, 'utf8');
    const session = normalWebJson(sessionText);
    const a = state.normalWebMaintenanceAuthorization;
    const token = normalWebJson(account.token);
    if (
      !a ||
      a.parentSessionSha256 !== sha(originalText) ||
      path.basename(originalFile) !==
        `native-session-${sha(originalText).slice(0, 24)}.json` ||
      path.basename(binding.sessionFile) !==
        `normal-maintenance-session-${sha(sessionText)}.json` ||
      original.source !== 'owner-confirmed-native-web-login' ||
      original.ownerVid !== account.id ||
      token.wr_vid !== account.id ||
      token.wr_skey !==
        original.cookies.find((c) => c.name === 'wr_skey')?.value ||
      !ownerLatestNormalMaintenanceAuthorized(state, session, account.id, mpId)
    )
      return null;
    return {
      mpId,
      name: binding.name,
      revision: sha(
        JSON.stringify([
          account.id,
          account.status,
          configText,
          stateText,
          sessionText,
          indexText,
        ]),
      ),
      ready: true,
      connected: true,
      connectedAt: a.approvedAt,
      message:
        '正常会话已续期，扫码时间保留；请在公众号页面使用原手动更新按钮验证，遇拒绝即停止。',
    };
  } catch {
    return null;
  }
}

/** Explicit integration utility for cached response adoption. It writes one
 * immutable private evidence file under the existing config + collection locks.
 * No active pointers, QR index, account DB, state/stop or profile are written.
 * A failed/conflicting write leaves those files and previous evidence intact. */
export async function persistNormalWebMaintenance(input: {
  configFile: string;
  mpId: string;
  expectedConfigSha256: string;
  expectedStateSha256: string;
  expectedSessionSha256: string;
  response: NormalWebRenewalResponse;
  renewedAt: string;
  now?: number;
}) {
  const { configFile, mpId } = input;
  if (!path.isAbsolute(configFile)) throw invalid();
  const directory = path.dirname(configFile);
  const within = (file: unknown): file is string =>
    typeof file === 'string' &&
    path.isAbsolute(file) &&
    path.resolve(path.dirname(file)) === path.resolve(directory);
  const configLock = await fs.open(
    configFile + '.native-login.lock',
    'wx',
    0o600,
  );
  let stateLock: Awaited<ReturnType<typeof fs.open>> | undefined;
  let stateFile: string | undefined;
  let pending: string | undefined;
  try {
    const configText = await fs.readFile(configFile, 'utf8');
    const binding = normalWebJson(configText).feeds?.[mpId];
    if (
      sha(configText) !== input.expectedConfigSha256 ||
      binding?.mpId !== mpId ||
      binding.wereadDirectoryEnabled !== true ||
      !within(binding.sessionFile) ||
      !within(binding.wereadLatestStateFile)
    )
      throw invalid();
    stateFile = binding.wereadLatestStateFile;
    stateLock = await fs.open(stateFile! + '.lock', 'wx', 0o600);
    const stateText = await fs.readFile(stateFile!, 'utf8');
    const sessionText = await fs.readFile(binding.sessionFile, 'utf8');
    const session: OwnerWebSession = normalWebJson(sessionText);
    if (
      sha(stateText) !== input.expectedStateSha256 ||
      sha(sessionText) !== input.expectedSessionSha256 ||
      session.ownerVid !== binding.ownerVid
    )
      throw invalid();
    const renewal = applyNormalWebRenewal(
      session,
      binding.ownerVid,
      input.response,
      input.renewedAt,
      sessionText,
    );
    const evidence = prepareNormalWebMaintenance({
      sessionText,
      stateText,
      mpId,
      renewal,
      now: input.now,
    });
    const text = JSON.stringify({
      ...evidence,
      parentConfigSha256: sha(configText),
    });
    const file = path.join(directory, `normal-maintenance-${sha(text)}.json`);
    const temporary = `${file}.${randomUUID()}.pending`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    pending = temporary;
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Locks serialize all cooperating binding/collection writers. Byte checks
    // additionally reject an external mutation before publishing this evidence.
    if (
      (await fs.readFile(configFile, 'utf8')) !== configText ||
      (await fs.readFile(stateFile!, 'utf8')) !== stateText ||
      (await fs.readFile(binding.sessionFile, 'utf8')) !== sessionText
    )
      throw invalid();
    try {
      // Hard-link publishes atomically without replacing an existing record.
      // rename() can overwrite; writeFile(wx) can expose partial JSON on failure.
      await fs.link(temporary, file);
    } catch (error: any) {
      if (error.code !== 'EEXIST' || (await fs.readFile(file, 'utf8')) !== text)
        throw error;
    }
    if ((await fs.readFile(file, 'utf8')) !== text) throw invalid();
    return { file, evidence };
  } finally {
    try {
      if (pending) await fs.unlink(pending);
    } finally {
      try {
        if (stateLock) {
          await stateLock.close();
          await fs.unlink(stateFile! + '.lock');
        }
      } finally {
        await configLock.close();
        await fs.unlink(configFile + '.native-login.lock');
      }
    }
  }
}
