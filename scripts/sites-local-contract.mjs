/** Local preparation only: no listener, credentials, platform calls or queue.
 * authorize/transport are server-only seams, not an authentication protocol.
 * Missing verified adapters fail closed. This file uses Worker Web APIs only.
 */
const endpoint = '/api/subscriptions';
const actions = [
  'capability',
  'authors',
  'items',
  'body',
  'download',
  'refresh',
  'status',
];
const codes = [
  'IDENTITY_UNCONFIGURED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'BAD_REQUEST',
  'NOT_FOUND',
  'PC_UNAVAILABLE',
  'INVALID_RESPONSE',
  'CACHE_UNAVAILABLE',
  'CACHE_ADAPTER_UNCONFIGURED',
  'SOURCE_UNAVAILABLE',
  'SOURCE_MISMATCH',
  'ACCOUNT_UNAVAILABLE',
  'REFRESH_UNCONFIGURED',
  'POLICY_UNCONFIRMED',
  'CONFLICT',
  'OPERATION_LIMIT',
  'RESULT_UNKNOWN',
];
const error = (code) => Object.assign(new Error(code), { code });
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= max &&
  !/[\x00-\x1f\x7f]/.test(v);
const strict = (v, keys) =>
  object(v) && Object.keys(v).every((k) => keys.includes(k));

export function parseSitesCommand(raw) {
  if (
    !object(raw) ||
    !actions.includes(raw.action) ||
    !['wechat', 'xiaohongshu'].includes(raw.platform)
  )
    throw error('BAD_REQUEST');
  const keys = ['action', 'platform'];
  const list = ['authors', 'items'].includes(raw.action);
  const content = ['body', 'download'].includes(raw.action);
  if (
    ['capability', 'refresh'].includes(raw.action) &&
    raw.platform === 'wechat'
  )
    keys.push('source');
  if (list) keys.push('limit');
  if (list && raw.platform === 'wechat') keys.push('cursor');
  if (
    raw.action === 'items' ||
    content ||
    ['refresh', 'status'].includes(raw.action)
  )
    keys.push('authorId');
  if (content) keys.push('itemId');
  if (['refresh', 'status'].includes(raw.action)) keys.push('operationId');
  if (raw.action === 'refresh') keys.push('confirmed');
  if (
    !strict(raw, keys) ||
    (raw.source !== undefined &&
      !['native', 'wechat2rss'].includes(raw.source)) ||
    (raw.cursor !== undefined && !text(raw.cursor, 300)) ||
    (keys.includes('authorId') && !text(raw.authorId, 128)) ||
    (content && !text(raw.itemId, 300)) ||
    (keys.includes('operationId') && !text(raw.operationId, 128)) ||
    (raw.action === 'refresh' &&
      (raw.confirmed !== true ||
        (raw.platform === 'wechat' && raw.source === undefined))) ||
    (raw.limit !== undefined &&
      (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 50))
  )
    throw error('BAD_REQUEST');
  return {
    ...raw,
    ...(list ? { limit: raw.limit ?? 20 } : {}),
  };
}

function capability(command, raw) {
  // Use the existing source capability; configured does not mean upstream works.
  const configured =
    command.platform === 'xiaohongshu' ? raw?.sourceConfigured : raw?.available;
  if (typeof configured !== 'boolean') throw error('INVALID_RESPONSE');
  if (
    command.platform === 'wechat' &&
    (!['native', 'wechat2rss'].includes(raw.source) ||
      (command.source !== undefined && raw.source !== command.source))
  )
    throw error('INVALID_RESPONSE');
  return {
    action: command.action,
    platform: command.platform,
    sourceConfigured: configured,
    canRefresh: false, // Remote mutations have no verified identity/budget/transport contract yet.
    ...(command.platform === 'wechat' ? { source: raw.source } : {}),
  };
}

function metadata(command, raw) {
  if (!Array.isArray(raw?.items)) throw error('INVALID_RESPONSE');
  const items = Array.from(raw.items.slice(0, command.limit), (row) => {
    if (!text(row?.id, 300)) throw error('INVALID_RESPONSE');
    if (command.action === 'authors') {
      const name = command.platform === 'wechat' ? row.mpName : row.displayName;
      if (!text(name, 500)) throw error('INVALID_RESPONSE');
      return { id: row.id, name };
    }
    // Existing XHS notes selects no creatorId; its protected route scopes the query.
    const parent =
      command.platform === 'wechat'
        ? row.mpId
        : (row.creatorId ?? command.authorId);
    if (
      parent !== command.authorId ||
      !text(row.title, 500) ||
      !Number.isInteger(row.publishTime) ||
      row.publishTime < 0
    )
      throw error('INVALID_RESPONSE');
    return {
      id: row.id,
      authorId: parent,
      title: row.title,
      publishTime: row.publishTime,
    };
  });
  if (
    raw.nextCursor !== undefined &&
    raw.nextCursor !== null &&
    !text(raw.nextCursor, 300)
  )
    throw error('INVALID_RESPONSE');
  return {
    action: command.action,
    platform: command.platform,
    items,
    truncated: raw.items.length > command.limit,
    // XHS has no existing pagination contract; do not invent one.
    ...(command.platform === 'wechat'
      ? { nextCursor: raw.nextCursor ?? null }
      : {}),
  };
}

// Transfer limits are deliberately smaller than the local archive limits. Refuse
// an oversized complete note; never truncate text or silently drop images.
const cacheLimits = {
  textBytes: 250_000,
  imageBytes: 1_000_000,
  totalImageBytes: 4_000_000,
  images: 60,
};
function cachedImage(raw) {
  if (typeof raw !== 'string') throw error('CACHE_UNAVAILABLE');
  const header = raw.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,/);
  if (
    !header ||
    raw.length - header[0].length > Math.ceil(cacheLimits.imageBytes / 3) * 4
  )
    throw error('CACHE_UNAVAILABLE');
  let bytes;
  try {
    bytes = atob(raw.slice(header[0].length));
  } catch {
    throw error('CACHE_UNAVAILABLE');
  }
  if (
    !bytes.length ||
    bytes.length > cacheLimits.imageBytes ||
    btoa(bytes) !== raw.slice(header[0].length)
  )
    throw error('CACHE_UNAVAILABLE');
  // Portable counterpart of image-fetch.decodeInlineImage's container gate.
  // Neither this nor the original gate claims to decode every image pixel.
  const data = Uint8Array.from(bytes, (c) => c.charCodeAt(0));
  const view = new DataView(data.buffer);
  const valid =
    (header[1] === 'image/png' &&
      bytes.length >= 45 &&
      bytes.startsWith('\x89PNG\r\n\x1a\n') &&
      view.getUint32(8) === 13 &&
      bytes.slice(12, 16) === 'IHDR' &&
      bytes.endsWith('\0\0\0\0IEND\xaeB`\x82')) ||
    (header[1] === 'image/jpeg' &&
      bytes.length >= 64 &&
      bytes.startsWith('\xff\xd8') &&
      bytes.includes('\xff\xda') &&
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].some((m) => bytes.includes('\xff' + String.fromCharCode(m))) &&
      bytes.endsWith('\xff\xd9')) ||
    (header[1] === 'image/gif' &&
      bytes.length >= 20 &&
      ['GIF87a', 'GIF89a'].includes(bytes.slice(0, 6)) &&
      bytes.includes('\x2c', 13) &&
      bytes.endsWith(';')) ||
    (header[1] === 'image/webp' &&
      bytes.length >= 16 &&
      bytes.startsWith('RIFF') &&
      view.getUint32(4, true) === bytes.length - 8 &&
      bytes.slice(8, 12) === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.slice(12, 16)));
  if (!valid) throw error('CACHE_UNAVAILABLE');
  return { source: raw, bytes: bytes.length };
}

function cachedBody(command, raw) {
  if (
    !text(raw?.title, 500) ||
    !Number.isSafeInteger(raw.publishTime) ||
    raw.publishTime <= 0 ||
    raw.publishTime > 253402300799 ||
    typeof raw.text !== 'string' ||
    raw.text.length > cacheLimits.textBytes ||
    new TextEncoder().encode(raw.text).length > cacheLimits.textBytes ||
    !Array.isArray(raw.images) ||
    raw.images.length > cacheLimits.images
  )
    throw error('CACHE_UNAVAILABLE');
  let total = 0;
  const images = Array.from(raw.images, (image) => {
    const checked = cachedImage(image);
    total += checked.bytes;
    if (total > cacheLimits.totalImageBytes) throw error('CACHE_UNAVAILABLE');
    return checked.source;
  });
  if (!raw.text.trim() && !images.length) throw error('CACHE_UNAVAILABLE');
  return {
    action: command.action,
    platform: command.platform,
    authorId: command.authorId,
    itemId: command.itemId,
    title: raw.title,
    publishTime: raw.publishTime,
    text: raw.text,
    images,
    ...(command.action === 'download'
      ? { filename: '缓存图文.html', mimeType: 'text/html' }
      : {}),
  };
}

const receiptStates = [
  'running',
  'complete',
  'partial',
  'pending',
  'blocked',
  'failed',
  'unknown',
];
const receiptCodes = [
  ...codes,
  'IN_PROGRESS',
  'WINDOW_COMPLETE',
  'WINDOW_PARTIAL',
  'UPSTREAM_PENDING',
  'UPDATE_FAILED',
];
function receipt(command, raw) {
  if (
    raw?.operationId !== command.operationId ||
    raw.authorId !== command.authorId ||
    !receiptStates.includes(raw.state) ||
    !receiptCodes.includes(raw.code) ||
    (raw.added !== undefined &&
      (!Number.isSafeInteger(raw.added) || raw.added < 0 || raw.added > 1000))
  )
    throw error('INVALID_RESPONSE');
  return {
    action: command.action,
    platform: command.platform,
    operationId: raw.operationId,
    authorId: raw.authorId,
    state: raw.state,
    code: raw.code,
    ...(raw.added !== undefined ? { added: raw.added } : {}),
  };
}

function refreshOutcome(command, raw) {
  const xhs = command.platform === 'xiaohongshu';
  const row = xhs
    ? raw
    : Array.isArray(raw) && raw.length === 1
      ? raw[0]
      : undefined;
  if (
    !row ||
    (!xhs &&
      row.source !== command.source &&
      !(row.source === 'unavailable' && row.status === 'blocked') &&
      !(row.source === 'error' && row.status === 'failed')) ||
    ![
      'complete',
      'partial',
      'pending',
      'blocked',
      'failed',
      'unconfigured',
      'paused',
    ].includes(row.status)
  )
    throw error('INVALID_RESPONSE');
  const state = ['unconfigured', 'paused'].includes(row.status)
    ? 'blocked'
    : row.status;
  const code = {
    complete: 'WINDOW_COMPLETE',
    partial: 'WINDOW_PARTIAL',
    pending: 'UPSTREAM_PENDING',
    blocked: 'SOURCE_UNAVAILABLE',
    failed: 'UPDATE_FAILED',
  }[state];
  return receipt(command, {
    ...command,
    state,
    code,
    ...(xhs
      ? { added: row.added }
      : row.created !== undefined
        ? { added: row.created }
        : {}),
  });
}

/** Server binding supplies the existing verifiedDownloadBody and Cheerio load.
 * All parsing here follows successful cache validation; no network fallback.
 */
export function createWechatCacheProjector({
  verifiedDownloadBody,
  load,
} = {}) {
  return (html) => {
    if (
      typeof verifiedDownloadBody !== 'function' ||
      typeof load !== 'function'
    )
      throw error('CACHE_ADAPTER_UNCONFIGURED');
    try {
      const $ = load(verifiedDownloadBody(html));
      const body = $('#js_content');
      if (!body.length) throw error('CACHE_UNAVAILABLE');
      const images = body
        .find('img')
        .toArray()
        .map((img) => $(img).attr('src') || '');
      body.find('br').replaceWith('\n');
      body.find('p,div,li,h1,h2,h3,blockquote').append('\n');
      return { text: body.text(), images };
    } catch {
      throw error('CACHE_UNAVAILABLE');
    }
  };
}

/** Generates a single-note offline file on the browser device. No vault/path or
 * network-aware original export route is exposed. Text is always escaped.
 */
export function sitesDownloadBlob(raw) {
  const command = parseSitesCommand({
    action: 'download',
    platform: raw?.platform,
    authorId: raw?.authorId,
    itemId: raw?.itemId,
  });
  const body = cachedBody(command, raw);
  const escape = (value) =>
    value.replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    );
  const html =
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:; style-src &#39;unsafe-inline&#39;">' +
    '<title>' +
    escape(body.title) +
    '</title><style>body{max-width:48rem;margin:2rem auto;padding:1rem;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style><h1>' +
    escape(body.title) +
    '</h1>' +
    body.text
      .split('\n')
      .map((p) => '<p>' + escape(p) + '</p>')
      .join('') +
    body.images
      .map((src) => '<img alt="缓存图片" src="' + src + '">')
      .join('') +
    '</html>';
  return {
    filename: body.filename,
    blob: new Blob([html], { type: body.mimeType }),
  };
}

function safeResult(command, raw) {
  if (['body', 'download'].includes(command.action)) {
    if (raw?.authorId !== command.authorId || raw.itemId !== command.itemId)
      throw error('INVALID_RESPONSE');
    return cachedBody(command, raw);
  }
  if (['refresh', 'status'].includes(command.action))
    return receipt(command, raw);
  if (command.action === 'capability') {
    if (raw?.action === 'capability') {
      if (typeof raw.sourceConfigured !== 'boolean' || raw.canRefresh !== false)
        throw error('INVALID_RESPONSE');
      return capability(
        command,
        command.platform === 'wechat'
          ? { available: raw.sourceConfigured, source: raw.source }
          : { sourceConfigured: raw.sourceConfigured },
      );
    }
    return capability(command, raw);
  }
  if (command.action === 'authors' && raw?.action === 'authors') {
    const projected = raw.items?.map((row) => ({
      ...row,
      ...(command.platform === 'wechat'
        ? { mpName: row.name }
        : { displayName: row.name }),
    }));
    return {
      ...metadata(command, { ...raw, items: projected }),
      truncated: raw.truncated === true || raw.items.length > command.limit,
    };
  }
  if (command.action === 'items' && raw?.action === 'items') {
    const projected = raw.items?.map((row) => ({
      ...row,
      ...(command.platform === 'wechat'
        ? { mpId: row.authorId }
        : { creatorId: row.authorId }),
    }));
    return {
      ...metadata(command, { ...raw, items: projected }),
      truncated: raw.truncated === true || raw.items.length > command.limit,
    };
  }
  return metadata(command, raw);
}

function bridgeResult(command, raw) {
  if (raw?.action !== command.action || raw.platform !== command.platform)
    throw error('INVALID_RESPONSE');
  return safeResult(command, raw);
}

async function boundedBody(request) {
  if (!request.body) throw error('BAD_REQUEST');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0,
    body = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        throw error('BAD_REQUEST');
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function requireOwner(authorize, context) {
  if (typeof authorize !== 'function') throw error('IDENTITY_UNCONFIGURED');
  const identity = await authorize(context);
  if (!identity) throw error('UNAUTHORIZED');
  if (identity.isOwner !== true) throw error('FORBIDDEN');
}

/** caller is an already-authorized existing appRouter caller. Never manufacture
 * its ctx.isLocal or errorMsg from a forwarded header or loopback connection.
 * Caller creation and local bridge authentication remain explicitly unconfigured.
 */
export function createLocalSitesGateway({
  authorize,
  caller,
  projectWechatCachedBody,
  refreshAccess,
} = {}) {
  const active = new Set();
  const operations = new Map();
  const binding = (c) =>
    JSON.stringify([c.platform, c.authorId, c.source ?? null]);
  async function readBody(command) {
    let result;
    if (command.platform === 'xiaohongshu') {
      result = await caller.xiaohongshu.body({
        creatorId: command.authorId,
        noteId: command.itemId,
      });
    } else {
      // This is the original cache-only lookup, never exportMarkdown/retryBody.
      const row = await caller.article.byId(command.itemId);
      if (row?.id !== command.itemId || row.mpId !== command.authorId)
        throw error('NOT_FOUND');
      if (!row.contentHtml || row.lastBodyStatus === 'unavailable')
        throw error('CACHE_UNAVAILABLE');
      if (typeof projectWechatCachedBody !== 'function')
        throw error('CACHE_ADAPTER_UNCONFIGURED');
      // Future server binding reuses verifiedDownloadBody + cached text extraction.
      // It receives only cached HTML; no caller, URL, file path or image fetcher.
      const decoded = await projectWechatCachedBody(row.contentHtml);
      result = {
        title: row.title,
        publishTime: row.publishTime,
        text: decoded?.text,
        images: decoded?.images,
      };
    }
    return cachedBody(command, result);
  }
  async function refresh(command, context) {
    const old = operations.get(command.operationId);
    if (old) {
      if (old.binding !== binding(command)) throw error('CONFLICT');
      return receipt(command, old.value); // No replay, including failed/unknown results.
    }
    const key = JSON.stringify([command.platform, command.authorId]);
    if (active.has(key)) throw error('CONFLICT');
    if (operations.size >= 128) throw error('OPERATION_LIMIT');
    const record = {
      binding: binding(command),
      value: { ...command, state: 'running', code: 'IN_PROGRESS' },
    };
    operations.set(command.operationId, record);
    active.add(key);
    let submitted = false;
    try {
      if (typeof refreshAccess !== 'function')
        throw error('REFRESH_UNCONFIGURED');
      const xhs = command.platform === 'xiaohongshu';
      const cap = xhs
        ? await caller.xiaohongshu.capability()
        : await caller.feed.addCapability({ source: command.source });
      if ((xhs ? cap?.sourceConfigured : cap?.available) !== true)
        throw error('SOURCE_UNAVAILABLE');
      if (!xhs && cap.source !== command.source) throw error('SOURCE_MISMATCH');
      const author = xhs
        ? (await caller.xiaohongshu.list()).items.find(
            (row) => row?.id === command.authorId,
          )
        : await caller.feed.byId(command.authorId);
      if (author?.id !== command.authorId) throw error('NOT_FOUND');
      if (xhs && author.enabled !== true) throw error('SOURCE_UNAVAILABLE');
      // Existing refresh follows saved binding. Never change it or infer native
      // refresh from the *add* capability. This contract only permits paid WX.
      if (
        !xhs &&
        (command.source !== 'wechat2rss' ||
          author.collectionRoute?.channel !== command.source)
      )
        throw error('SOURCE_MISMATCH');
      const policy = await refreshAccess(command, { author, context });
      if (policy?.sourceAvailable === false) throw error('SOURCE_UNAVAILABLE');
      if (policy?.accountAvailable === false)
        throw error('ACCOUNT_UNAVAILABLE');
      if (
        policy?.sourceAvailable !== true ||
        policy?.accountAvailable !== true ||
        policy?.manualAccessConfirmed !== true ||
        policy?.budgetApproved !== true
      )
        throw error('POLICY_UNCONFIRMED');
      submitted = true;
      const result = xhs
        ? await caller.xiaohongshu.refresh({ id: command.authorId })
        : await caller.feed.refreshArticles({ mpId: command.authorId });
      record.value = refreshOutcome(command, result);
    } catch (caught) {
      const code = codes.includes(caught?.code) ? caught.code : 'UPDATE_FAILED';
      record.value = {
        ...command,
        state: submitted ? 'unknown' : 'blocked',
        code: submitted ? 'RESULT_UNKNOWN' : code,
      };
    } finally {
      active.delete(key);
    }
    return receipt(command, record.value);
  }
  return {
    async execute(raw, context) {
      try {
        await requireOwner(authorize, context);
        const command = parseSitesCommand(raw);
        if (command.action === 'status') {
          const record = operations.get(command.operationId);
          if (
            !record ||
            record.value.platform !== command.platform ||
            record.value.authorId !== command.authorId
          )
            throw error('NOT_FOUND');
          return receipt(command, record.value);
        }
        if (!caller) throw error('PC_UNAVAILABLE');
        if (command.action === 'refresh')
          return await refresh(command, context);
        if (['body', 'download'].includes(command.action))
          return await readBody(command);
        const xhs = command.platform === 'xiaohongshu';
        let result;
        if (command.action === 'capability') {
          result = xhs
            ? await caller.xiaohongshu.capability()
            : await caller.feed.addCapability(
                command.source ? { source: command.source } : undefined,
              );
        } else if (command.action === 'authors') {
          result = xhs
            ? await caller.xiaohongshu.list()
            : await caller.feed.list({
                limit: command.limit,
                ...(command.cursor ? { cursor: command.cursor } : {}),
              });
        } else {
          result = xhs
            ? await caller.xiaohongshu.notes({ creatorId: command.authorId })
            : await caller.article.list({
                mpId: command.authorId,
                limit: command.limit,
                ...(command.cursor ? { cursor: command.cursor } : {}),
              });
        }
        return safeResult(command, result);
      } catch (caught) {
        throw error(
          codes.includes(caught?.code) ? caught.code : 'PC_UNAVAILABLE',
        );
      }
    },
  };
}

const status = (code) =>
  ({
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    BAD_REQUEST: 400,
    NOT_FOUND: 404,
    INVALID_RESPONSE: 502,
    CONFLICT: 409,
    CACHE_UNAVAILABLE: 422,
  })[code] ?? 503;
const response = (body, httpStatus) =>
  new Response(JSON.stringify(body), {
    status: httpStatus,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    },
  });

/** Bind authorize only after Sites dispatch identity AND owner policy are verified.
 * A Sites service bearer does not identify a visitor. No auth header is inferred.
 * transport is a future server-only, authenticated connection, not a browser URL.
 */
export function createSitesWorker({ authorize, transport } = {}) {
  return {
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (url.pathname !== endpoint || url.search) throw error('NOT_FOUND');
        await requireOwner(authorize, request);
        if (
          request.method !== 'POST' ||
          request.headers.get('origin') !== url.origin ||
          request.headers.get('content-type')?.split(';')[0].trim() !==
            'application/json'
        )
          throw error('BAD_REQUEST');
        const body = await boundedBody(request);
        let command;
        try {
          command = parseSitesCommand(JSON.parse(body));
        } catch {
          throw error('BAD_REQUEST');
        }
        if (typeof transport?.send !== 'function')
          throw error('PC_UNAVAILABLE');
        const controller = new AbortController();
        let timer;
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              error(
                command.action === 'refresh'
                  ? 'RESULT_UNKNOWN'
                  : 'PC_UNAVAILABLE',
              ),
            );
          }, 5000);
        });
        let result;
        try {
          result = await Promise.race([
            transport.send(command, { signal: controller.signal }),
            deadline,
          ]);
        } catch (caught) {
          throw error(
            codes.includes(caught?.code) ? caught.code : 'PC_UNAVAILABLE',
          );
        } finally {
          clearTimeout(timer);
        }
        return response({ ok: true, data: bridgeResult(command, result) }, 200);
      } catch (caught) {
        const code = codes.includes(caught?.code)
          ? caught.code
          : 'PC_UNAVAILABLE';
        return response({ ok: false, code }, status(code));
      }
    },
  };
}

/** Browser helper: only the same-origin Site endpoint, never backend secrets,
 * service bearer, absolute gateway URLs or localhost. No retry or fallback.
 */
export function createSitesClient(fetchImpl = globalThis.fetch) {
  return async (raw) => {
    const command = parseSitesCommand(raw);
    let result;
    try {
      const reply = await fetchImpl(endpoint, {
        method: 'POST',
        mode: 'same-origin',
        credentials: 'same-origin',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      });
      result = await reply.json();
      if (!reply.ok || result.ok !== true)
        throw error(
          codes.includes(result?.code) ? result.code : 'PC_UNAVAILABLE',
        );
    } catch (caught) {
      throw error(
        codes.includes(caught?.code) ? caught.code : 'PC_UNAVAILABLE',
      );
    }
    return bridgeResult(command, result.data);
  };
}

// Importing or running the module never starts a service. Default Worker refuses.
export default createSitesWorker();
