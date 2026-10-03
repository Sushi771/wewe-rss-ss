'use strict';

/**
 * Minimal guarded post-verification list consumer adapter.
 * Reuses runChaptersProbe / buildHeaders / profile helpers.
 *
 * Designed to execute immediately upon human completion of Tencent Captcha,
 * preventing short-lived verification tickets from expiring during implementation.
 *
 * Guardrails:
 * 1. Strict artifact provenance: genuine ret=0, errorCode=0, non-trerror ticket,
 *    same AppID (2044038556), session (owner-09-reader-scope), target (MP_WXS_3895431412),
 *    exact original-marker SHA and raw rejection SHA (-2041).
 * 2. Conservative short age window (default 5 minutes).
 * 3. Enforces one-use consumption ledger (flag: 'wx') before issuing network call.
 * 4. Injects ONLY source-proven wr_ticket and wr_randstr into OkHttp-equivalent headers.
 * 5. Single count=5 probe using the existing URLBuilder parameters, bounded body (2 MiB),
 *    redirect: 'error', no retries, zero production SQLite writes.
 * 6. Explicit coordinator approval required (--approved-online).
 * 7. Never leaks ticket or randstr into summary, attempt marker, or Git.
 * 8. Zero upstream requests during preflight.
 *
 * Contract limit: the official sync-client GET pipeline can append a locally stored
 * synckey. This adapter does not reproduce it and is not a complete wire replica.
 * This source correction does not authorize a new verification or list attempt.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  TARGET_BOOK_ID,
  assertSafePath,
  validateCredentials,
  loadProfile,
  buildHeaders,
} = require('./discovery-eink-storyfeed.cjs');
const {
  boundedBody,
  publish,
} = require('./probe-owner-review-single-once.cjs');
const { environmentGate } = require('./probe-refreshed-mobile-web-health.cjs');
const {
  CHAPTERS_ENDPOINT,
  MAX_BYTES,
  OFFICIAL_READER_SCOPE,
  buildChaptersUrl,
  classifyUpstream,
  parseChapters,
  verifyOwner09ScopeEvidence,
  runChaptersProbe,
} = require('./probe-mp-chapters-once.cjs');
const {
  verifyStoppedChaptersProof,
} = require('./serve-owner-manual-verify.cjs');

const ROOT = path.resolve(__dirname, '../..');
const PRIVATE_ROOT = path.join(ROOT, 'private-data');
const DISCOVERY_ROOT = path.join(PRIVATE_ROOT, 'list-discovery-20261002');
const OWNER09_ROOT = path.join(
  DISCOVERY_ROOT,
  'sdk-login-owner-09-reader-scope',
);
const OWNER07_ROOT = path.join(DISCOVERY_ROOT, 'sdk-login-owner-07');
const SOURCE_APP_ID = '2044038556';
const SESSION_NAME = 'owner-09-reader-scope';
const MAX_ARTIFACT_AGE_MS = 5 * 60 * 1000; // 5 minutes conservative age window

const PATHS = {
  session: path.join(OWNER09_ROOT, 'mobile-session.json'),
  loginResult: path.join(OWNER09_ROOT, 'result.json'),
  loginAttempt: path.join(OWNER09_ROOT, 'attempt.json'),
  scopeEvidence: path.join(OWNER09_ROOT, 'mp-scope', 'evidence.json'),
  scopeSummary: path.join(OWNER09_ROOT, 'mp-scope', 'summary.json'),
  scopeRaw: path.join(OWNER09_ROOT, 'mp-scope', 'raw-response.bin'),
  baselineSession: path.join(OWNER07_ROOT, 'mobile-session.json'),
  baselineResult: path.join(OWNER07_ROOT, 'result.json'),
  cache: path.join(DISCOVERY_ROOT, 'sdk-cache'),

  // Original stopped request provenance
  originalAttemptMarker: path.join(
    DISCOVERY_ROOT,
    'mp-chapters-owner09-attempt.json',
  ),
  originalChaptersEvidence: path.join(
    OWNER09_ROOT,
    'mp-chapters',
    'evidence.json',
  ),
  originalChaptersSummary: path.join(
    OWNER09_ROOT,
    'mp-chapters',
    'summary.json',
  ),
  originalChaptersRaw: path.join(
    OWNER09_ROOT,
    'mp-chapters',
    'raw-response.bin',
  ),

  // Manual verification artifacts & ledgers
  startLedgerFile: path.join(OWNER09_ROOT, 'manual-verify-start.json'),
  artifactFile: path.join(OWNER09_ROOT, 'manual-verification-artifact.json'),
  consumeLedgerFile: path.join(
    OWNER09_ROOT,
    'manual-verification-consumed.json',
  ),

  // Verified replay marker and output
  verifiedAttemptMarker: path.join(
    DISCOVERY_ROOT,
    'mp-chapters-owner09-verified-attempt.json',
  ),
  verifiedOutput: path.join(OWNER09_ROOT, 'mp-chapters-verified'),
};

const digest = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const unverified = {
  publicationVerified: false,
  bodyVerified: false,
  subscriptionRecovered: false,
  productionWrites: 0,
};

function stop(phase, status, reason, requests = 0) {
  return { phase, status, reason, requests, ...unverified };
}

function isValidToken(str, maxLen) {
  if (typeof str !== 'string' || !str || str.length > maxLen) return false;
  return !/[\r\n\x00-\x1f\x7f]/.test(str);
}

function sanitizeVerifiedReason(err) {
  const msg = err && err.message ? String(err.message) : '';
  if (msg.includes('environment_gate')) return 'ENVIRONMENT_GATE_BLOCKED';
  if (msg.includes('artifact_missing')) return 'ARTIFACT_MISSING';
  if (msg.includes('artifact_invalid')) return 'ARTIFACT_INVALID';
  if (msg.includes('artifact_expired')) return 'ARTIFACT_EXPIRED';
  if (msg.includes('artifact_not_success')) return 'ARTIFACT_NOT_SUCCESS';
  if (msg.includes('artifact_fallback_ticket'))
    return 'ARTIFACT_FALLBACK_TICKET_REJECTED';
  if (msg.includes('artifact_nonzero_error'))
    return 'ARTIFACT_NONZERO_ERROR_CODE';
  if (msg.includes('artifact_appid_mismatch')) return 'ARTIFACT_APPID_MISMATCH';
  if (msg.includes('artifact_target_mismatch'))
    return 'ARTIFACT_TARGET_MISMATCH';
  if (msg.includes('artifact_binding_mismatch'))
    return 'ARTIFACT_BINDING_MISMATCH';
  if (msg.includes('artifact_marker_sha_mismatch'))
    return 'ARTIFACT_MARKER_SHA_MISMATCH';
  if (msg.includes('artifact_chapters_sha_mismatch'))
    return 'ARTIFACT_CHAPTERS_SHA_MISMATCH';
  if (msg.includes('start_ledger_missing')) return 'START_LEDGER_MISSING';
  if (msg.includes('start_ledger_mismatch')) return 'START_LEDGER_MISMATCH';
  if (msg.includes('consume_ledger_already_exists'))
    return 'CONSUME_LEDGER_ALREADY_EXISTS';
  if (msg.includes('verified_marker_already_exists'))
    return 'VERIFIED_MARKER_ALREADY_EXISTS';
  if (msg.includes('verified_output_already_exists'))
    return 'VERIFIED_OUTPUT_ALREADY_EXISTS';
  if (
    msg.includes('original_attempt_missing') ||
    msg.includes('attempt_marker_missing')
  )
    return 'ATTEMPT_MARKER_MISSING';
  if (
    msg.includes('original_attempt_invalid') ||
    msg.includes('attempt_marker_invalid')
  )
    return 'ATTEMPT_MARKER_INVALID';
  if (
    msg.includes('original_chapters_raw_missing') ||
    msg.includes('chapters_evidence_missing')
  )
    return 'CHAPTERS_EVIDENCE_MISSING';
  if (msg.includes('chapters_evidence_mismatch'))
    return 'CHAPTERS_EVIDENCE_MISMATCH';
  if (
    msg.includes('original_chapters_hash_mismatch') ||
    msg.includes('chapters_hash_mismatch')
  )
    return 'CHAPTERS_HASH_MISMATCH';
  if (
    msg.includes('original_chapters_not_2041') ||
    msg.includes('chapters_errcode_not_2041')
  )
    return 'CHAPTERS_ERRCODE_NOT_2041';
  if (msg.includes('chapters_raw_invalid_json'))
    return 'CHAPTERS_RAW_INVALID_JSON';
  if (msg.includes('ticket_token_invalid')) return 'TICKET_TOKEN_INVALID';
  if (msg.includes('randstr_token_invalid')) return 'RANDSTR_TOKEN_INVALID';
  if (msg.includes('invalid_book_id')) return 'INVALID_BOOK_ID';
  if (msg.includes('count_out_of_range')) return 'COUNT_OUT_OF_RANGE_1_TO_5';
  if (msg.includes('offset_not_permitted')) return 'FIRST_PAGE_ONLY_NO_OFFSET';
  if (msg.includes('login_source_not_verified'))
    return 'LOGIN_SOURCE_NOT_VERIFIED';
  if (msg.includes('escapes boundary')) return 'PATH_ESCAPE_DETECTED';
  return 'LOCAL_GATE_FAILED';
}

function validateArtifact(
  artifact,
  startLedger,
  expectedBinding,
  markerSha,
  chaptersRawSha,
  options = {},
) {
  if (!artifact || typeof artifact !== 'object') {
    throw Error('artifact_invalid');
  }
  if (artifact.kind !== 'owner-manual-verification-artifact') {
    throw Error('artifact_invalid');
  }
  if (artifact.success !== true || artifact.ret !== 0) {
    throw Error('artifact_not_success');
  }
  if (artifact.errorCode !== 0) {
    throw Error('artifact_nonzero_error');
  }
  if (
    typeof artifact.ticket !== 'string' ||
    artifact.ticket.startsWith('trerror_')
  ) {
    throw Error('artifact_fallback_ticket');
  }
  if (!isValidToken(artifact.ticket, 2048)) {
    throw Error('ticket_token_invalid');
  }
  if (!isValidToken(artifact.randstr, 512)) {
    throw Error('randstr_token_invalid');
  }
  if (artifact.appId !== SOURCE_APP_ID) {
    throw Error('artifact_appid_mismatch');
  }
  if (
    artifact.sessionName !== SESSION_NAME ||
    artifact.targetBookId !== TARGET_BOOK_ID
  ) {
    throw Error('artifact_target_mismatch');
  }
  if (artifact.sessionBinding !== expectedBinding) {
    throw Error('artifact_binding_mismatch');
  }
  if (artifact.attemptMarkerSha256 !== markerSha) {
    throw Error('artifact_marker_sha_mismatch');
  }
  if (artifact.chaptersRawSha256 !== chaptersRawSha) {
    throw Error('artifact_chapters_sha_mismatch');
  }
  if (artifact.consumed === true) {
    throw Error('consume_ledger_already_exists');
  }

  // Time window validation (conservative default 5 minutes)
  const maxAgeMs = options.maxArtifactAgeMs || MAX_ARTIFACT_AGE_MS;
  const verifiedTime = new Date(artifact.verifiedAt).getTime();
  const now = options.now || Date.now();
  if (
    !Number.isFinite(verifiedTime) ||
    now < verifiedTime ||
    now - verifiedTime > maxAgeMs
  ) {
    throw Error('artifact_expired');
  }

  // Mandatory start ledger validation
  if (!startLedger || typeof startLedger !== 'object') {
    throw Error('start_ledger_missing');
  }
  if (startLedger.kind !== 'owner-manual-verification-start') {
    throw Error('start_ledger_mismatch');
  }
  if (startLedger.appId !== SOURCE_APP_ID) {
    throw Error('start_ledger_mismatch');
  }
  if (
    startLedger.sessionName !== SESSION_NAME ||
    startLedger.targetBookId !== TARGET_BOOK_ID
  ) {
    throw Error('start_ledger_mismatch');
  }
  if (startLedger.sessionBinding !== expectedBinding) {
    throw Error('start_ledger_mismatch');
  }
  if (
    typeof startLedger.attemptMarkerSha256 !== 'string' ||
    !startLedger.attemptMarkerSha256 ||
    startLedger.attemptMarkerSha256 !== markerSha
  ) {
    throw Error('start_ledger_mismatch');
  }
  if (
    typeof startLedger.chaptersRawSha256 !== 'string' ||
    !startLedger.chaptersRawSha256 ||
    startLedger.chaptersRawSha256 !== chaptersRawSha
  ) {
    throw Error('start_ledger_mismatch');
  }
  if (
    typeof startLedger.nonceHash !== 'string' ||
    !startLedger.nonceHash ||
    typeof artifact.nonceHash !== 'string' ||
    !artifact.nonceHash ||
    artifact.nonceHash !== startLedger.nonceHash
  ) {
    throw Error('start_ledger_mismatch');
  }

  // Time window bounds check on startLedger vs artifact
  const tStart = new Date(startLedger.startedAt).getTime();
  const tExpire = new Date(startLedger.expiresAt).getTime();
  if (
    !Number.isFinite(tStart) ||
    !Number.isFinite(tExpire) ||
    verifiedTime < tStart ||
    verifiedTime > tExpire
  ) {
    throw Error('artifact_expired');
  }

  return true;
}

function buildVerifiedHeaders(profile, mobile, artifact) {
  const wrappedProfile = {
    ...profile,
    authHeaders: (m) => {
      const baseAuth =
        typeof profile.authHeaders === 'function'
          ? profile.authHeaders(m)
          : profile.authHeaders || {};
      return {
        ...baseAuth,
        wr_ticket: artifact.ticket,
        wr_randstr: artifact.randstr,
      };
    },
  };
  return buildHeaders(wrappedProfile, mobile);
}

function verifyOriginalStoppedState(paths, expectedBinding) {
  return verifyStoppedChaptersProof(paths, expectedBinding);
}

function context(options = {}) {
  const paths = { ...PATHS, ...options.paths };
  const rootDir = options.rootDir || PRIVATE_ROOT;
  for (const value of Object.values(paths)) assertSafePath(value, rootDir);

  const result = readJson(paths.loginResult);
  const rawSession = readJson(paths.session);
  const validated = validateCredentials(rawSession, result);
  const session = { ...rawSession, ...validated };
  if (result.productionUnchanged !== true) {
    throw Error('login_source_not_verified');
  }

  const binding = digest(`${session.accountId}:${session.mobile.accessToken}`);

  // Substantive verification of owner09 reader scope and baseline
  verifyOwner09ScopeEvidence(paths, session, binding);

  // Substantive verification of original stopped state (-2041 HTTP 499)
  const originalState = verifyOriginalStoppedState(paths, binding);

  const profile = options.profile || loadProfile(ROOT, paths.cache);
  if (!profile || typeof profile.authHeaders !== 'function') {
    throw Error('invalid_profile');
  }

  return {
    paths,
    session,
    profile,
    binding,
    originalState,
  };
}

async function runPreflight(options = {}) {
  let ctx;
  try {
    environmentGate(options.env || process.env);
    ctx = context(options);
  } catch (error) {
    return {
      status: 'preflight_failed',
      reason: sanitizeVerifiedReason(error),
      requests: 0,
      markerWritten: false,
      credentialValid: false,
      profileValid: false,
      artifactReady: false,
      verifiedChaptersReady: false,
      ...unverified,
    };
  }

  const paths = ctx.paths;
  const hasConsumeLedger = fs.existsSync(paths.consumeLedgerFile);
  const hasVerifiedMarker = fs.existsSync(paths.verifiedAttemptMarker);
  const hasVerifiedOutput = fs.existsSync(paths.verifiedOutput);
  const hasArtifact = fs.existsSync(paths.artifactFile);
  const hasStartLedger = fs.existsSync(paths.startLedgerFile);

  let artifactValid = false;
  let artifactPending = !hasArtifact || !hasStartLedger;

  if (hasArtifact && hasStartLedger) {
    try {
      const artifact = readJson(paths.artifactFile);
      const startLedger = readJson(paths.startLedgerFile);
      validateArtifact(
        artifact,
        startLedger,
        ctx.binding,
        ctx.originalState.markerSha256,
        ctx.originalState.chaptersRawSha256,
        options,
      );
      artifactValid = true;
      artifactPending = false;
    } catch {
      artifactValid = false;
    }
  }

  const ready =
    artifactValid &&
    !hasConsumeLedger &&
    !hasVerifiedMarker &&
    !hasVerifiedOutput;

  return {
    status: 'preflight_ok',
    requests: 0,
    markerWritten: false,
    credentialValid: true,
    profileValid: true,
    artifactReady: artifactValid,
    artifactPending,
    verifiedChaptersReady: ready,
    targetBookId: TARGET_BOOK_ID,
    sessionBinding: ctx.binding,
    ticketHeaderBound: true,
    ...unverified,
  };
}

async function runVerifiedChaptersProbe(options = {}) {
  const phase = 'chapters_verified';

  try {
    environmentGate(options.env || process.env);
  } catch (err) {
    return stop(phase, 'local_gate_stop', sanitizeVerifiedReason(err));
  }

  if (options.approvedOnline !== true) {
    return stop(phase, 'local_gate_stop', 'EXPLICIT_STAGE_APPROVAL_REQUIRED');
  }

  if (options.offset !== undefined) {
    return stop(phase, 'local_gate_stop', 'FIRST_PAGE_ONLY_NO_OFFSET');
  }

  const paths = { ...PATHS, ...options.paths };
  const rootDir = options.rootDir || PRIVATE_ROOT;
  try {
    for (const value of Object.values(paths)) assertSafePath(value, rootDir);
  } catch (err) {
    return stop(phase, 'local_gate_stop', sanitizeVerifiedReason(err));
  }

  // Pre-checks on ledgers and existing outputs
  if (fs.existsSync(paths.consumeLedgerFile)) {
    return stop(
      phase,
      'ledger_already_consumed_stop',
      'CONSUME_LEDGER_ALREADY_EXISTS',
    );
  }
  if (fs.existsSync(paths.verifiedAttemptMarker)) {
    return stop(phase, 'marker_exists_stop', 'VERIFIED_MARKER_ALREADY_EXISTS');
  }
  if (fs.existsSync(paths.verifiedOutput)) {
    return stop(phase, 'local_gate_stop', 'VERIFIED_OUTPUT_ALREADY_EXISTS');
  }

  let ctx;
  try {
    ctx = context(options);
  } catch (error) {
    return stop(phase, 'local_gate_stop', sanitizeVerifiedReason(error));
  }

  // Mandatory artifact and start ledger checks
  if (!fs.existsSync(paths.artifactFile)) {
    return stop(phase, 'local_gate_stop', 'ARTIFACT_MISSING');
  }
  if (!fs.existsSync(paths.startLedgerFile)) {
    return stop(phase, 'local_gate_stop', 'START_LEDGER_MISSING');
  }

  let artifact;
  try {
    artifact = readJson(paths.artifactFile);
    const startLedger = readJson(paths.startLedgerFile);
    validateArtifact(
      artifact,
      startLedger,
      ctx.binding,
      ctx.originalState.markerSha256,
      ctx.originalState.chaptersRawSha256,
      options,
    );
  } catch (err) {
    return stop(phase, 'local_gate_stop', sanitizeVerifiedReason(err));
  }

  const count = options.count !== undefined ? options.count : 5;
  if (!Number.isInteger(count) || count < 1 || count > 5) {
    return stop(phase, 'local_gate_stop', 'COUNT_OUT_OF_RANGE_1_TO_5');
  }

  // Atomically record consumption ledger with wx mode before network execution
  try {
    publish(paths.consumeLedgerFile, {
      kind: 'owner-manual-verification-consumed',
      consumedAt: new Date().toISOString(),
      sessionBinding: ctx.binding,
      targetBookId: TARGET_BOOK_ID,
      ticketSha256: digest(artifact.ticket),
      randstrSha256: digest(artifact.randstr),
    });
  } catch (error) {
    if (error.code === 'EEXIST') {
      return stop(
        phase,
        'ledger_already_consumed_stop',
        'CONSUME_LEDGER_ALREADY_EXISTS',
      );
    }
    throw error;
  }

  // Wrap profile authHeaders to inject wr_ticket and wr_randstr
  const wrappedProfile = {
    ...ctx.profile,
    authHeaders: (mobile) => {
      const baseAuth =
        typeof ctx.profile.authHeaders === 'function'
          ? ctx.profile.authHeaders(mobile)
          : ctx.profile.authHeaders || {};
      return {
        ...baseAuth,
        wr_ticket: artifact.ticket,
        wr_randstr: artifact.randstr,
      };
    },
  };

  // Delegate network execution directly to reviewed runChaptersProbe with independent paths
  return await runChaptersProbe({
    ...options,
    approvedOnline: true,
    count,
    profile: wrappedProfile,
    paths: {
      ...paths,
      chaptersMarker: paths.verifiedAttemptMarker,
      chaptersOutput: paths.verifiedOutput,
    },
  });
}

function parseCliArgs(argv) {
  if (argv.length === 1 && argv[0] === '--plan') {
    return { mode: 'plan' };
  }
  if (argv.length === 1 && argv[0] === '--preflight') {
    return { mode: 'preflight' };
  }
  if (
    argv.length === 2 &&
    argv[0] === '--chapters' &&
    argv[1] === '--approved-online'
  ) {
    return { mode: 'execute', count: 5 };
  }
  if (
    argv.length === 4 &&
    argv[0] === '--chapters' &&
    argv[1] === '--approved-online' &&
    argv[2] === '--count'
  ) {
    if (!/^[1-5]$/.test(argv[3])) {
      throw Error('count_out_of_range');
    }
    return { mode: 'execute', count: parseInt(argv[3], 10) };
  }
  throw Error('usage_gate');
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  environmentGate(process.env);

  if (parsed.mode === 'plan') {
    console.log(
      JSON.stringify(
        {
          action: 'probe-mp-chapters-verified-once',
          appId: SOURCE_APP_ID,
          targetBookId: TARGET_BOOK_ID,
          sessionName: SESSION_NAME,
          endpoint: CHAPTERS_ENDPOINT,
          count: 5,
          wrHeadersInjected: ['wr_ticket', 'wr_randstr'],
          maxArtifactAgeMs: MAX_ARTIFACT_AGE_MS,
          publicationVerified: false,
          productionWrites: 0,
        },
        null,
        2,
      ),
    );
    return;
  }

  const result =
    parsed.mode === 'preflight'
      ? await runPreflight()
      : await runVerifiedChaptersProbe({
          approvedOnline: true,
          count: parsed.count,
        });

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.log(
      JSON.stringify(
        stop('local', 'local_gate_stop', sanitizeVerifiedReason(err)),
      ),
    );
    process.exitCode = 1;
  });
}

module.exports = {
  PATHS,
  SOURCE_APP_ID,
  SESSION_NAME,
  MAX_ARTIFACT_AGE_MS,
  isValidToken,
  sanitizeVerifiedReason,
  validateArtifact,
  buildVerifiedHeaders,
  verifyOriginalStoppedState,
  parseCliArgs,
  runPreflight,
  runVerifiedChaptersProbe,
};
