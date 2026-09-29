#!/usr/bin/env node
// Isolated, read-only test of Tencent WeChatReading skill v1.0.4's documented
// gateway. Never writes credentials, responses, or production data.
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';
const BOOK_ID = 'MP_WXS_3895431412';
const EXPECTED_TITLE = '妈妈部落畅聊阁';
const SKILL_VERSION = '1.0.4';
const TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_PRINTED_CHAPTERS = 20;
const MAX_PRINTED_SEARCH_GROUPS = 20;
const MAX_PRINTED_SEARCH_RESULTS = 20;
// Only these reviewed interface names can be echoed from an untrusted list.
// /book/articles is included solely to detect if the gateway ever lists it.
const SAFE_GATEWAY_API_NAMES = new Set([
  '/book/articles',
  '/book/bestbookmarks',
  '/book/bookmarklist',
  '/book/chapterinfo',
  '/book/getprogress',
  '/book/info',
  '/book/readreviews',
  '/book/recommend',
  '/book/similar',
  '/book/underlines',
  '/discover/interact/type3',
  '/readdata/detail',
  '/review/list',
  '/review/list/mine',
  '/review/single',
  '/shelf/sync',
  '/store/search',
  '/user/notebooks',
]);

class ProbeError extends Error {
  constructor(kind, details = {}) {
    super(kind);
    this.kind = kind;
    this.httpStatus = details.httpStatus ?? null;
    this.responseFormat = details.responseFormat ?? null;
    this.errorCode = details.errorCode ?? null;
    this.errorMessage = details.errorMessage ?? null;
    this.upgradeRequired = details.upgradeRequired ?? false;
    this.suggestedSkillVersion = details.suggestedSkillVersion ?? null;
    this.responseShape = details.responseShape ?? null;
    this.topLevelKeyCount = details.topLevelKeyCount ?? null;
  }
}

function safeBusinessCode(value) {
  const code = Number(value);
  return Number.isSafeInteger(code) && Math.abs(code) <= 1000000000
    ? code
    : null;
}

function safeLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return label ? label.slice(0, 120) : null;
}

function safeVersion(value) {
  return typeof value === 'string' &&
    /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.-]{1,30})?$/i.test(value)
    ? value
    : null;
}

function classifyErrorMessage(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  // Gateway text is untrusted and may contain credentials or URLs. Emit only
  // a controlled explanation, never a substring of the original message.
  if (
    /升级|更新.{0,8}版本|版本.{0,8}(?:低|旧|不匹配)|upgrade|update.{0,8}version|skill.version/i.test(
      value,
    )
  )
    return 'version-update-requested';
  if (/验证码|captcha|人机验证|安全验证/i.test(value))
    return 'verification-required';
  if (/频繁|限流|稍后再试|too many|rate.limit|throttl/i.test(value))
    return 'rate-limited';
  if (
    /认证|授权|登录|无权限|拒绝访问|credential|unauthori[sz]ed|forbidden|permission|access.denied|token|cookie|\bkey\b/i.test(
      value,
    )
  )
    return 'authentication-or-permission-rejected';
  if (/参数|缺少|无效|invalid.param|missing.param|required.param/i.test(value))
    return 'request-parameter-rejected';
  if (/未找到|不存在|not.found/i.test(value)) return 'resource-not-found';
  return 'unclassified-error-message';
}

const ERROR_MESSAGE_PRIORITY = {
  'unclassified-error-message': 0,
  'resource-not-found': 1,
  'request-parameter-rejected': 2,
  'authentication-or-permission-rejected': 3,
  'rate-limited': 4,
  'verification-required': 5,
  'version-update-requested': 6,
};

function preferredErrorMessage(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  return ERROR_MESSAGE_PRIORITY[candidate] > ERROR_MESSAGE_PRIORITY[current]
    ? candidate
    : current;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function gatewayErrorDetails(json) {
  const objects = isRecord(json)
    ? [json, ...(isRecord(json.data) ? [json.data] : [])]
    : [];
  let errorCode = null;
  let errorMessage = null;
  let upgradeRequired = false;
  let suggestedSkillVersion = null;
  let businessError = false;
  for (const object of objects) {
    for (const value of [object.errcode, object.errCode]) {
      if (value === undefined || value === null || value === '') continue;
      const code = safeBusinessCode(value);
      if (code === 0) continue;
      businessError = true;
      errorCode ??= code;
    }
    errorMessage = preferredErrorMessage(
      errorMessage,
      classifyErrorMessage(object.errmsg ?? object.errMsg ?? object.message),
    );
    if (Object.hasOwn(object, 'upgrade_info')) {
      upgradeRequired = true;
      const upgrade = object.upgrade_info;
      if (isRecord(upgrade)) {
        suggestedSkillVersion ??= safeVersion(
          upgrade.latest_version ?? upgrade.new_version ?? upgrade.version,
        );
        errorMessage = preferredErrorMessage(
          errorMessage,
          classifyErrorMessage(upgrade.message),
        );
      }
    }
  }
  if (upgradeRequired)
    errorMessage = preferredErrorMessage(
      errorMessage,
      'version-update-requested',
    );
  return {
    errorCode,
    errorMessage,
    upgradeRequired,
    suggestedSkillVersion,
    businessError,
  };
}

function throwGatewayBusinessError(json) {
  const details = gatewayErrorDetails(json);
  if (details.upgradeRequired)
    throw new ProbeError('upgrade-required', {
      httpStatus: 200,
      responseFormat: 'json',
      ...details,
    });
  if (details.businessError)
    throw new ProbeError('business-error', {
      httpStatus: 200,
      responseFormat: 'json',
      ...details,
    });
}

function safeSearchLabel(value) {
  const label = safeLabel(value);
  if (!label) return null;
  // Search labels are untrusted response text. Never print an embedded URL or
  // a token-shaped string, even when it appears in a title or author field.
  if (
    /\b(?:authorization|cookie|set-cookie|bearer|api[_-]?key|key|token|skey|secret|password)\b/i.test(
      label,
    ) ||
    /[a-z0-9_-]{24,}/i.test(label)
  )
    return '[redacted-label]';
  return label
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted-url]')
    .replace(/\bwww\.\S+/gi, '[redacted-url]')
    .replace(/\bwrk-\S+/gi, '[redacted-token]');
}

function chapterUid(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    return String(value);
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) {
    const normalized = BigInt(value);
    if (normalized > 0n) return normalized.toString();
  }
  return null;
}

function parsePrivateKey(text) {
  const entries = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('WEREAD_API_KEY='));
  if (entries.length > 1)
    throw new ProbeError('private-key-file-duplicate-entry');
  if (entries.length === 0) return null;
  let value = entries[0].slice('WEREAD_API_KEY='.length).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )
    value = value.slice(1, -1);
  return value || null;
}

async function readPrivateKey() {
  // Fixed, local, Git-ignored file only. No arbitrary path or credential search.
  const file = path.resolve(__dirname, '../.env.weread-gateway');
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ProbeError('private-key-file-unreadable');
  }
  if (!stat.isFile() || stat.size > 4096)
    throw new ProbeError('private-key-file-invalid');
  try {
    return parsePrivateKey(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError('private-key-file-unreadable');
  }
}

function updateDate(value) {
  // The official skill describes Unix timestamps as seconds, and says to
  // display calendar dates. This is NOT an article publication date.
  const seconds = typeof value === 'number' ? value : Number(value);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 946684800 ||
    seconds > 4102444800
  )
    return null;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function uidHash(uid) {
  return createHash('sha256').update(uid).digest('hex').slice(0, 16);
}

function unwrapPayload(json, expectedField) {
  if (!isRecord(json)) throw new ProbeError('unexpected-shape');
  throwGatewayBusinessError(json);
  const payload = Object.hasOwn(json, expectedField) ? json : json.data;
  if (!isRecord(payload)) throw new ProbeError('unexpected-shape');
  if (!Object.hasOwn(payload, expectedField))
    throw new ProbeError('unexpected-shape');
  return payload;
}

async function readResponseBounded(response) {
  const httpStatus = Number.isSafeInteger(response.status)
    ? response.status
    : null;
  const maxBytes =
    response.status === 200 ? MAX_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES;
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes)
    throw new ProbeError('response-too-large', { httpStatus });
  const type = response.headers.get('content-type') || '';
  const declaredJson = /^application\/(?:[\w.-]+\+)?json(?:\s*;|\s*$)/i.test(
    type,
  );
  if (!response.body) return { json: null, responseFormat: 'empty' };

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes)
        throw new ProbeError('response-too-large', { httpStatus });
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProbeError) {
      // Do not wait for a stalled peer to acknowledge cancellation.
      void reader.cancel().catch(() => {});
      throw error;
    }
    throw new ProbeError('transport-failure', { httpStatus });
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, bytes).toString('utf8').trim();
  if (!body) return { json: null, responseFormat: 'empty' };
  if (!declaredJson && !/^[{[]/.test(body))
    return { json: null, responseFormat: 'non-json' };
  try {
    return { json: JSON.parse(body), responseFormat: 'json' };
  } catch {
    return {
      json: null,
      responseFormat: declaredJson ? 'invalid-json' : 'non-json',
    };
  }
}

async function callGateway(apiName, params, key, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(GATEWAY, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        api_name: apiName,
        ...params,
        skill_version: SKILL_VERSION,
      }),
    });
    const { json, responseFormat } = await readResponseBounded(response);
    if (response.status !== 200)
      throw new ProbeError('http-error', {
        httpStatus: response.status,
        responseFormat,
        ...gatewayErrorDetails(json),
      });
    if (responseFormat !== 'json')
      throw new ProbeError('non-json-response', {
        httpStatus: 200,
        responseFormat,
      });
    return json;
  } catch (error) {
    if (controller.signal.aborted)
      throw new ProbeError('timeout', {
        httpStatus: error instanceof ProbeError ? error.httpStatus : null,
      });
    if (error instanceof ProbeError) {
      controller.abort();
      throw error;
    }
    throw new ProbeError('transport-failure');
  } finally {
    clearTimeout(timeout);
  }
}

function responseShape(value) {
  return Array.isArray(value)
    ? 'array'
    : value === null
      ? 'null'
      : typeof value;
}

function topLevelKeyCount(value) {
  return isRecord(value) ? Object.keys(value).length : null;
}

function summarizeList(json) {
  throwGatewayBusinessError(json);
  const entries = Array.isArray(json)
    ? json
    : Array.isArray(json?.apis)
      ? json.apis
      : Array.isArray(json?.data?.apis)
        ? json.data.apis
        : null;
  if (!entries)
    throw new ProbeError('unknown-list-shape', {
      httpStatus: 200,
      responseFormat: 'json',
      responseShape: responseShape(json),
      topLevelKeyCount: topLevelKeyCount(json),
    });
  const names = new Set();
  let unrecognizedEntryCount = 0;
  for (const entry of entries) {
    const name = isRecord(entry) ? entry.api_name : null;
    if (SAFE_GATEWAY_API_NAMES.has(name)) names.add(name);
    else unrecognizedEntryCount++;
  }
  if (entries.length > 0 && names.size === 0)
    throw new ProbeError('unknown-list-shape', {
      httpStatus: 200,
      responseFormat: 'json',
      responseShape: responseShape(json),
      topLevelKeyCount: topLevelKeyCount(json),
    });
  const apiNames = [...names].sort();
  return {
    kind: 'gateway-capabilities',
    count: apiNames.length,
    sourceEntryCount: entries.length,
    unrecognizedEntryCount,
    complete: unrecognizedEntryCount === 0,
    apiNames,
  };
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function searchDate(value) {
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    const seconds = n > 4102444800 ? Math.floor(n / 1000) : n;
    return updateDate(seconds);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
      ? value
      : null;
  }
  return null;
}

function searchTimeEvidence(bookInfo) {
  // The public search schema does not define an article publication field.
  // Presence and calendar date alone cannot establish publication semantics.
  const fields = [
    'publishTime',
    'publishedTime',
    'pubTime',
    'publishDate',
    'pubDate',
    'createTime',
    'updateTime',
  ];
  return fields
    .filter((field) => Object.hasOwn(bookInfo, field))
    .map((field) => ({ field, calendarDate: searchDate(bookInfo[field]) }));
}

function summarizeSearch(payload) {
  if (!Array.isArray(payload.results)) throw new ProbeError('unexpected-shape');
  const groups = [];
  const results = [];
  let returnedItemCount = 0;
  for (const group of payload.results) {
    if (!group || typeof group !== 'object' || Array.isArray(group))
      throw new ProbeError('unexpected-shape');
    const books = Array.isArray(group.books) ? group.books : [];
    // A bounded response can still contain thousands of small groups. Keep
    // aggregate counts while limiting untrusted labels written to logs.
    if (groups.length < MAX_PRINTED_SEARCH_GROUPS)
      groups.push({
        title: safeSearchLabel(group.title),
        responseScope: safeCount(group.scope),
        reportedScopeCount: safeCount(group.scopeCount),
        reportedCurrentCount: safeCount(group.currentCount),
        booksArrayPresent: Array.isArray(group.books),
        returnedItemCount: books.length,
      });
    returnedItemCount += books.length;
    for (const book of books) {
      if (results.length >= MAX_PRINTED_SEARCH_RESULTS) break;
      if (
        !book ||
        typeof book !== 'object' ||
        !book.bookInfo ||
        typeof book.bookInfo !== 'object' ||
        Array.isArray(book.bookInfo)
      )
        continue;
      const info = book.bookInfo;
      const stableId =
        typeof info.bookId === 'string' &&
        info.bookId.length > 0 &&
        info.bookId.length <= 256
          ? info.bookId
          : null;
      const title = safeSearchLabel(info.title);
      if (!title) continue;
      results.push({
        title,
        bookIdSha256_16: stableId ? uidHash(stableId) : null,
        authorLabel: safeSearchLabel(info.author),
        publisherLabel: safeSearchLabel(info.publisher),
        timeFieldEvidence: searchTimeEvidence(info),
      });
    }
  }
  return {
    kind: 'keyword-search-sample',
    requestedScope: 4,
    keyword: EXPECTED_TITLE,
    groupCount: payload.results.length,
    printedGroupCount: groups.length,
    returnedItemCount,
    hasMore:
      payload.hasMore === 1 || payload.hasMore === true
        ? true
        : payload.hasMore === 0 || payload.hasMore === false
          ? false
          : null,
    printedCount: results.length,
    identityMeaning:
      'author and publisher are search labels, not verified account identity',
    stableIdMeaning:
      'bookInfo.bookId hash is a search identifier; article identity unverified',
    timeMeaning:
      'field presence and calendar dates do not verify article publication time',
    subscriptionVerified: false,
    groups,
    results,
  };
}

function summarizeChapters(payload) {
  if (!Array.isArray(payload.chapters))
    throw new ProbeError('unexpected-shape');
  if (payload.bookId !== BOOK_ID) throw new ProbeError('book-id-mismatch');
  const seen = new Set();
  const chapters = [];
  let mpFlagOneCount = 0;
  for (const chapter of payload.chapters) {
    if (!chapter || typeof chapter !== 'object') continue;
    const uid = chapterUid(chapter.chapterUid);
    const title = safeSearchLabel(chapter.title);
    if (!uid || !title || seen.has(uid)) continue;
    seen.add(uid);
    if (chapter.isMPChapter === 1) mpFlagOneCount++;
    if (chapters.length < MAX_PRINTED_CHAPTERS) {
      chapters.push({
        title,
        chapterUidSha256_16: uidHash(uid),
        updateTime: updateDate(chapter.updateTime),
        isMPChapter:
          chapter.isMPChapter === 1 ? 1 : chapter.isMPChapter === 0 ? 0 : null,
      });
    }
  }
  return {
    kind: 'chapter-candidates',
    bookIdMatched: true,
    chaptersArrayLength: payload.chapters.length,
    distinctTitledUidCount: seen.size,
    isMPChapterOneCount: mpFlagOneCount,
    printedCount: chapters.length,
    updateTimeMeaning:
      'chapter update date; NOT verified article publication time',
    chapters,
  };
}

function summarizeInfo(payload) {
  if (payload.bookId !== BOOK_ID) throw new ProbeError('book-id-mismatch');
  const title = safeSearchLabel(payload.title);
  return {
    kind: 'book-identity',
    bookIdMatched: true,
    title,
    titleMatchesExpected: title === EXPECTED_TITLE,
    author: safeSearchLabel(payload.author),
    category: safeSearchLabel(payload.category),
    publisher: safeSearchLabel(payload.publisher),
    articlePublicationTimesVerified: false,
  };
}

async function run({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
  loadPrivateKey = readPrivateKey,
  mode = 'invalid',
} = {}) {
  if (mode !== 'chapters' && mode !== 'search' && mode !== 'list') {
    log(
      JSON.stringify({
        kind: 'skipped',
        reason: 'invalid-mode',
        requestsSent: 0,
      }),
    );
    return 2;
  }
  let key = env.WEREAD_API_KEY;
  if (!key) {
    try {
      key = await loadPrivateKey();
    } catch (error) {
      log(
        JSON.stringify({
          kind: 'skipped',
          reason:
            error instanceof ProbeError
              ? error.kind
              : 'private-key-file-unreadable',
          requestsSent: 0,
        }),
      );
      return 2;
    }
  }
  if (!key) {
    log(
      JSON.stringify({
        kind: 'skipped',
        reason: 'WEREAD_API_KEY missing; zero requests sent',
      }),
    );
    return 2;
  }
  // The public Tencent skill specifies the wrk- prefix. Reject accidental
  // whitespace or malformed values without ever echoing the supplied key.
  if (typeof key !== 'string' || !/^wrk-[^\s]{1,251}$/.test(key)) {
    log(
      JSON.stringify({
        kind: 'skipped',
        reason: 'WEREAD_API_KEY format invalid; zero requests sent',
      }),
    );
    return 2;
  }
  try {
    if (mode === 'list') {
      const listJson = await callGateway('/_list', {}, key, fetchImpl);
      log(JSON.stringify(summarizeList(listJson)));
      return 0;
    }
    if (mode === 'search') {
      const searchJson = await callGateway(
        '/store/search',
        { keyword: EXPECTED_TITLE, scope: 4 },
        key,
        fetchImpl,
      );
      log(
        JSON.stringify(summarizeSearch(unwrapPayload(searchJson, 'results'))),
      );
      return 0;
    }
    const chaptersJson = await callGateway(
      '/book/chapterinfo',
      { bookId: BOOK_ID },
      key,
      fetchImpl,
    );
    const chapters = summarizeChapters(unwrapPayload(chaptersJson, 'chapters'));
    log(JSON.stringify(chapters));
    if (chapters.isMPChapterOneCount < 5) {
      log(
        JSON.stringify({
          kind: 'stopped',
          reason:
            'fewer-than-five-distinct-mp-chapters; no identity request sent',
        }),
      );
      return 1;
    }
    const infoJson = await callGateway(
      '/book/info',
      { bookId: BOOK_ID },
      key,
      fetchImpl,
    );
    const info = summarizeInfo(unwrapPayload(infoJson, 'bookId'));
    log(JSON.stringify(info));
    if (!info.titleMatchesExpected) {
      log(JSON.stringify({ kind: 'stopped', reason: 'book-title-mismatch' }));
      return 1;
    }
    log(
      JSON.stringify({
        kind: 'incomplete',
        reason:
          'chapter directory and book identity alone do not verify five article publication times or article bodies',
      }),
    );
    return 0;
  } catch (error) {
    // Raw gateway responses and transport exceptions may contain private data.
    log(
      JSON.stringify({
        kind: 'stopped',
        reason: error instanceof ProbeError ? error.kind : 'unknown-failure',
        httpStatus: error instanceof ProbeError ? error.httpStatus : null,
        responseFormat:
          error instanceof ProbeError ? error.responseFormat : null,
        errorCode: error instanceof ProbeError ? error.errorCode : null,
        errorMessage: error instanceof ProbeError ? error.errorMessage : null,
        upgradeRequired:
          error instanceof ProbeError ? error.upgradeRequired : false,
        suggestedSkillVersion:
          error instanceof ProbeError ? error.suggestedSkillVersion : null,
        ...(error instanceof ProbeError && error.responseShape
          ? {
              responseShape: error.responseShape,
              topLevelKeyCount: error.topLevelKeyCount,
            }
          : {}),
      }),
    );
    return 1;
  }
}

if (require.main === module) {
  // An explicit mode is required so a plain invocation cannot replay an
  // already completed live experiment.
  const args = process.argv.slice(2);
  const mode =
    args.length === 1 && args[0] === '--chapters'
      ? 'chapters'
      : args.length === 1 && args[0] === '--search'
        ? 'search'
        : args.length === 1 && args[0] === '--list'
          ? 'list'
          : 'invalid';
  run({ mode }).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { run, summarizeChapters, parsePrivateKey };
