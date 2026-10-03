'use strict';

/**
 * Minimal owner-triggered loopback manual verification adapter.
 * Uses official Tencent Captcha Web SDK constructor taking exact native AppID 2044038556.
 *
 * Official Tencent Captcha Web documentation (updated 2026-09-15):
 * https://cloud.tencent.com/document/product/1110/36841
 * Documented canonical v1.0 dynamic script endpoint:
 * https://turing.captcha.qcloud.com/TCaptcha.js
 *
 * Guardrails:
 * 1. Loopback only (127.0.0.1).
 * 2. Zero external requests before owner explicitly clicks.
 * 3. Browser/AppID compatibility explicitly UNVERIFIED until runtime feedback.
 * 4. Bound to owner-09-reader-scope, target MP_WXS_3895431412, and original attempt marker.
 * 5. Reuses shared assertSafePath and validateCredentials from discovery-eink-storyfeed.cjs.
 * 6. Reuses verifyOwner09ScopeEvidence and verifies HTTP 499 / -2041 evidence SHA and parsed errcode == -2041.
 * 7. Cryptographic nonce, 15-minute time window, persistent one-use start ledger and artifact (wx mode).
 * 8. Rejects all nonzero errorCode and trerror_ disaster/fallback tickets; preserves failure metadata only.
 * 9. Private artifact storage (0o600); credentials never in browser.
 * 10. On refusal/cancel/error: STOPS immediately; never retries or bypasses.
 * 11. Zero WeRead list or body requests.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { environmentGate } = require('./probe-refreshed-mobile-web-health.cjs');
const {
  assertSafePath,
  validateCredentials,
} = require('./discovery-eink-storyfeed.cjs');
const {
  OFFICIAL_READER_SCOPE,
  verifyOwner09ScopeEvidence,
} = require('./probe-mp-chapters-once.cjs');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE_APP_ID = '2044038556';
const TARGET_BOOK_ID = 'MP_WXS_3895431412';
const SESSION_NAME = 'owner-09-reader-scope';
const CANONICAL_SDK_URL = 'https://turing.captcha.qcloud.com/TCaptcha.js';
const DEFAULT_PORT = 4355;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_BODY_BYTES = 16 * 1024; // 16 KB

const DEFAULT_PATHS = {
  cache: path.resolve(ROOT, 'private-data/weread-cache'),
  sessionDir: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-09-reader-scope',
  ),
  session: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-09-reader-scope/mobile-session.json',
  ),
  loginResult: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-09-reader-scope/result.json',
  ),
  loginAttempt: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-09-reader-scope/attempt.json',
  ),
  scopeEvidence: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-09-reader-scope/mp-scope/evidence.json',
  ),
  scopeSummary: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-09-reader-scope/mp-scope/summary.json',
  ),
  scopeRaw: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-09-reader-scope/mp-scope/raw-response.bin',
  ),
  baselineSession: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-07/mobile-session.json',
  ),
  baselineResult: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-07/result.json',
  ),
  attemptMarker: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/mp-chapters-owner09-attempt.json',
  ),
  chaptersEvidence: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-09-reader-scope/mp-chapters/evidence.json',
  ),
  chaptersSummary: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-09-reader-scope/mp-chapters/summary.json',
  ),
  chaptersRaw: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-09-reader-scope/mp-chapters/raw-response.bin',
  ),
  startLedgerFile: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-09-reader-scope/manual-verify-start.json',
  ),
  artifactFile: path.resolve(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-09-reader-scope/manual-verification-artifact.json',
  ),
};

function sanitizeDirectiveName(str) {
  if (typeof str !== 'string') return '';
  const first = str.trim().split(/[\s;]/)[0] || '';
  return first.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function sanitizeDiagnosticUrl(str) {
  if (typeof str !== 'string' || !str) return '';
  const trimmed = str.trim();
  if (/^(data|javascript|blob):/i.test(trimmed)) {
    const m = trimmed.match(/^([a-zA-Z]+):/);
    return m ? m[1].toLowerCase() + ':' : '';
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    }
    return parsed.protocol;
  } catch {
    if (trimmed.startsWith('/')) {
      return trimmed.split('?')[0].split('#')[0].slice(0, 256);
    }
    return '';
  }
}

function sanitizeDiagnosticText(str, context = {}, maxLen = 256) {
  if (typeof str !== 'string') return '';
  let text = str;

  // 1. Redact known context secrets if present
  if (context.nonce && typeof context.nonce === 'string') {
    text = text.replaceAll(context.nonce, '[REDACTED_NONCE]');
  }
  if (context.ticket && typeof context.ticket === 'string' && context.ticket) {
    text = text.replaceAll(context.ticket, '[REDACTED_TICKET]');
  }
  if (
    context.randstr &&
    typeof context.randstr === 'string' &&
    context.randstr
  ) {
    text = text.replaceAll(context.randstr, '[REDACTED_RANDSTR]');
  }

  // 2. Redact patterns like trerror_* or generic tickets
  text = text.replace(/trerror_[a-zA-Z0-9_-]+/gi, '[REDACTED_TICKET]');

  // 3. Redact URLs embedded in the message: strip query/hash, userinfo
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (urlMatch) => {
    return sanitizeDiagnosticUrl(urlMatch);
  });

  // 4. Remove control characters and limit length
  return text
    .replace(/[\r\n\x00-\x1f\x7f]/g, ' ')
    .slice(0, maxLen)
    .trim();
}

function sanitizeDiagnosticEvent(raw, context = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const event = {};

  const rawType =
    typeof (raw.type || raw.eventType) === 'string'
      ? raw.type || raw.eventType
      : 'unknown';
  event.type = sanitizeDiagnosticText(rawType, context, 64);

  event.timestamp =
    typeof raw.timestamp === 'string' && raw.timestamp.length <= 64
      ? raw.timestamp
      : new Date().toISOString();

  if (
    raw.blockedURI !== undefined ||
    raw.violatedDirective !== undefined ||
    raw.effectiveDirective !== undefined ||
    event.type === 'securitypolicyviolation'
  ) {
    if (raw.blockedURI !== undefined) {
      event.blockedURI = sanitizeDiagnosticUrl(String(raw.blockedURI));
    }
    if (raw.effectiveDirective !== undefined) {
      event.effectiveDirective = sanitizeDirectiveName(
        String(raw.effectiveDirective),
      );
    }
    if (raw.violatedDirective !== undefined) {
      event.violatedDirective = sanitizeDirectiveName(
        String(raw.violatedDirective),
      );
    }
    if (raw.sourceFile !== undefined) {
      event.sourceFile = sanitizeDiagnosticUrl(String(raw.sourceFile));
    }
    if (Number.isInteger(raw.lineNumber)) event.lineNumber = raw.lineNumber;
    if (Number.isInteger(raw.columnNumber))
      event.columnNumber = raw.columnNumber;
    if (Number.isInteger(raw.statusCode)) event.statusCode = raw.statusCode;
  }

  if (
    raw.message !== undefined ||
    raw.filename !== undefined ||
    event.type === 'error' ||
    event.type === 'script_error'
  ) {
    if (raw.message !== undefined) {
      event.message = sanitizeDiagnosticText(String(raw.message), context, 256);
    }
    if (raw.filename !== undefined) {
      event.filename = sanitizeDiagnosticUrl(String(raw.filename));
    }
    if (Number.isInteger(raw.lineno)) event.lineno = raw.lineno;
    if (Number.isInteger(raw.colno)) event.colno = raw.colno;
  }

  if (
    raw.errorCode !== undefined ||
    raw.errCode !== undefined ||
    raw.ret !== undefined
  ) {
    if (Number.isInteger(raw.ret)) event.ret = raw.ret;
    const ec = raw.errorCode !== undefined ? raw.errorCode : raw.errCode;
    if (Number.isInteger(ec)) {
      event.errorCode = ec;
    } else if (typeof ec === 'string' && /^-?\d+$/.test(ec)) {
      event.errorCode = parseInt(ec, 10);
    }
    if (raw.errorMessage !== undefined) {
      event.errorMessage = sanitizeDiagnosticText(
        String(raw.errorMessage),
        context,
        256,
      );
    }
  }

  return event;
}

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sanitizeErrorReason(error) {
  const msg = String(error?.message || error || '');
  if (msg.includes('environment_gate')) return 'ENVIRONMENT_GATE_FAILED';
  if (
    msg.includes('Target path escapes boundary') ||
    msg.includes('path_escapes')
  )
    return 'PATH_ESCAPE_DETECTED';
  if (msg.includes('session_missing')) return 'SESSION_FILE_MISSING';
  if (msg.includes('login_result_missing')) return 'LOGIN_RESULT_MISSING';
  if (msg.includes('login_source_not_verified'))
    return 'LOGIN_SOURCE_NOT_VERIFIED';
  if (msg.includes('Invalid session source or formatVersion'))
    return 'SESSION_INVALID';
  if (msg.includes('requested_scope_mismatch'))
    return 'REQUESTED_SCOPE_MISMATCH';
  if (msg.includes('attempt_scope_missing')) return 'ATTEMPT_SCOPE_MISSING';
  if (msg.includes('attempt_scope_mismatch')) return 'ATTEMPT_SCOPE_MISMATCH';
  if (msg.includes('attempt_marker_missing')) return 'ATTEMPT_MARKER_MISSING';
  if (msg.includes('attempt_marker_invalid')) return 'ATTEMPT_MARKER_INVALID';
  if (msg.includes('session_binding_mismatch'))
    return 'SESSION_BINDING_MISMATCH';
  if (msg.includes('chapters_evidence_missing'))
    return 'CHAPTERS_EVIDENCE_MISSING';
  if (msg.includes('chapters_evidence_mismatch'))
    return 'CHAPTERS_EVIDENCE_MISMATCH';
  if (msg.includes('chapters_hash_mismatch')) return 'CHAPTERS_HASH_MISMATCH';
  if (msg.includes('chapters_raw_invalid_json'))
    return 'CHAPTERS_RAW_INVALID_JSON';
  if (msg.includes('chapters_errcode_not_2041'))
    return 'CHAPTERS_ERRCODE_NOT_2041';
  if (msg.includes('baseline_missing')) return 'BASELINE_MISSING';
  if (msg.includes('baseline_result_not_verified'))
    return 'BASELINE_RESULT_NOT_VERIFIED';
  if (msg.includes('baseline_account_mismatch'))
    return 'BASELINE_ACCOUNT_MISMATCH';
  if (msg.includes('baseline_vid_mismatch')) return 'BASELINE_VID_MISMATCH';
  if (msg.includes('baseline_device_mismatch'))
    return 'BASELINE_DEVICE_MISMATCH';
  if (msg.includes('baseline_token_not_new')) return 'BASELINE_TOKEN_NOT_NEW';
  if (msg.includes('baseline_captured_not_later'))
    return 'BASELINE_CAPTURED_NOT_LATER';
  if (msg.includes('scope_evidence_missing')) return 'SCOPE_EVIDENCE_MISSING';
  if (msg.includes('scope_evidence_mismatch')) return 'SCOPE_EVIDENCE_MISMATCH';
  if (msg.includes('scope_hash_mismatch')) return 'SCOPE_HASH_MISMATCH';
  if (msg.includes('raw_scope_content_mismatch'))
    return 'RAW_SCOPE_CONTENT_MISMATCH';
  if (msg.includes('mp_scope_not_granted')) return 'MP_SCOPE_NOT_GRANTED';
  if (msg.includes('start_ledger_already_exists'))
    return 'START_LEDGER_ALREADY_EXISTS';
  if (msg.includes('artifact_already_exists')) return 'ARTIFACT_ALREADY_EXISTS';
  if (msg.includes('ledger_already_consumed')) return 'LEDGER_ALREADY_CONSUMED';
  if (msg.includes('session_expired')) return 'SESSION_EXPIRED';
  if (msg.includes('nonce_invalid')) return 'NONCE_INVALID';
  if (msg.includes('origin_mismatch')) return 'ORIGIN_MISMATCH';
  if (msg.includes('host_mismatch')) return 'HOST_MISMATCH';
  if (msg.includes('content_type_invalid')) return 'CONTENT_TYPE_INVALID';
  if (msg.includes('appid_mismatch')) return 'APPID_MISMATCH';
  if (msg.includes('ticket_invalid')) return 'TICKET_INVALID';
  if (msg.includes('randstr_invalid')) return 'RANDSTR_INVALID';
  return 'PREFLIGHT_GATE_FAILED';
}

function isValidToken(str, maxLen) {
  if (typeof str !== 'string' || !str || str.length > maxLen) return false;
  // Disallow CR, LF, null bytes, and all control characters
  return !/[\r\n\x00-\x1f\x7f]/.test(str);
}

function verifyStoppedChaptersProof(paths, expectedBinding) {
  const attemptMarkerPath = paths.attemptMarker || paths.originalAttemptMarker;
  const chaptersEvidencePath =
    paths.chaptersEvidence || paths.originalChaptersEvidence;
  const chaptersSummaryPath =
    paths.chaptersSummary || paths.originalChaptersSummary;
  const chaptersRawPath = paths.chaptersRaw || paths.originalChaptersRaw;

  // 1. Verify attempt marker for stopped mp-chapters request
  if (!fs.existsSync(attemptMarkerPath)) {
    throw Error('attempt_marker_missing');
  }
  const marker = readJson(attemptMarkerPath);
  if (
    !marker ||
    marker.kind !== 'official-eink-mp-chapters-once' ||
    marker.endpoint !== 'https://i.weread.qq.com/mp/chapters' ||
    marker.params?.bookId !== TARGET_BOOK_ID ||
    !Number.isInteger(marker.params?.count) ||
    marker.params.count < 1 ||
    marker.params.count > 5 ||
    marker.sessionBinding !== expectedBinding
  ) {
    throw Error('attempt_marker_invalid');
  }

  // 2. Verify HTTP 499 / -2041 evidence, raw SHA, and parse errcode == -2041
  if (
    !fs.existsSync(chaptersEvidencePath) ||
    !fs.existsSync(chaptersSummaryPath) ||
    !fs.existsSync(chaptersRawPath)
  ) {
    throw Error('chapters_evidence_missing');
  }

  const chaptersEvidence = readJson(chaptersEvidencePath);
  const chaptersSummary = readJson(chaptersSummaryPath);
  const chaptersRawBytes = fs.readFileSync(chaptersRawPath);

  if (
    chaptersEvidence.phase !== 'chapters' ||
    chaptersEvidence.httpStatus !== 499 ||
    chaptersEvidence.requests !== 1 ||
    chaptersEvidence.responseBodyComplete !== true ||
    chaptersEvidence.sessionBinding !== expectedBinding
  ) {
    throw Error('chapters_evidence_mismatch');
  }

  const rawSha = digest(chaptersRawBytes);
  if (rawSha !== chaptersEvidence.responseSha256) {
    throw Error('chapters_hash_mismatch');
  }

  if (
    chaptersSummary.phase !== 'chapters' ||
    chaptersSummary.httpStatus !== 499 ||
    chaptersSummary.requests !== 1
  ) {
    throw Error('chapters_evidence_mismatch');
  }

  // Parse raw chapters response to ensure errcode == -2041
  let chaptersRawJson;
  try {
    chaptersRawJson = JSON.parse(chaptersRawBytes.toString('utf8'));
  } catch {
    throw Error('chapters_raw_invalid_json');
  }
  const chaptersErrCode = chaptersRawJson.errcode ?? chaptersRawJson.errCode;
  if (chaptersErrCode !== -2041) {
    throw Error('chapters_errcode_not_2041');
  }

  return {
    markerSha256: digest(fs.readFileSync(attemptMarkerPath)),
    chaptersRawSha256: rawSha,
    markerCount: marker.params.count,
  };
}

function validatePreflight(customPaths = {}, options = {}) {
  const env = options.env || process.env;
  environmentGate(env);

  const paths = { ...DEFAULT_PATHS, ...customPaths };
  if (!paths.diagnosticsFile && paths.artifactFile) {
    paths.diagnosticsFile = path.resolve(
      path.dirname(paths.artifactFile),
      'manual-verification-diagnostics.json',
    );
  }
  const rootDir = options.rootDir || path.resolve(ROOT, 'private-data');

  // Assert paths within allowed roots using shared assertSafePath
  for (const [key, p] of Object.entries(paths)) {
    if (typeof p === 'string' && key !== 'cache') {
      assertSafePath(p, rootDir);
    }
  }

  // 1. Session and login result verification using shared validateCredentials
  if (!fs.existsSync(paths.session)) {
    throw Error('session_missing');
  }
  if (!fs.existsSync(paths.loginResult)) {
    throw Error('login_result_missing');
  }
  const session = readJson(paths.session);
  const loginResult = readJson(paths.loginResult);
  validateCredentials(session, loginResult);
  if (loginResult.productionUnchanged !== true) {
    throw Error('login_source_not_verified');
  }

  if (session.requestedScope !== OFFICIAL_READER_SCOPE) {
    throw Error('requested_scope_mismatch');
  }

  const expectedBinding = digest(
    `${session.accountId}:${session.mobile.accessToken}`,
  );

  // 2. Re-verify owner09 scope evidence and baseline proof
  verifyOwner09ScopeEvidence(paths, session, expectedBinding);

  // 3. Verify attempt marker and stopped -2041 proof
  const stoppedProof = verifyStoppedChaptersProof(paths, expectedBinding);

  // 4. Existing ledgers check
  if (fs.existsSync(paths.artifactFile)) {
    throw Error('artifact_already_exists');
  }
  if (fs.existsSync(paths.startLedgerFile)) {
    throw Error('start_ledger_already_exists');
  }

  return {
    status: 'preflight_ok',
    appId: SOURCE_APP_ID,
    targetBookId: TARGET_BOOK_ID,
    sessionName: SESSION_NAME,
    attemptMarkerBound: true,
    attemptMarkerSha256: stoppedProof.markerSha256,
    sessionBinding: expectedBinding,
    chaptersRawSha256: stoppedProof.chaptersRawSha256,
    chaptersErrCode: -2041,
    compatibility: 'UNVERIFIED',
    upstreamRequests: 0,
    productionWrites: 0,
  };
}

function clientScript(nonce, base, canonicalSdkUrl, sourceAppId) {
  const btn = document.getElementById('btn-start');
  const statusDiv = document.getElementById('status');
  const diagBox = document.getElementById('diag-box');
  let requested = false;

  function sanitizeDirective(d) {
    if (!d) return '';
    try {
      return String(d)
        .trim()
        .split(/[\s;]/)[0]
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 64);
    } catch {
      return '';
    }
  }

  function sanitizeUrl(u) {
    if (!u) return '';
    const s = String(u).trim();
    if (/^(data|javascript|blob):/i.test(s)) {
      const m = s.match(/^([a-zA-Z]+):/);
      return m ? m[1].toLowerCase() + ':' : '';
    }
    try {
      const parsed = new URL(s);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.protocol + '//' + parsed.host + parsed.pathname;
      }
      return parsed.protocol;
    } catch {
      if (s.startsWith('/')) {
        return s.split('?')[0].split('#')[0].slice(0, 256);
      }
      return '';
    }
  }

  function sanitizeText(str, extraTokens = []) {
    if (typeof str !== 'string') return '';
    let text = str;
    if (nonce) text = text.split(nonce).join('[REDACTED_NONCE]');
    for (const tok of extraTokens) {
      if (tok && typeof tok === 'string') {
        text = text.split(tok).join('[REDACTED_SECRET]');
      }
    }
    text = text.replace(/trerror_[a-zA-Z0-9_-]+/gi, '[REDACTED_TICKET]');
    text = text.replace(/https?:\/\/[^\s"'<>]+/gi, function (u) {
      return sanitizeUrl(u);
    });
    return text
      .replace(/[\r\n\x00-\x1f\x7f]/g, ' ')
      .slice(0, 256)
      .trim();
  }

  function addDiagEntry(title, details) {
    if (!diagBox) return;
    diagBox.style.display = 'block';
    const item = document.createElement('div');
    item.className = 'diag-item';
    item.textContent = title + (details ? ': ' + details : '');
    diagBox.appendChild(item);
  }

  async function sendDiagnostics(eventData) {
    try {
      await fetch('/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, event: eventData }),
      });
    } catch {
      // Local silent fallback
    }
  }

  // 1. Registered BEFORE SDK load: securitypolicyviolation
  document.addEventListener('securitypolicyviolation', function (e) {
    const cleanUri = sanitizeUrl(e.blockedURI);
    const effDir = sanitizeDirective(e.effectiveDirective);
    const violDir = sanitizeDirective(e.violatedDirective);
    const detail = (effDir || violDir) + (cleanUri ? ' ' + cleanUri : '');
    addDiagEntry('CSP 策略拦截', detail);
    sendDiagnostics({
      type: 'securitypolicyviolation',
      blockedURI: cleanUri,
      violatedDirective: violDir,
      effectiveDirective: effDir,
      sourceFile: sanitizeUrl(e.sourceFile),
      lineNumber: e.lineNumber,
      columnNumber: e.columnNumber,
      statusCode: e.statusCode,
      timestamp: new Date().toISOString(),
    });
  });

  // 2. Registered BEFORE SDK load: unhandled script error
  window.addEventListener('error', function (e) {
    const cleanFile = sanitizeUrl(e.filename);
    const msg = sanitizeText(String(e.message || ''));
    addDiagEntry(
      '脚本异常',
      msg + (cleanFile ? ' (' + cleanFile + ':' + e.lineno + ')' : ''),
    );
    sendDiagnostics({
      type: 'error',
      message: msg,
      filename: cleanFile,
      lineno: e.lineno,
      colno: e.colno,
      timestamp: new Date().toISOString(),
    });
  });

  function updateStatus(text, className) {
    statusDiv.textContent = text;
    statusDiv.className = 'status-box ' + className;
  }

  async function sendCallback(payload) {
    try {
      const res = await fetch('/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, ...payload }),
      });
      return await res.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  btn.addEventListener('click', function () {
    if (requested) return;
    requested = true;
    btn.disabled = true;
    updateStatus('正在调起安全验证...', 'status-running');

    let captchaInstance = null;
    let callbackConsumed = false;

    function terminateSdk() {
      if (captchaInstance && typeof captchaInstance.destroy === 'function') {
        try {
          captchaInstance.destroy();
        } catch (_) {}
      }
      try {
        const ids = [
          'tcaptcha_transform_dy',
          'tcaptcha_iframe_dy',
          'tcaptcha_transform_drag',
          'tcaptcha_iframe_drag',
          'tcaptcha_transform',
          'tcaptcha_iframe',
        ];
        for (let k = 0; k < ids.length; k++) {
          const el = document.getElementById(ids[k]);
          if (el && el.parentNode) {
            el.parentNode.removeChild(el);
          }
        }
      } catch (_) {}
    }

    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = canonicalSdkUrl;

    script.onload = function () {
      try {
        if (typeof TencentCaptcha !== 'function') {
          throw new Error('TencentCaptcha 构造器未定义');
        }
        captchaInstance = new TencentCaptcha(
          sourceAppId,
          async function (res) {
            if (callbackConsumed) return;
            callbackConsumed = true;

            const ret = res && Number.isInteger(res.ret) ? res.ret : -1;
            const rawErr = res ? (res.errorCode ?? res.errCode) : undefined;
            let errorCode;
            if (rawErr !== undefined) {
              if (Number.isInteger(rawErr)) {
                errorCode = rawErr;
              } else if (typeof rawErr === 'string' && /^-?\d+$/.test(rawErr)) {
                errorCode = parseInt(rawErr, 10);
              } else {
                errorCode = -1; // Explicit invalid type: strictly fail-closed!
              }
            } else {
              errorCode = res && res.ret === 0 ? 0 : -1;
            }

            const ticket =
              res && typeof res.ticket === 'string' ? res.ticket : '';
            const randstr =
              res && typeof res.randstr === 'string' ? res.randstr : '';
            const returnedAppId =
              res && res.appid !== undefined ? String(res.appid) : undefined;
            const isFallback = ticket.startsWith('trerror_') || errorCode !== 0;

            const rawSdkMsg = res
              ? (res.errorMessage ??
                res.errMessage ??
                res.errMsg ??
                res.message)
              : undefined;
            const sanitizedSdkMsg =
              typeof rawSdkMsg === 'string'
                ? sanitizeText(rawSdkMsg, [ticket, randstr])
                : '';

            try {
              if (ret === 0 && !isFallback && ticket && randstr) {
                updateStatus('正在保存验证凭据...', 'status-running');
                const cbRes = await sendCallback({
                  ret: 0,
                  errorCode: 0,
                  ticket,
                  randstr,
                  appid: returnedAppId,
                });
                if (cbRes && cbRes.success) {
                  updateStatus(
                    '✅ 验证凭据已保存，公众号文章列表仍待验证（未验证文章列表或恢复订阅）。请关闭此页面。',
                    'status-success',
                  );
                } else {
                  updateStatus(
                    '❌ 凭据保存失败：' +
                      (cbRes?.reason || '未知错误') +
                      '。流程停止。',
                    'status-error',
                  );
                  addDiagEntry('凭据保存失败', cbRes?.reason || '未知错误');
                }
              } else if (ret === 2) {
                updateStatus(
                  '⚠️ 用户主动关闭了验证码。流程停止。',
                  'status-idle',
                );
                addDiagEntry('SDK 状态', '用户主动关闭验证码 (ret=2)');
                sendDiagnostics({
                  type: 'sdk_callback',
                  ret: 2,
                  errorCode: errorCode,
                  errorMessage: sanitizedSdkMsg || 'USER_CANCELLED',
                  timestamp: new Date().toISOString(),
                });
                await sendCallback({
                  ret: 2,
                  errorCode,
                  message: 'USER_CANCELLED',
                  errorMessage: sanitizedSdkMsg || undefined,
                  appid: returnedAppId,
                });
              } else {
                const fallbackReason = isFallback
                  ? 'FALLBACK_TICKET_REJECTED'
                  : 'SDK_REFUSAL_OR_ERROR';
                const displayDesc = sanitizedSdkMsg
                  ? fallbackReason + ': ' + sanitizedSdkMsg
                  : fallbackReason;
                updateStatus(
                  '❌ 验证码服务被拒绝或返回错误（errorCode=' +
                    errorCode +
                    '）。流程停止。',
                  'status-error',
                );
                addDiagEntry(
                  'SDK 拒绝或返回错误',
                  'ret=' +
                    ret +
                    ', errorCode=' +
                    errorCode +
                    ' (' +
                    displayDesc +
                    ')',
                );
                sendDiagnostics({
                  type: 'sdk_callback',
                  ret: ret,
                  errorCode: errorCode,
                  errorMessage: sanitizedSdkMsg || fallbackReason,
                  timestamp: new Date().toISOString(),
                });
                await sendCallback({
                  ret,
                  errorCode,
                  ticket,
                  randstr,
                  appid: returnedAppId,
                  message: fallbackReason,
                  errorMessage: sanitizedSdkMsg || undefined,
                });
              }
            } finally {
              terminateSdk();
            }
          },
          {},
        );
        captchaInstance.show();
      } catch (err) {
        callbackConsumed = true;
        terminateSdk();
        const cleanErrMsg = sanitizeText(err.message || '');
        updateStatus('❌ 验证码初始化异常。流程停止。', 'status-error');
        addDiagEntry('SDK 初始化异常', cleanErrMsg);
        sendDiagnostics({
          type: 'error',
          message: cleanErrMsg,
          timestamp: new Date().toISOString(),
        });
        sendCallback({
          ret: -99,
          errorCode: -99,
          error: cleanErrMsg,
          message: 'SDK_INIT_EXCEPTION',
        });
      }
    };

    script.onerror = function () {
      callbackConsumed = true;
      terminateSdk();
      updateStatus('❌ 加载官方 TCaptcha.js 失败。流程停止。', 'status-error');
      addDiagEntry('SDK 脚本加载失败', canonicalSdkUrl);
      sendDiagnostics({
        type: 'script_error',
        message: 'SCRIPT_LOAD_FAILED',
        filename: canonicalSdkUrl,
        timestamp: new Date().toISOString(),
      });
      sendCallback({
        ret: -98,
        errorCode: -98,
        error: 'SCRIPT_LOAD_FAILED',
        message: 'SCRIPT_LOAD_FAILED',
      });
    };

    document.head.appendChild(script);
  });
}

function renderHtml(nonce, base) {
  // NOTE: Initial page contains NO external scripts or remote images.
  // Canonical v1.0 TCaptcha.js is injected dynamically ONLY upon owner explicit button click.
  // UI describes only user goal, status, and button, avoiding internal implementation details.
  const scriptContent = `(${clientScript.toString()})(${JSON.stringify(nonce)}, ${JSON.stringify(base)}, ${JSON.stringify(CANONICAL_SDK_URL)}, ${JSON.stringify(SOURCE_APP_ID)});`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>安全验证</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
    .card { max-width: 520px; margin: 60px auto; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    h1 { font-size: 20px; margin-top: 0; color: #0f172a; }
    p { font-size: 14px; line-height: 1.6; color: #475569; }
    .status-box { padding: 14px; border-radius: 6px; margin: 20px 0; font-size: 14px; font-weight: 500; }
    .status-idle { background: #f8fafc; border: 1px solid #cbd5e1; color: #475569; }
    .status-running { background: #eff6ff; border: 1px solid #93c5fd; color: #1d4ed8; }
    .status-success { background: #f0fdf4; border: 1px solid #86efac; color: #15803d; }
    .status-error { background: #fef2f2; border: 1px solid #fca5a5; color: #b91c1c; }
    .diag-box { margin-top: 20px; padding: 14px; background: #fff1f2; border: 1px solid #fecdd3; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #9f1239; word-break: break-all; text-align: left; }
    .diag-title { font-weight: 600; margin-bottom: 6px; }
    .diag-item { margin-top: 6px; padding-top: 6px; border-top: 1px dashed #fecdd3; }
    button { background: #0284c7; color: white; border: none; border-radius: 6px; padding: 12px 24px; font-size: 15px; font-weight: 600; cursor: pointer; width: 100%; transition: background 0.2s; }
    button:hover { background: #0369a1; }
    button:disabled { background: #94a3b8; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="card">
    <h1>安全验证</h1>
    <p>请完成腾讯安全验证以解除公众号列表访问限制。</p>

    <div id="status" class="status-box status-idle">
      服务就绪。点击下方按钮前，本服务未向任何外部服务器发送请求。
    </div>

    <button id="btn-start" type="button">开始安全验证</button>

    <div id="diag-box" class="diag-box" style="display: none;">
      <div class="diag-title">诊断信息</div>
    </div>
  </div>

  <script nonce="${nonce}">${scriptContent}</script>
</body>
</html>`;
}

function createVerificationServer({
  port = DEFAULT_PORT,
  customPaths = {},
  rootDir,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onArtifactWritten = () => {},
} = {}) {
  const preflight = validatePreflight(customPaths, { env, rootDir });
  const paths = { ...DEFAULT_PATHS, ...customPaths };
  if (!paths.diagnosticsFile && paths.artifactFile) {
    paths.diagnosticsFile = path.resolve(
      path.dirname(paths.artifactFile),
      'manual-verification-diagnostics.json',
    );
  }

  const nonce = crypto.randomBytes(24).toString('hex');
  const createdAt = Date.now();
  const expiresAt = createdAt + timeoutMs;
  let consumed = false;
  let state = {
    state: 'idle',
    compatibility: 'UNVERIFIED',
    upstreamRequests: 0,
    hasArtifact: false,
  };

  // Write persistent start ledger using wx mode
  fs.writeFileSync(
    paths.startLedgerFile,
    JSON.stringify({
      kind: 'owner-manual-verification-start',
      sessionName: SESSION_NAME,
      targetBookId: TARGET_BOOK_ID,
      appId: SOURCE_APP_ID,
      startedAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      nonceHash: digest(nonce),
      sessionBinding: preflight.sessionBinding,
      attemptMarkerSha256: preflight.attemptMarkerSha256,
      chaptersRawSha256: preflight.chaptersRawSha256,
      consumed: false,
    }),
    { flag: 'wx', mode: 0o600 },
  );

  let server;
  let base;
  let timer;

  const app = (req, res) => {
    const host = req.headers.host;
    if (host !== new URL(base).host) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, reason: 'HOST_MISMATCH' }));
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}' https://turing.captcha.qcloud.com https://ssl.captcha.qq.com https://turing.captcha.gtimg.com; frame-src https://turing.captcha.qcloud.com https://ssl.captcha.qq.com https://captcha.gtimg.com; connect-src 'self' https://turing.captcha.qcloud.com https://ssl.captcha.qq.com; img-src 'self' https://turing.captcha.qcloud.com https://ssl.captcha.qq.com https://captcha.gtimg.com data:; style-src 'unsafe-inline'; worker-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );

    if (req.method === 'GET' && req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(renderHtml(nonce, base));
    } else if (req.method === 'GET' && req.url === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      // NOTE: Do NOT expose nonce in status
      res.end(
        JSON.stringify({
          ...state,
          expiresAt: new Date(expiresAt).toISOString(),
          consumed,
        }),
      );
    } else if (req.method === 'POST' && req.url === '/callback') {
      // Require exact Origin header matching loopback base
      const origin = req.headers.origin;
      if (!origin || origin !== base) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, reason: 'ORIGIN_MISMATCH' }));
        return;
      }

      // Require application/json content-type
      const ct = req.headers['content-type'] || '';
      if (!ct.toLowerCase().startsWith('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: false,
            reason: 'CONTENT_TYPE_INVALID',
          }),
        );
        return;
      }

      let body = '';
      let destroyed = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
          destroyed = true;
          req.destroy();
        }
      });

      req.on('end', () => {
        if (destroyed) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, reason: 'BODY_OVERSIZED' }));
          return;
        }

        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, reason: 'INVALID_JSON' }));
          return;
        }

        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ success: false, reason: 'INVALID_JSON_OBJECT' }),
          );
          return;
        }

        if (payload.nonce !== nonce) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, reason: 'NONCE_INVALID' }));
          return;
        }

        if (Date.now() > expiresAt) {
          res.writeHead(410, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ success: false, reason: 'SESSION_EXPIRED' }),
          );
          return;
        }

        if (consumed) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              reason: 'LEDGER_ALREADY_CONSUMED',
            }),
          );
          return;
        }

        let ret;
        if (Number.isInteger(payload.ret)) {
          ret = payload.ret;
        } else if (
          typeof payload.ret === 'string' &&
          /^-?\d+$/.test(payload.ret)
        ) {
          ret = Number(payload.ret);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ success: false, reason: 'RET_TYPE_INVALID' }),
          );
          return;
        }

        let errorCode;
        const rawErrorCode =
          payload.errorCode !== undefined
            ? payload.errorCode
            : payload.errCode !== undefined
              ? payload.errCode
              : 0;
        if (Number.isInteger(rawErrorCode)) {
          errorCode = rawErrorCode;
        } else if (
          typeof rawErrorCode === 'string' &&
          /^-?\d+$/.test(rawErrorCode)
        ) {
          errorCode = Number(rawErrorCode);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              reason: 'ERROR_CODE_TYPE_INVALID',
            }),
          );
          return;
        }

        const ticket = typeof payload.ticket === 'string' ? payload.ticket : '';
        const randstr =
          typeof payload.randstr === 'string' ? payload.randstr : '';
        const returnedAppId =
          payload.appid !== undefined ? String(payload.appid) : null;

        // If appid returned by SDK, verify exact configured ID (absent in old v1 is okay)
        if (returnedAppId !== null && returnedAppId !== SOURCE_APP_ID) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, reason: 'APPID_MISMATCH' }));
          return;
        }

        const isFallbackTicket = ticket.startsWith('trerror_');

        if (ret === 0 && errorCode === 0 && !isFallbackTicket) {
          if (!isValidToken(ticket, 2048)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ success: false, reason: 'TICKET_INVALID' }),
            );
            return;
          }
          if (!isValidToken(randstr, 512)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ success: false, reason: 'RANDSTR_INVALID' }),
            );
            return;
          }
        }

        const isGenuineSuccess =
          ret === 0 && errorCode === 0 && !isFallbackTicket;

        if (isGenuineSuccess) {
          consumed = true;

          const artifact = {
            kind: 'owner-manual-verification-artifact',
            sessionName: SESSION_NAME,
            targetBookId: TARGET_BOOK_ID,
            appId: SOURCE_APP_ID,
            success: true,
            ret: 0,
            errorCode: 0,
            nonceHash: digest(nonce),
            boundAttemptMarker: paths.attemptMarker,
            attemptMarkerSha256: preflight.attemptMarkerSha256,
            sessionBinding: preflight.sessionBinding,
            chaptersRawSha256: preflight.chaptersRawSha256,
            verifiedAt: new Date().toISOString(),
            compatibility: 'UNVERIFIED_PENDING_UPSTREAM_ACCEPTANCE',
            consumed: false,
            ticket,
            randstr,
          };

          try {
            // Write artifact with wx mode (fail closed if exists)
            fs.writeFileSync(paths.artifactFile, JSON.stringify(artifact), {
              mode: 0o600,
              flag: 'wx',
            });
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: false,
                reason: 'ARTIFACT_PERSISTENCE_FAILED',
              }),
            );
            return;
          }

          state = {
            state: 'verified',
            compatibility: 'UNVERIFIED_PENDING_UPSTREAM_ACCEPTANCE',
            upstreamRequests: 0,
            hasArtifact: true,
          };

          onArtifactWritten(artifact);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, state: 'verified' }));

          setTimeout(() => {
            if (server) server.close();
          }, 10000).unref();
        } else {
          // Failure / refusal / fallback branch:
          // Strictly reject trerror_ tickets or nonzero errorCode.
          // Preserve ONLY failure metadata. NO accepted ticket artifact!
          consumed = true;

          const failureReason =
            ret === 2
              ? 'USER_CANCELLED'
              : isFallbackTicket
                ? `FALLBACK_TICKET_REJECTED_${errorCode || 'TRERROR'}`
                : errorCode !== 0
                  ? `SDK_ERROR_CODE_${errorCode}`
                  : payload.message || payload.error || `RET_${ret}`;

          const rawSdkMsg = payload.errorMessage || payload.errMsg;
          const sanitizedSdkMsg =
            typeof rawSdkMsg === 'string'
              ? sanitizeDiagnosticText(rawSdkMsg, { nonce, ticket, randstr })
              : undefined;

          const failureArtifact = {
            kind: 'owner-manual-verification-artifact',
            sessionName: SESSION_NAME,
            targetBookId: TARGET_BOOK_ID,
            appId: SOURCE_APP_ID,
            success: false,
            ret,
            errorCode,
            errorMessage: sanitizedSdkMsg,
            nonceHash: digest(nonce),
            sessionBinding: preflight.sessionBinding,
            verifiedAt: new Date().toISOString(),
            compatibility: 'UNVERIFIED',
            refusalReason: failureReason,
            ticketPrefix: isFallbackTicket ? 'trerror_' : undefined,
            consumed: true,
          };

          try {
            fs.writeFileSync(
              paths.artifactFile,
              JSON.stringify(failureArtifact),
              {
                mode: 0o600,
                flag: 'wx',
              },
            );
          } catch {
            // Fail closed
          }

          state = {
            state: 'stopped',
            compatibility: 'UNVERIFIED',
            upstreamRequests: 0,
            hasArtifact: true,
            reason: failureReason,
          };

          onArtifactWritten(failureArtifact);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              state: 'stopped',
              reason: failureReason,
            }),
          );
        }
      });
    } else if (req.method === 'POST' && req.url === '/diagnostics') {
      const origin = req.headers.origin;
      if (!origin || origin !== base) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, reason: 'ORIGIN_MISMATCH' }));
        return;
      }

      const ct = req.headers['content-type'] || '';
      if (!ct.toLowerCase().startsWith('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: false,
            reason: 'CONTENT_TYPE_INVALID',
          }),
        );
        return;
      }

      let body = '';
      let destroyed = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
          destroyed = true;
          req.destroy();
        }
      });

      req.on('end', () => {
        if (destroyed) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, reason: 'BODY_OVERSIZED' }));
          return;
        }

        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, reason: 'INVALID_JSON' }));
          return;
        }

        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ success: false, reason: 'INVALID_JSON_OBJECT' }),
          );
          return;
        }

        if (payload.nonce !== nonce) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, reason: 'NONCE_INVALID' }));
          return;
        }

        if (Date.now() > expiresAt) {
          res.writeHead(410, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ success: false, reason: 'SESSION_EXPIRED' }),
          );
          return;
        }

        const sanitizedEvent = sanitizeDiagnosticEvent(
          payload.event || payload,
          { nonce },
        );
        if (!sanitizedEvent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              reason: 'INVALID_DIAGNOSTIC_EVENT',
            }),
          );
          return;
        }

        try {
          fs.mkdirSync(path.dirname(paths.diagnosticsFile), {
            recursive: true,
          });
          let diagRecord;
          if (fs.existsSync(paths.diagnosticsFile)) {
            try {
              diagRecord = JSON.parse(
                fs.readFileSync(paths.diagnosticsFile, 'utf8'),
              );
            } catch {
              diagRecord = {
                kind: 'owner-manual-verification-diagnostics',
                sessionName: SESSION_NAME,
                targetBookId: TARGET_BOOK_ID,
                appId: SOURCE_APP_ID,
                events: [],
              };
            }
          } else {
            diagRecord = {
              kind: 'owner-manual-verification-diagnostics',
              sessionName: SESSION_NAME,
              targetBookId: TARGET_BOOK_ID,
              appId: SOURCE_APP_ID,
              events: [],
            };
          }
          diagRecord.events.push(sanitizedEvent);
          fs.writeFileSync(
            paths.diagnosticsFile,
            JSON.stringify(diagRecord, null, 2),
            { mode: 0o600 },
          );
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              reason: 'DIAGNOSTICS_PERSISTENCE_FAILED',
            }),
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, reason: 'NOT_FOUND' }));
    }
  };

  server = http.createServer(app);

  const start = async () => {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;

    timer = setTimeout(() => {
      state = { ...state, state: 'expired' };
      if (server) server.close();
    }, timeoutMs).unref();

    return {
      base,
      port: addr.port,
      preflight,
      close: () =>
        new Promise((resolve) => {
          clearTimeout(timer);
          server.close(resolve);
        }),
    };
  };

  return {
    server,
    start,
    getState: () => ({ ...state }),
    getNonce: () => nonce,
  };
}

function parseCliArgs(argv) {
  const flags = {
    plan: false,
    preflight: false,
    serve: false,
    port: DEFAULT_PORT,
  };

  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) {
      throw Error(`duplicate_flag: ${arg}`);
    }
    seen.add(arg);

    if (arg === '--plan') {
      flags.plan = true;
    } else if (arg === '--preflight') {
      flags.preflight = true;
    } else if (arg === '--serve') {
      flags.serve = true;
    } else if (arg === '--port') {
      const val = argv[++i];
      if (!val || !/^[1-9]\d*$/.test(val)) {
        throw Error('invalid_port');
      }
      const p = parseInt(val, 10);
      if (p < 1 || p > 65535) {
        throw Error('invalid_port');
      }
      flags.port = p;
    } else {
      throw Error(`unknown_flag: ${arg}`);
    }
  }

  const actions = [flags.plan, flags.preflight, flags.serve].filter(Boolean);
  if (actions.length !== 1) {
    throw Error('must_specify_exactly_one_action');
  }

  return flags;
}

async function main() {
  const flags = parseCliArgs(process.argv.slice(2));

  if (flags.plan) {
    console.log(
      JSON.stringify(
        {
          action: 'serve-owner-manual-verify',
          appId: SOURCE_APP_ID,
          targetBookId: TARGET_BOOK_ID,
          sessionName: SESSION_NAME,
          boundAttemptMarker:
            'private-data/list-discovery-20261002/mp-chapters-owner09-attempt.json',
          canonicalSdkUrl: CANONICAL_SDK_URL,
          compatibility: 'UNVERIFIED',
          requestsBeforeClick: 0,
          productionWrites: 0,
          listRefetchIncluded: false,
        },
        null,
        2,
      ),
    );
    return;
  }

  environmentGate(process.env);

  if (flags.preflight) {
    try {
      const pf = validatePreflight();
      console.log(JSON.stringify(pf, null, 2));
    } catch (err) {
      console.log(
        JSON.stringify(
          {
            status: 'preflight_failed',
            reason: sanitizeErrorReason(err),
            upstreamRequests: 0,
            productionWrites: 0,
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
    }
    return;
  }

  if (flags.serve) {
    const pf = validatePreflight();
    const instance = createVerificationServer({ port: flags.port });
    const { base, port } = await instance.start();

    console.log(
      JSON.stringify(
        {
          status: 'listening',
          base,
          port,
          appId: SOURCE_APP_ID,
          targetBookId: TARGET_BOOK_ID,
          canonicalSdkUrl: CANONICAL_SDK_URL,
          compatibility: 'UNVERIFIED',
          requestsBeforeClick: 0,
          productionWrites: 0,
          note: 'Waiting for owner interaction. Click opens Tencent TCaptcha.js.',
        },
        null,
        2,
      ),
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(JSON.stringify({ error: err.message || 'unexpected_error' }));
    process.exit(1);
  });
}

module.exports = {
  SOURCE_APP_ID,
  TARGET_BOOK_ID,
  SESSION_NAME,
  CANONICAL_SDK_URL,
  DEFAULT_PATHS,
  validatePreflight,
  sanitizeErrorReason,
  verifyStoppedChaptersProof,
  renderHtml,
  createVerificationServer,
  parseCliArgs,
  assertSafePath,
  validateCredentials,
  OFFICIAL_READER_SCOPE,
  sanitizeDiagnosticEvent,
  sanitizeDirectiveName,
  sanitizeDiagnosticUrl,
  sanitizeDiagnosticText,
};
