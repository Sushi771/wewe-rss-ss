import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { SearchConfig } from './owner-search-update';
import { OwnerWebSession } from './owner-web-search';
import {
  ownerLatestAuthHash,
  ownerLatestReviewedBatchAuthorized,
} from './owner-weread-session-state';
import {
  selectWereadLatest,
  verifyWereadArticleBody,
} from './weread-directory';
import {
  applyNormalWebRenewal,
  NormalWebRenewalResponse,
  normalWebRenewalParentTime,
} from '../weread/normal-web-renewal';
import {
  publishPrivate,
  replacePrivate,
} from '../weread/normal-web-maintenance';
import { createVerifiedSqliteBackup } from './sqlite-backup';

const sha = (v: string | Buffer) =>
  createHash('sha256').update(v).digest('hex');
const invalid = () => new Error('WEREAD_BATCH_CACHE_INVALID');

/** Reuse only the exact saved directory and first three responses from this
 * stopped operation. No title lookup, HTTP, time replacement or old-body fill. */
export async function readReviewedWereadBatchCache(
  c: SearchConfig,
  manifestFile: string,
  expectedSha256: string,
) {
  if (!c.wereadLatestStateFile || !path.isAbsolute(manifestFile))
    throw invalid();
  const folder = path.dirname(manifestFile);
  if (
    path.basename(manifestFile) !== 'manifest.private.json' ||
    path.resolve(path.dirname(folder)) !==
      path.resolve(path.dirname(c.wereadLatestStateFile)) ||
    (await fs.realpath(folder)) !== path.resolve(folder)
  )
    throw invalid();
  const text = await fs.readFile(manifestFile, 'utf8');
  if (Buffer.byteLength(text) > 1024 * 1024 || sha(text) !== expectedSha256)
    throw invalid();
  const m = JSON.parse(text);
  if (
    m.version !== 1 ||
    m.source !== 'saved-original-manual-refresh-responses' ||
    m.target !== c.mpId ||
    m.requests !== 4 ||
    m.savedBodies !== 3 ||
    m.selectedArticles !== 10 ||
    m.verifiedBodies !== 2 ||
    m.imagesFetched !== 0 ||
    !Number.isSafeInteger(m.attemptedAt) ||
    !Array.isArray(m.responses) ||
    m.responses.length !== 4
  )
    throw invalid();
  const raws: string[] = [];
  for (const [i, name] of [
    'directory-0.response',
    'content-1.response',
    'content-2.response',
    'content-3.response',
  ].entries()) {
    const entry = m.responses[i],
      file = path.join(folder, name);
    if (
      entry.filename !== name ||
      entry.stage !== name.replace('.response', '') ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 || '') ||
      (await fs.realpath(file)) !== path.resolve(file)
    )
      throw invalid();
    const bytes = await fs.readFile(file);
    if (
      bytes.length > 8 * 1024 * 1024 ||
      bytes.length !== entry.bytes ||
      sha(bytes) !== entry.sha256
    )
      throw invalid();
    raws.push(bytes.toString('utf8'));
  }
  const selection = selectWereadLatest([JSON.parse(raws[0])], c);
  if (
    selection.selected.length !== 10 ||
    selection.directory.length !== m.directoryArticles
  )
    throw invalid();
  const articles = raws
    .slice(1)
    .map((html, i) => verifyWereadArticleBody(selection.selected[i], html));
  if (new Set(articles.map((a) => a.id)).size !== 3) throw invalid();
  const stoppedText = await fs.readFile(
    path.join(folder, 'state-at-stop.private.json'),
    'utf8',
  );
  if (sha(stoppedText) !== m.stateSha256) throw invalid();
  const stopped = JSON.parse(stoppedText);
  if (
    sha(JSON.stringify(stopped.stop)) !== m.currentStopSha256 ||
    stopped.lastAttemptAt !== m.attemptedAt ||
    stopped.response?.stage !== 'content-3' ||
    stopped.response.httpStatus !== 200 ||
    stopped.response.requests !== 4
  )
    throw invalid();
  return { manifest: m, stopped, selection, articles };
}

/** Integration-only adoption of one reviewed local data-contract repair.
 * Original QR/account/stop evidence stays immutable. The fresh normal response
 * rotates only this same-account session; no collection request is made here. */
export async function activateReviewedWereadBatch(input: {
  configFile: string;
  mpId: string;
  cacheManifestFile: string;
  cacheManifestSha256: string;
  expectedConfigSha256: string;
  expectedStateSha256: string;
  expectedSessionSha256: string;
  response: NormalWebRenewalResponse;
  renewedAt: string;
  approvedAt: string;
  approval: 'resume-proven-body-time-contract-repair';
}) {
  if (
    !path.isAbsolute(input.configFile) ||
    input.approval !== 'resume-proven-body-time-contract-repair'
  )
    throw invalid();
  const root = path.dirname(input.configFile);
  const local = (file: unknown): file is string =>
    typeof file === 'string' &&
    path.isAbsolute(file) &&
    path.resolve(path.dirname(file)) === path.resolve(root);
  const configLock = await fs.open(
    input.configFile + '.native-login.lock',
    'wx',
    0o600,
  );
  let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
  let stateFile: string | undefined;
  try {
    const configText = await fs.readFile(input.configFile, 'utf8'),
      config = JSON.parse(configText),
      c: SearchConfig = config.feeds?.[input.mpId];
    if (
      sha(configText) !== input.expectedConfigSha256 ||
      c?.mpId !== input.mpId ||
      !c.wereadDirectoryEnabled ||
      !local(c.sessionFile) ||
      !local(c.wereadLatestStateFile)
    )
      throw invalid();
    stateFile = c.wereadLatestStateFile;
    lock = await fs.open(stateFile! + '.lock', 'wx', 0o600);
    const stateText = await fs.readFile(stateFile!, 'utf8'),
      state = JSON.parse(stateText);
    const sessionText = await fs.readFile(c.sessionFile, 'utf8'),
      session: OwnerWebSession = JSON.parse(sessionText);
    if (
      sha(stateText) !== input.expectedStateSha256 ||
      sha(sessionText) !== input.expectedSessionSha256 ||
      state.reviewedBatchContinuationAuthorization
    )
      throw invalid();
    const cache = await readReviewedWereadBatchCache(
      c,
      input.cacheManifestFile,
      input.cacheManifestSha256,
    );
    const { manifest: m } = cache;
    if (
      m.configSha256 !== sha(configText) ||
      m.sessionSha256 !== sha(sessionText) ||
      m.stateSha256 !== sha(stateText) ||
      sha(JSON.stringify(state.stop)) !== m.currentStopSha256 ||
      state.stop?.stage !== 'content-3' ||
      state.stop.requests !== 4 ||
      state.stop.reason !== '正文与目录的身份、标题或发布时间冲突' ||
      session.source !== 'owner-confirmed-native-web-login' ||
      session.ownerVid !== c.ownerVid
    )
      throw invalid();
    const parentTime = normalWebRenewalParentTime(session, c.ownerVid);
    if (
      state.stop.sessionAuthHash !==
      ownerLatestAuthHash(session, c.ownerVid, parentTime)
    )
      throw invalid();
    const indexFile = path.join(
        root,
        `native-account-${sha(c.ownerVid).slice(0, 24)}.json`,
      ),
      indexText = await fs.readFile(indexFile, 'utf8');
    const originalFile = JSON.parse(indexText).sessionFile;
    if (!local(originalFile)) throw invalid();
    const originalText = await fs.readFile(originalFile, 'utf8');
    if (
      sha(originalText) !==
        state.normalWebMaintenanceAuthorization?.parentSessionSha256 ||
      path.basename(originalFile) !==
        `native-session-${sha(originalText).slice(0, 24)}.json` ||
      state.normalWebMaintenanceAuthorization.resultingSessionSha256 !==
        sha(sessionText)
    )
      throw invalid();
    const renewal = applyNormalWebRenewal(
      session,
      c.ownerVid,
      input.response,
      input.renewedAt,
      sessionText,
    );
    const key = renewal.session.cookies.find(
      (cookie) => cookie.name === 'wr_skey',
    )!;
    const meta = renewal.receivedCookieMetadata.find(
      (cookie) => cookie.name === 'wr_skey',
    )!;
    const until = Math.min(
      key.expires === -1 ? Infinity : key.expires * 1000,
      meta.expires ? Date.parse(meta.expires) : Infinity,
    );
    const approved = Date.parse(input.approvedAt),
      now = Date.now();
    if (
      !Number.isFinite(until) ||
      until <= now ||
      !Number.isFinite(approved) ||
      approved < Date.parse(input.renewedAt) ||
      approved > now + 300000
    )
      throw invalid();
    state.reviewedBatchContinuationAuthorization = {
      source: 'same-owner-reviewed-body-time-repair',
      policy: 'one-cache-resume-then-local-manual',
      target: c.mpId,
      parentAuthHash: state.stop.sessionAuthHash,
      resultingAuthHash: renewal.resultingAuthHash,
      parentSessionSha256: sha(sessionText),
      resultingSessionSha256: renewal.resultingSessionSha256,
      failedStopSha256: sha(JSON.stringify(state.stop)),
      failedResponseSha256: sha(JSON.stringify(state.response)),
      cacheManifestFile: input.cacheManifestFile,
      cacheManifestSha256: input.cacheManifestSha256,
      originalAttemptAt: m.attemptedAt,
      normalLoginAt: session.capturedAt,
      renewedAt: input.renewedAt,
      approvedAt: input.approvedAt,
      validUntil: new Date(until).toISOString(),
    };
    if (
      !ownerLatestReviewedBatchAuthorized(
        state,
        renewal.session,
        c.ownerVid,
        c.mpId,
        now,
      )
    )
      throw invalid();
    const backup = await createVerifiedSqliteBackup();
    const renewedText = JSON.stringify(renewal.session),
      renewedFile = path.join(
        root,
        `normal-batch-session-${sha(renewedText)}.json`,
      );
    const evidenceText = JSON.stringify({
      source: 'same-owner-reviewed-body-time-repair',
      originalStateSha256: sha(stateText),
      originalConfigSha256: sha(configText),
      cacheManifestSha256: input.cacheManifestSha256,
      authorization: state.reviewedBatchContinuationAuthorization,
      renewal,
    });
    const evidenceSha = sha(evidenceText);
    await publishPrivate(
      path.join(root, `reviewed-batch-evidence-${evidenceSha}.json`),
      evidenceText,
    );
    await publishPrivate(
      `${input.configFile}.before-batch-${evidenceSha}`,
      configText,
    );
    await publishPrivate(`${stateFile}.before-batch-${evidenceSha}`, stateText);
    await publishPrivate(renewedFile, renewedText);
    if (
      (await fs.readFile(input.configFile, 'utf8')) !== configText ||
      (await fs.readFile(stateFile!, 'utf8')) !== stateText ||
      (await fs.readFile(c.sessionFile, 'utf8')) !== sessionText ||
      (await fs.readFile(indexFile, 'utf8')) !== indexText
    )
      throw invalid();
    await replacePrivate(stateFile!, JSON.stringify(state));
    c.sessionFile = renewedFile;
    try {
      await replacePrivate(input.configFile, JSON.stringify(config));
    } catch (error) {
      if ((await fs.readFile(input.configFile, 'utf8')) === configText)
        await replacePrivate(stateFile!, stateText);
      throw error;
    }
    return {
      activated: true,
      sessionFile: renewedFile,
      cacheBodies: 3,
      originalAttemptAt: m.attemptedAt,
      validUntil: new Date(until).toISOString(),
      backup,
      platformRequests: 0,
    };
  } finally {
    try {
      if (lock) {
        await lock.close();
        await fs.unlink(stateFile! + '.lock');
      }
    } finally {
      await configLock.close();
      await fs.unlink(input.configFile + '.native-login.lock');
    }
  }
}
