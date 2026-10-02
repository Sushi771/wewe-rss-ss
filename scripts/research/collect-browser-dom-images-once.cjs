#!/usr/bin/env node
'use strict';

/**
 * One-shot image cache collector for the owner-confirmed browser DOM article WX_3895431412_2247493594_1.
 *
 * Strict safety rules:
 * 1. Validates DOM hash (SHA-256) and article identity before touching any image URL.
 * 2. Extracts unique allowed image URLs (restricted strictly to https://mmbiz.qpic.cn/).
 * 3. Paced: minimum 1 request per second between consecutive requests.
 * 4. Zero retries: single attempt per URL.
 * 5. Stops permanently on first auth/challenge/non-image/redirect/failure.
 * 6. Persists each validated image bytes and SHA-256 in gitignored private directory durably (fsync).
 * 7. Records a one-shot marker atomically so rerun cannot silently duplicate requests.
 * 8. Review gate: requires explicit --execute flag for live requests; otherwise dry-run inspect mode.
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '../..');
const serverDir = path.join(ROOT, 'apps/server');
const serverRequire = createRequire(path.join(serverDir, 'package.json'));
const cheerio = serverRequire('cheerio');

const TARGET_ARTICLE_ID = 'WX_3895431412_2247493594_1';
const TARGET_MP_ID = 'MP_WXS_3895431412';
const EXPECTED_DOM_SHA256 =
  'cdd899b86d9a68efc2637a43d824954611b6b642b188b17fa33ea704541ca89d';
const ALLOWED_IMAGE_HOST = 'mmbiz.qpic.cn';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB limit
const DEFAULT_PACE_MS = 1000;
const TIMEOUT_MS = 10_000;

// Console output and thrown errors contain fixed codes only. Raw image URLs
// belong in the private cache manifest, never in public diagnostics.
const ERROR_CODES = new Set([
  'DOM_HTML_MISSING',
  'ACCESS_CHALLENGE_DETECTED_IN_DOM',
  'INVALID_DOM_OBSERVATION_KIND',
  'OBSERVATION_ARTICLE_ID_MISMATCH',
  'SELECTION_ARTICLE_ID_MISMATCH',
  'DOM_HASH_MISMATCH_EXPECTED',
  'DOM_HASH_MISMATCH_OBSERVATION',
  'FAILED_TO_PARSE_ARTICLE_IDENTITY',
  'IDENTITY_CONFLICT_WITH_TARGET',
  'INVALID_IMAGE_URL_FORMAT',
  'UNALLOWED_PROTOCOL',
  'UNALLOWED_HOST',
  'UNALLOWED_URL_COMPONENTS',
  'NO_CONTENT_HTML_IN_DOM',
  'REDIRECT_STOPPED',
  'AUTH_CHALLENGE_STOPPED',
  'HTTP_STATUS_STOPPED',
  'NON_IMAGE_CONTENT_TYPE',
  'IMAGE_EXCEEDS_SIZE_LIMIT',
  'IMAGE_SIZE_OVERFLOW',
  'INCOMPLETE_BODY_RECEIVED',
  'ACCESS_CHALLENGE_DETECTED_IN_BODY',
  'INVALID_IMAGE_SIGNATURE',
  'RESPONSE_STREAM_ERROR',
  'NETWORK_REQUEST_ERROR',
  'REQUEST_TIMEOUT',
  'ONE_SHOT_ALREADY_RECORDED',
  'DOM_FILE_NOT_FOUND',
  'OBSERVATION_FILE_NOT_FOUND',
  'SELECTION_FILE_NOT_FOUND',
  'COLLECTION_PERMANENTLY_STOPPED',
  'TEST_EVIDENCE_OVERRIDE_FORBIDDEN',
  'TEST_EXECUTION_REQUIRES_OFFLINE_FETCH',
  'INVALID_IMAGE_RESULT',
  'CLI_ARGUMENTS_INVALID',
  'SERVER_BUILD_REQUIRED',
  'SERVER_BUILD_MODULE_FAILED',
  'IMAGE_CACHE_CONFLICT',
  'RAW_IMAGE_EQUIVALENCE_FAILED',
]);

function publicErrorCode(error) {
  const msg = String(error?.message || '');
  const match = /^([A-Z][A-Z0-9_]+)(?::\s*([A-Z][A-Z0-9_]+))?/.exec(msg);
  if (!match) return 'COLLECTOR_IO_OR_CONFIGURATION_ERROR';
  const primary = match[1];
  const secondary = match[2];
  if (!ERROR_CODES.has(primary)) return 'COLLECTOR_IO_OR_CONFIGURATION_ERROR';
  if (secondary && ERROR_CODES.has(secondary)) {
    return `${primary}: ${secondary}`;
  }
  return primary;
}

function expectedDomHash(testExpectedHash) {
  if (testExpectedHash === undefined) return EXPECTED_DOM_SHA256;
  if (
    !process.env.NODE_TEST_CONTEXT ||
    !/^[a-f0-9]{64}$/.test(testExpectedHash)
  )
    throw new Error('TEST_EVIDENCE_OVERRIDE_FORBIDDEN');
  return testExpectedHash;
}

function serverCollectionModule(name) {
  const file = path.join(
    serverDir,
    `dist/apps/server/src/collection/${name}.js`,
  );
  if (!fs.existsSync(file)) throw new Error('SERVER_BUILD_REQUIRED');
  try {
    return require(file);
  } catch {
    throw new Error('SERVER_BUILD_MODULE_FAILED');
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function durableWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = JSON.stringify(data, null, 2);
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Fail closed if atomic replacement fails; keep the previous one-shot marker.
  fs.renameSync(tmpPath, filePath);
}

function durableWriteBytes(filePath, bytes) {
  if (fs.existsSync(filePath)) {
    // Distinct URLs may return identical bytes, but an old corrupt file cannot
    // become verified simply because its filename contains the expected hash.
    if (!fs.readFileSync(filePath).equals(bytes))
      throw new Error('IMAGE_CACHE_CONFLICT');
    return;
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

function validateImageSignature(bytes, mimeType) {
  // Share bounded container checks with the offline adapter so collection and
  // later archive replay apply the same truncated-image rejection rules.
  const { validateImageSignature: verifyImageBytes } = serverCollectionModule(
    'browser-dom-adapter',
  );
  return verifyImageBytes(bytes, String(mimeType || '').toLowerCase());
}

function validateDomEvidence({
  domHtml,
  observation,
  selection,
  testExpectedHash,
}) {
  if (!domHtml || typeof domHtml !== 'string') {
    throw new Error('DOM_HTML_MISSING');
  }

  const $ = cheerio.load(domHtml);
  if (
    $(
      'iframe[src*="captcha."],form[action*="/mp/verify"],#js_verify,#verify,.weui_msg',
    ).length ||
    /<title[^>]*>[^<]*(?:验证码|请完成验证|访问过于频繁|安全验证|环境异常)|wappoc_appmsgcaptcha|verify\.html/i.test(
      domHtml,
    )
  ) {
    throw new Error('ACCESS_CHALLENGE_DETECTED_IN_DOM');
  }

  if (!observation || observation.kind !== 'owner-confirmed-browser-dom') {
    throw new Error('INVALID_DOM_OBSERVATION_KIND');
  }
  if (observation.id !== TARGET_ARTICLE_ID) {
    throw new Error('OBSERVATION_ARTICLE_ID_MISMATCH');
  }
  if (selection && selection.candidate?.id !== TARGET_ARTICLE_ID) {
    throw new Error('SELECTION_ARTICLE_ID_MISMATCH');
  }

  const computedHash = sha256(domHtml);
  if (computedHash !== expectedDomHash(testExpectedHash)) {
    throw new Error('DOM_HASH_MISMATCH_EXPECTED');
  }
  if (computedHash !== observation.sha256) {
    throw new Error('DOM_HASH_MISMATCH_OBSERVATION');
  }

  const { articleIdentity } = serverCollectionModule('article-page');
  let identity;
  try {
    identity = articleIdentity(domHtml);
  } catch {
    throw new Error('FAILED_TO_PARSE_ARTICLE_IDENTITY');
  }

  if (identity.id !== TARGET_ARTICLE_ID || identity.mpId !== TARGET_MP_ID) {
    throw new Error('IDENTITY_CONFLICT_WITH_TARGET');
  }

  return {
    articleId: identity.id,
    mpId: identity.mpId,
    domSha256: computedHash,
    canonical: identity.canonical,
  };
}

function validateAllowedImageUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('INVALID_IMAGE_URL_FORMAT');
  }
  if (parsed.protocol !== 'https:') throw new Error('UNALLOWED_PROTOCOL');
  if (parsed.hostname !== ALLOWED_IMAGE_HOST) throw new Error('UNALLOWED_HOST');
  if (parsed.port || parsed.username || parsed.password)
    throw new Error('UNALLOWED_URL_COMPONENTS');
  return parsed;
}

function extractAllowedImageUrls(domHtml) {
  // Use the same first body container as articleContentHtml. Every raw image
  // must survive sanitization with its effective lazy-load source unchanged.
  const $raw = cheerio.load(domHtml);
  const rawImages = $raw('#js_content, .rich_media_content')
    .first()
    .find('img')
    .toArray();
  const expectedSources = [];
  for (const el of rawImages) {
    const rawSrc = $raw(el).attr('data-src') || $raw(el).attr('src') || '';
    if (!rawSrc) throw new Error('RAW_IMAGE_EQUIVALENCE_FAILED');
    if (rawSrc.startsWith('data:')) {
      expectedSources.push(rawSrc);
    } else {
      expectedSources.push(validateAllowedImageUrl(rawSrc).toString());
    }
  }

  const { articleContentHtml } = serverCollectionModule('article-page');
  const contentHtml = articleContentHtml(domHtml);
  if (!contentHtml) {
    throw new Error('NO_CONTENT_HTML_IN_DOM');
  }

  const $ = cheerio.load(contentHtml);
  const imgElements = $('img').toArray();
  if (
    rawImages.length !== imgElements.length ||
    expectedSources.some(
      (source, index) => $(imgElements[index]).attr('src') !== source,
    )
  )
    throw new Error('RAW_IMAGE_EQUIVALENCE_FAILED');
  const occurrences = [];
  const uniqueUrlSet = new Set();
  const uniqueUrls = [];

  for (let i = 0; i < imgElements.length; i++) {
    const rawUrl = $(imgElements[i]).attr('src') || '';
    if (!rawUrl || rawUrl.startsWith('data:')) continue;

    validateAllowedImageUrl(rawUrl);

    // In HTTP GET, fragment is never transmitted. Use normalized URL without fragment for HTTP requests.
    const requestUrl = rawUrl.split('#')[0];
    occurrences.push({
      index: i,
      rawUrl,
      requestUrl,
    });

    if (!uniqueUrlSet.has(requestUrl)) {
      uniqueUrlSet.add(requestUrl);
      uniqueUrls.push(requestUrl);
    }
  }

  return {
    occurrences,
    uniqueUrls,
    totalOccurrences: occurrences.length,
    uniqueCount: uniqueUrls.length,
  };
}

function defaultFetchImage(url) {
  try {
    validateAllowedImageUrl(url);
  } catch (error) {
    return Promise.reject(new Error(publicErrorCode(error)));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const request = https.request(
      url,
      {
        method: 'GET',
        headers: {
          referer: 'https://mp.weixin.qq.com/',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          accept:
            'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      },
      (response) => {
        const status = response.statusCode || 0;

        // Permanent stop on redirect (3xx)
        if (status >= 300 && status < 400) {
          response.destroy();
          finish(new Error(`REDIRECT_STOPPED: HTTP ${status}`));
          return;
        }

        // Permanent stop on auth / challenge
        if (status === 401 || status === 403) {
          response.destroy();
          finish(new Error(`AUTH_CHALLENGE_STOPPED: HTTP ${status}`));
          return;
        }

        if (status !== 200) {
          response.destroy();
          finish(new Error(`HTTP_STATUS_STOPPED: HTTP ${status}`));
          return;
        }

        const rawType = String(response.headers['content-type'] || '')
          .split(';')[0]
          .trim()
          .toLowerCase();

        if (!/^image\/(?:png|jpeg|gif|webp)$/.test(rawType)) {
          response.destroy();
          finish(new Error('NON_IMAGE_CONTENT_TYPE'));
          return;
        }

        const lengthHeader = response.headers['content-length'];
        const declaredLength = lengthHeader ? Number(lengthHeader) : null;
        if (
          declaredLength !== null &&
          (!Number.isSafeInteger(declaredLength) ||
            declaredLength > MAX_IMAGE_BYTES)
        ) {
          response.destroy();
          finish(new Error('IMAGE_EXCEEDS_SIZE_LIMIT'));
          return;
        }

        let bytesReceived = 0;
        const chunks = [];

        response.on('data', (chunk) => {
          bytesReceived += chunk.length;
          if (bytesReceived > MAX_IMAGE_BYTES) {
            response.destroy();
            finish(new Error('IMAGE_SIZE_OVERFLOW'));
            return;
          }
          chunks.push(chunk);
        });

        response.once('end', () => {
          if (declaredLength !== null && declaredLength !== bytesReceived) {
            finish(new Error('INCOMPLETE_BODY_RECEIVED'));
            return;
          }
          const bytes = Buffer.concat(chunks);

          // Check if body accidentally returned HTML challenge
          const snippet = bytes.subarray(0, 512).toString('utf8');
          if (
            /(?:wappoc_appmsgcaptcha|verify\.html|antispam|安全验证|请完成验证)/i.test(
              snippet,
            )
          ) {
            finish(new Error('ACCESS_CHALLENGE_DETECTED_IN_BODY'));
            return;
          }

          if (!validateImageSignature(bytes, rawType)) {
            finish(new Error('INVALID_IMAGE_SIGNATURE'));
            return;
          }

          finish(null, {
            bytes,
            sha256: sha256(bytes),
            mimeType: rawType,
            size: bytes.length,
          });
        });

        response.once('error', () =>
          finish(new Error('RESPONSE_STREAM_ERROR')),
        );
      },
    );

    const timer = setTimeout(() => {
      request.destroy();
      finish(new Error('REQUEST_TIMEOUT'));
    }, TIMEOUT_MS);

    request.once('error', () => finish(new Error('NETWORK_REQUEST_ERROR')));
    request.end();
  }).catch((error) => {
    throw new Error(publicErrorCode(error));
  });
}

function getExtensionForMime(mime) {
  switch (mime.toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '.bin';
  }
}

async function collectBrowserDomImages(options = {}) {
  try {
    return await collectBrowserDomImagesOnce(options);
  } catch (error) {
    // Filesystem/JSON/request exceptions may quote attacker-controlled text.
    // Keep only the known diagnostic code at this public boundary.
    throw new Error(publicErrorCode(error));
  }
}

async function collectBrowserDomImagesOnce(options) {
  const baseDir =
    options.baseDir ||
    path.join(ROOT, 'private-data/single-account-update-20260930');
  const outputDir = options.outputDir || path.join(baseDir, 'image-cache');
  const markerFile =
    options.markerFile || path.join(outputDir, 'image-collector-marker.json');
  const manifestFile =
    options.manifestFile || path.join(outputDir, 'manifest.json');
  const paceMs =
    options.paceMs !== undefined ? options.paceMs : DEFAULT_PACE_MS;
  const execute = Boolean(options.execute);
  const fetchImage = options.fetchImage || defaultFetchImage;
  if (options.testExpectedHash !== undefined) {
    expectedDomHash(options.testExpectedHash);
    if (execute && !options.fetchImage)
      throw new Error('TEST_EXECUTION_REQUIRES_OFFLINE_FETCH');
  }
  const sleep =
    options.sleep ||
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  // 1. One-shot marker check: rerun cannot silently duplicate requests
  if (fs.existsSync(markerFile)) {
    throw new Error('ONE_SHOT_ALREADY_RECORDED');
  }

  // 2. Read and validate DOM evidence
  const domHtmlFile =
    options.domFile || path.join(baseDir, 'official-browser-dom.html');
  const observationFile =
    options.observationFile ||
    path.join(baseDir, 'official-browser-observation.json');
  const selectionFile =
    options.selectionFile ||
    path.join(baseDir, 'official-original-selection.json');

  if (!fs.existsSync(domHtmlFile)) {
    throw new Error('DOM_FILE_NOT_FOUND');
  }
  if (!fs.existsSync(observationFile)) {
    throw new Error('OBSERVATION_FILE_NOT_FOUND');
  }
  if (!fs.existsSync(selectionFile)) {
    throw new Error('SELECTION_FILE_NOT_FOUND');
  }

  const domHtml = fs.readFileSync(domHtmlFile, 'utf8');
  const observation = JSON.parse(fs.readFileSync(observationFile, 'utf8'));
  const selection = JSON.parse(fs.readFileSync(selectionFile, 'utf8'));

  const evidence = validateDomEvidence({
    domHtml,
    observation,
    selection,
    testExpectedHash: options.testExpectedHash,
  });

  // 3. Extract unique allowed image URLs
  const { occurrences, uniqueUrls, totalOccurrences, uniqueCount } =
    extractAllowedImageUrls(domHtml);

  // If dry run, report plan and return without any network requests or marker creation
  if (!execute) {
    return {
      dryRun: true,
      offline: true,
      articleId: evidence.articleId,
      domSha256: evidence.domSha256,
      totalOccurrences,
      uniqueCount,
      imageUrlSha256: uniqueUrls.map(sha256),
      paceMs,
      readyForExecution: true,
      oneShotMarkerCreated: false,
    };
  }

  // 4. Ensure output directory exists and record one-shot marker atomically
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const imagesDir = path.join(outputDir, 'images');
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  // Atomic creation of marker file with 'wx' flag to guard against race conditions
  const initialMarker = {
    status: 'in_progress',
    startedAt: new Date().toISOString(),
    articleId: evidence.articleId,
    domSha256: evidence.domSha256,
    totalOccurrences,
    uniqueCount,
    uniqueUrls,
    completedCount: 0,
  };

  const markerFd = fs.openSync(markerFile, 'wx', 0o600);
  try {
    fs.writeFileSync(markerFd, JSON.stringify(initialMarker, null, 2), 'utf8');
    fs.fsyncSync(markerFd);
  } finally {
    fs.closeSync(markerFd);
  }

  // 5. Paced collection loop with zero retries and permanent stop on first failure
  const collectedMap = new Map();
  const collectedImages = [];

  for (let i = 0; i < uniqueUrls.length; i++) {
    const url = uniqueUrls[i];

    // Pace 1 request per second (no delay before first request)
    if (i > 0 && paceMs > 0) {
      await sleep(paceMs);
    }

    let result;
    try {
      result = await fetchImage(url);
      if (
        !validateImageSignature(result?.bytes, result?.mimeType) ||
        result.sha256 !== sha256(result.bytes) ||
        result.size !== result.bytes.length ||
        result.size > MAX_IMAGE_BYTES
      )
        throw new Error('INVALID_IMAGE_RESULT');
    } catch (err) {
      // Permanent stop on first failure
      const reason = publicErrorCode(err);
      const stopInfo = {
        status: 'stopped',
        stoppedAt: new Date().toISOString(),
        articleId: evidence.articleId,
        stopReason: reason,
        failedUrl: url,
        failedIndex: i,
        completedCount: i,
        totalUrls: uniqueCount,
      };
      durableWriteJson(markerFile, stopInfo);
      throw new Error(`COLLECTION_PERMANENTLY_STOPPED: ${reason}`);
    }

    // Persist validated image bytes durably
    const ext = getExtensionForMime(result.mimeType);
    const fileName = `${result.sha256}${ext}`;
    const filePath = path.join(imagesDir, fileName);
    durableWriteBytes(filePath, result.bytes);

    const record = {
      url,
      sha256: result.sha256,
      mimeType: result.mimeType,
      size: result.size,
      fileName,
      path: path.relative(outputDir, filePath).replace(/\\/g, '/'),
    };

    collectedMap.set(url, record);
    collectedImages.push(record);

    // Update progress in marker
    const progressMarker = {
      ...initialMarker,
      completedCount: i + 1,
      lastCollectedUrl: url,
      lastUpdatedAt: new Date().toISOString(),
    };
    durableWriteJson(markerFile, progressMarker);
  }

  // 6. Persist complete manifest and update marker to 'completed'
  const occurrencesManifest = occurrences.map((occ) => {
    const match = collectedMap.get(occ.requestUrl);
    return {
      index: occ.index,
      rawUrl: occ.rawUrl,
      requestUrl: occ.requestUrl,
      sha256: match ? match.sha256 : null,
      fileName: match ? match.fileName : null,
    };
  });

  const manifestData = {
    articleId: evidence.articleId,
    domSha256: evidence.domSha256,
    completedAt: new Date().toISOString(),
    totalOccurrences,
    uniqueCount,
    images: collectedImages,
    occurrences: occurrencesManifest,
  };

  const manifestSha = sha256(JSON.stringify(manifestData));
  manifestData.manifestSha256 = manifestSha;

  durableWriteJson(manifestFile, manifestData);

  const completedMarker = {
    status: 'completed',
    startedAt: initialMarker.startedAt,
    completedAt: manifestData.completedAt,
    articleId: evidence.articleId,
    domSha256: evidence.domSha256,
    totalOccurrences,
    uniqueCount,
    manifestSha256: manifestSha,
  };
  durableWriteJson(markerFile, completedMarker);

  return {
    success: true,
    articleId: evidence.articleId,
    totalOccurrences,
    uniqueCount,
    manifestSha256: manifestSha,
    outputDir,
    imagesDir,
    markerFile,
    manifestFile,
  };
}

async function main(args = process.argv.slice(2), logger = console) {
  // No CLI flag or environment variable can replace the fixed live DOM hash.
  const allowed = new Set(['--execute', '--base-dir']);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error('CLI_ARGUMENTS_INVALID');
    if (args[i] === '--base-dir') {
      if (!args[++i] || args[i].startsWith('--'))
        throw new Error('CLI_ARGUMENTS_INVALID');
    }
  }
  const execute = args.includes('--execute');
  const baseDirArgIndex = args.indexOf('--base-dir');
  const baseDir =
    baseDirArgIndex !== -1 ? args[baseDirArgIndex + 1] : undefined;

  const result = await collectBrowserDomImages({
    execute,
    baseDir,
  });

  // Whitelist public fields so even user-selected paths cannot quote raw URLs.
  const summary = Object.fromEntries(
    [
      'dryRun',
      'offline',
      'success',
      'articleId',
      'domSha256',
      'totalOccurrences',
      'uniqueCount',
      'imageUrlSha256',
      'paceMs',
      'readyForExecution',
      'oneShotMarkerCreated',
      'manifestSha256',
    ]
      .filter((key) => result[key] !== undefined)
      .map((key) => [key, result[key]]),
  );
  logger.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(
      JSON.stringify({ success: false, error: publicErrorCode(err) }),
    );
    process.exitCode = 1;
  });
}

module.exports = {
  TARGET_ARTICLE_ID,
  TARGET_MP_ID,
  EXPECTED_DOM_SHA256,
  ALLOWED_IMAGE_HOST,
  MAX_IMAGE_BYTES,
  DEFAULT_PACE_MS,
  sha256,
  validateImageSignature,
  validateDomEvidence,
  extractAllowedImageUrls,
  defaultFetchImage,
  collectBrowserDomImages,
  publicErrorCode,
  main,
};
