/** Local preparation only: no listener, credentials, platform calls or queue.
 * authorize/transport are server-only seams, not an authentication protocol.
 * Missing verified adapters fail closed. This file uses Worker Web APIs only.
 */
const endpoint = '/api/subscriptions';
const actions = ['capability', 'authors', 'items'];
const codes = [
  'IDENTITY_UNCONFIGURED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'BAD_REQUEST',
  'NOT_FOUND',
  'PC_UNAVAILABLE',
  'INVALID_RESPONSE',
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
  if (raw.action === 'capability' && raw.platform === 'wechat')
    keys.push('source');
  if (raw.action !== 'capability') keys.push('limit');
  if (raw.action !== 'capability' && raw.platform === 'wechat')
    keys.push('cursor');
  if (raw.action === 'items') keys.push('authorId');
  if (
    !strict(raw, keys) ||
    (raw.source !== undefined &&
      !['native', 'wechat2rss'].includes(raw.source)) ||
    (raw.cursor !== undefined && !text(raw.cursor, 300)) ||
    (raw.action === 'items' && !text(raw.authorId, 128)) ||
    (raw.limit !== undefined &&
      (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 50))
  )
    throw error('BAD_REQUEST');
  return {
    ...raw,
    ...(raw.action !== 'capability' ? { limit: raw.limit ?? 20 } : {}),
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

function safeResult(command, raw) {
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
export function createLocalSitesGateway({ authorize, caller } = {}) {
  return {
    async execute(raw, context) {
      try {
        await requireOwner(authorize, context);
        const command = parseSitesCommand(raw);
        if (!caller) throw error('PC_UNAVAILABLE');
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
            reject(error('PC_UNAVAILABLE'));
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
