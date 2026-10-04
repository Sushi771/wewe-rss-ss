import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { OwnerWebSession } from '../collection/owner-web-search';
import {
  SearchConfig,
  OwnerUpdateStopped,
} from '../collection/owner-search-update';
import {
  ownerLatestAuthHash,
  ownerLatestManualSessionAuthorized,
} from '../collection/owner-weread-session-state';
import { renewDirectWebTicket } from './native-web-ticket';
import {
  normalWebRenewalCookie,
  normalWebSha256 as sha,
} from './normal-web-renewal';
import { publishPrivate } from './normal-web-maintenance';

const blocked = () =>
  new OwnerUpdateStopped(
    '正常续期上下文无法核验或已经停止；请在账号页正常登录并明确连接，本次未重试，旧正文保留。',
  );

/** Called under the existing collection lock. Only a user's local manual click
 * may renew expired credentials after a complete previously authorized success.
 * Private immutable session overlay leaves binding, QR index and account DB alone. */
export async function manualWebSession(
  c: SearchConfig,
  state: any,
  trigger: 'local-manual' | 'scheduled' | 'public',
  write: () => Promise<void>,
): Promise<OwnerWebSession> {
  const baseText = await fs.readFile(c.sessionFile, 'utf8');
  const base: OwnerWebSession = JSON.parse(baseText);
  const bindingHash = sha(baseText);
  let text = baseText,
    session = base;
  const prior = state.normalManualRenewalAuthorization;
  const a = prior?.bindingSessionSha256 === bindingHash ? prior : null;
  if (a) {
    const file = a.sessionFile;
    if (
      typeof file !== 'string' ||
      !path.isAbsolute(file) ||
      path.dirname(file) !== path.dirname(c.sessionFile)
    )
      throw blocked();
    text = await fs.readFile(file, 'utf8');
    if (
      path.basename(file) !== `normal-manual-session-${sha(text)}.json` ||
      sha(text) !== a.resultingSessionSha256
    )
      throw blocked();
    session = JSON.parse(text);
  }
  const evidence = [
    state.reviewedBatchContinuationAuthorization,
    state.normalWebMaintenanceAuthorization,
  ].find((v) => v?.resultingSessionSha256 === sha(JSON.stringify(session)));
  const deadline =
    a?.bindingSessionSha256 === bindingHash
      ? Date.parse(a.validUntil)
      : Math.min(
          evidence ? Date.parse(evidence.validUntil) : Infinity,
          (session.cookies.find((v) => v.name === 'wr_skey')?.expires ?? 0) ===
            -1
            ? Infinity
            : (session.cookies.find((v) => v.name === 'wr_skey')?.expires ??
                0) * 1000,
        );
  const keyExpiry = session.cookies.find((v) => v.name === 'wr_skey')?.expires;
  const expiresAt = Number.isFinite(deadline)
    ? deadline
    : keyExpiry === -1
      ? Infinity
      : (keyExpiry ?? 0) * 1000;
  if (
    Date.now() < expiresAt ||
    trigger !== 'local-manual' ||
    !c.wereadDirectoryEnabled
  )
    return session;
  const stop = state.normalManualRenewalStop;
  if (
    stop?.bindingSessionSha256 === bindingHash ||
    (state.normalManualRenewalAttempt?.bindingSessionSha256 === bindingHash &&
      state.normalManualRenewalAttempt.parentSessionSha256 === sha(text))
  )
    throw blocked();
  const successAt = state.lastSuccessAt;
  try {
    if (
      !Number.isSafeInteger(successAt) ||
      successAt > Date.now() ||
      !Number.isSafeInteger(state.lastAttemptAt) ||
      state.lastAttemptAt <= 0 ||
      state.lastAttemptAt > successAt ||
      Date.now() - state.lastAttemptAt < 15 * 60000 ||
      state.response?.stage !== 'content-10' ||
      state.response?.httpStatus !== 200 ||
      !Array.isArray(state.articleIds) ||
      state.articleIds.length !== 10 ||
      new Set(state.articleIds).size !== 10 ||
      state.sessionAuthHash !==
        ownerLatestAuthHash(session, c.ownerVid, successAt) ||
      !ownerLatestManualSessionAuthorized(
        state,
        session,
        c.ownerVid,
        c.mpId,
        successAt,
      ) ||
      session.cookies.find((v) => v.name === 'wr_ql')?.value !== '0'
    )
      throw blocked();
    normalWebRenewalCookie(session, c.ownerVid);
  } catch {
    throw blocked();
  }
  // Reserve before transport. An interrupted/failed attempt stays consumed even
  // if writing the later error record fails; never retry it on the next click.
  state.normalManualRenewalAttempt = {
    bindingSessionSha256: bindingHash,
    parentSessionSha256: sha(text),
    at: new Date().toISOString(),
    target: c.mpId,
  };
  await write();
  try {
    const renewed = await renewDirectWebTicket(session, c.ownerVid, text);
    const now = Date.now(),
      key = renewed.session.cookies.find((v) => v.name === 'wr_skey');
    const metadata = renewed.receivedCookieMetadata.find(
      (v) => v.name === 'wr_skey',
    );
    const validUntil = Math.min(
      key?.expires === -1 ? Infinity : (key?.expires ?? 0) * 1000,
      metadata?.expires ? Date.parse(metadata.expires) : Infinity,
    );
    if (
      !Number.isFinite(validUntil) ||
      validUntil <= now ||
      renewed.parentSessionSha256 !== sha(text) ||
      (await fs.readFile(c.sessionFile, 'utf8')) !== baseText
    )
      throw blocked();
    const renewedText = JSON.stringify(renewed.session);
    const file = path.join(
      path.dirname(c.sessionFile),
      `normal-manual-session-${sha(renewedText)}.json`,
    );
    await publishPrivate(file, renewedText);
    // Preserve the exact pre-renewal state for provenance without modifying stops.
    await publishPrivate(
      `${c.wereadLatestStateFile}.before-normal-manual-${renewed.responseSha256}`,
      JSON.stringify(state),
    );
    state.normalManualRenewalAuthorization = {
      source: 'successful-local-manual-normal-renewal',
      policy: 'one-validation-then-local-manual-no-retry',
      ownerVid: c.ownerVid,
      target: c.mpId,
      sessionFile: file,
      bindingSessionSha256: bindingHash,
      parentSessionSha256: sha(text),
      parentAuthHash: renewed.parentAuthHash,
      resultingSessionSha256: sha(renewedText),
      resultingAuthHash: renewed.resultingAuthHash,
      responseSha256: renewed.responseSha256,
      normalLoginAt: renewed.normalLoginAt,
      renewedAt: renewed.renewedAt,
      validUntil: new Date(validUntil).toISOString(),
      retainedStopSha256: sha(JSON.stringify(state.stop ?? null)),
      previousSuccessAt: successAt,
    };
    await write();
    return renewed.session;
  } catch {
    state.normalManualRenewalStop = {
      bindingSessionSha256: bindingHash,
      parentSessionSha256: sha(text),
      at: new Date().toISOString(),
      reason: '正常续期失败或需要官方验证',
      requests: 1,
    };
    await write();
    throw blocked();
  }
}
