'use strict';
const http = require('node:http');
const {
  randomBytes,
  randomInt,
  createHash,
  timingSafeEqual,
} = require('node:crypto');
const ACCESS_MS = 24 * 60 * 60 * 1000;
const PAIR_MS = 2 * 60 * 1000;
const digest = (value) => createHash('sha256').update(value).digest();
const equal = (value, expected) =>
  typeof value === 'string' && timingSafeEqual(digest(value), expected);
const nonce = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, 'base64url').toString('base64url') === value;
const fail = (code, status = 403) =>
  Object.assign(new Error(code), { status, safeCode: code });
class PairAuthority {
  constructor({
    clock = Date.now,
    monotonic = () => performance.now(),
    onRevoke = async () => {},
  } = {}) {
    this.clock = clock;
    this.monotonic = monotonic;
    this.onRevoke = onRevoke;
    this.pending = null;
    this.grant = null;
    this.clearing = null;
    this.cleanupFailed = false;
    this.starts = [];
    this.timer = null;
  }
  sweep() {
    if (
      this.pending &&
      (this.clock() >= this.pending.deadline ||
        this.monotonic() >= this.pending.monoDeadline)
    )
      this.pending = null;
    if (
      this.grant &&
      (this.clock() >= this.grant.expiresAt ||
        this.monotonic() >= this.grant.monoExpiry)
    )
      void this.revoke().catch(() => {});
  }
  start(proof) {
    this.sweep();
    if (!nonce(proof)) throw fail('PAIR_INPUT', 422);
    if (this.cleanupFailed) throw fail('CLEANUP_FAILED', 409);
    if (this.clearing || this.pending || this.grant)
      throw fail('PAIR_BUSY', 409);
    this.starts = this.starts.filter((t) => t > this.clock() - 60000);
    if (this.starts.length >= 3) throw fail('PAIR_RATE', 429);
    this.starts.push(this.clock());
    const pending = {
      id: randomBytes(16).toString('hex'),
      proof: digest(proof),
      code: String(randomInt(1000000)).padStart(6, '0'),
      deadline: this.clock() + PAIR_MS,
      monoDeadline: this.monotonic() + PAIR_MS,
      approvedAt: null,
      failedApprovals: 0,
    };
    this.pending = pending;
    return {
      pairId: pending.id,
      comparison: pending.code,
      pairDeadline: pending.deadline,
    };
  }
  approve(comparison) {
    this.sweep();
    const p = this.pending;
    if (!p || p.approvedAt !== null) return false;
    if (
      typeof comparison !== 'string' ||
      !/^\d{6}$/.test(comparison) ||
      !equal(comparison, digest(p.code))
    ) {
      p.failedApprovals++;
      if (p.failedApprovals >= 3) this.pending = null;
      return false;
    }
    p.approvedAt = this.clock();
    p.approvedMono = this.monotonic();
    p.code = '';
    return true;
  }
  redeem(pairId, proof) {
    this.sweep();
    const p = this.pending;
    if (!p || pairId !== p.id || !equal(proof, p.proof))
      throw fail('PAIR_UNAVAILABLE');
    if (p.approvedAt === null) return { waiting: true };
    const token = randomBytes(32).toString('base64url');
    this.grant = {
      token: digest(token),
      proof: p.proof,
      expiresAt: p.approvedAt + ACCESS_MS,
      monoExpiry: p.approvedMono + ACCESS_MS,
      abort: new AbortController(),
      listSpent: false,
      detailSpent: false,
      imagesSpent: false,
      creatorId: null,
      profileUrl: null,
      sampleCache: null,
    };
    this.pending = null;
    this.timer = setTimeout(
      () => {
        void this.revoke().catch(() => {});
      },
      Math.max(
        0,
        Math.min(
          this.grant.expiresAt - this.clock(),
          this.grant.monoExpiry - this.monotonic(),
        ),
      ),
    );
    this.timer.unref();
    return {
      token,
      expiresAt: this.grant.expiresAt,
      scope: 'redbook-small-diagnostic',
      listBudget: 1,
      detailBudget: 1,
      maxImages: 2,
    };
  }
  authorize(token, proof) {
    this.sweep();
    const g = this.grant;
    if (
      !g ||
      !nonce(token) ||
      !nonce(proof) ||
      !equal(token, g.token) ||
      !equal(proof, g.proof)
    )
      throw fail('CONFIRMATION_REQUIRED');
    return g;
  }
  current(g) {
    this.sweep();
    return this.grant === g && !g.abort.signal.aborted;
  }
  revoke() {
    this.pending = null;
    clearTimeout(this.timer);
    this.timer = null;
    const old = this.grant;
    this.grant = null;
    if (old) {
      old.abort.abort();
      old.sampleCache = null;
    }
    if (!this.clearing && (old || this.cleanupFailed)) {
      this.clearing = Promise.resolve()
        .then(() => this.onRevoke())
        .then(() => {
          this.cleanupFailed = false;
        })
        .catch(() => {
          this.cleanupFailed = true;
          throw fail('CLEANUP_FAILED', 409);
        })
        .finally(() => {
          this.clearing = null;
        });
    }
    return this.clearing || Promise.resolve();
  }
}
function directLocal(req, port, requireOrigin = true) {
  if (
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
      req.socket.remoteAddress || '',
    )
  )
    return false;
  if (
    Object.keys(req.headers).some(
      (k) =>
        k.toLowerCase() === 'forwarded' ||
        k.toLowerCase() === 'via' ||
        k.toLowerCase().startsWith('x-forwarded-'),
    )
  )
    return false;
  const host = req.headers.host;
  if (
    typeof host !== 'string' ||
    !new RegExp(
      '^(127\\.0\\.0\\.1|localhost|\\[::1\\]):' + port + '$',
      'i',
    ).test(host)
  )
    return false;
  return requireOrigin
    ? req.headers.origin === 'http://' + host
    : req.headers.origin === undefined ||
        req.headers.origin === 'http://' + host;
}
async function readJSON(req) {
  if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json')
    throw fail('JSON_REQUIRED', 415);
  let bytes = 0,
    parts = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4000000) throw fail('INPUT_LIMIT', 413);
    parts.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw fail('JSON_REQUIRED', 422);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw fail('INPUT_REJECTED', 422);
  return body;
}
const keys = (body, allowed) => {
  if (Object.keys(body).some((k) => !allowed.includes(k)))
    throw fail('INPUT_REJECTED', 422);
};
function gateway({
  port = 49163,
  backend,
  html,
  script,
  css = '',
  clock,
  onControl = () => {},
}) {
  const authority = new PairAuthority({
    clock,
    onRevoke: () => backend('discard', {}),
  });
  let running = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    const send = (status, data) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
    };
    try {
      const actualPort = server.address()?.port || port;
      if (!directLocal(req, actualPort, req.method !== 'GET'))
        throw fail('DIRECT_LOCAL_ONLY');
      if (req.method === 'GET' && (req.url === '/' || req.url === '/pair')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
        return;
      }
      if (req.method === 'GET' && req.url === '/pair.js') {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(script);
        return;
      }
      if (req.method === 'GET' && req.url === '/pair.css') {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.end(css);
        return;
      }
      if (req.method !== 'POST') throw fail('ROUTE_DISABLED', 404);
      const body = await readJSON(req);
      if (req.url === '/pair/start') {
        keys(body, ['proof']);
        const result = authority.start(body.proof);
        onControl({ status: 'confirmation_requested' });
        send(200, result);
        return;
      }
      if (req.url === '/pair/redeem') {
        keys(body, ['pairId', 'proof']);
        const result = authority.redeem(body.pairId, body.proof);
        send(result.waiting ? 202 : 200, result);
        return;
      }
      if (
        !/^\/diagnostic\/(status|creator|session|list|detail|images|sample|discard)$/.test(
          req.url || '',
        )
      )
        throw fail('ROUTE_DISABLED', 404);
      const auth = req.headers.authorization;
      const g = authority.authorize(
        typeof auth === 'string' && auth.startsWith('Bearer ')
          ? auth.slice(7)
          : '',
        req.headers['x-redbook-browser-proof'],
      );
      const action = req.url.slice('/diagnostic/'.length);
      if (action === 'discard') {
        keys(body, []);
        await authority.revoke();
        send(200, { revoked: true });
        return;
      }
      if (running) throw fail('DIAGNOSTIC_BUSY', 409);
      if (action === 'creator') {
        keys(body, ['displayName', 'profileUrl']);
        if (
          typeof body.displayName !== 'string' ||
          !body.displayName.trim() ||
          body.displayName.length > 120 ||
          typeof body.profileUrl !== 'string' ||
          !/^https:\/\/www\.xiaohongshu\.com\/user\/profile\/[a-zA-Z0-9_-]{1,128}$/.test(
            body.profileUrl,
          )
        )
          throw fail('PROFILE_REJECTED', 422);
        if (g.creatorId) throw fail('ONE_CREATOR_ONLY', 409);
      } else if (action === 'session') {
        keys(body, ['cookies', 'expiresAt', 'confirmLocalSession']);
        if (
          !g.creatorId ||
          body.confirmLocalSession !== true ||
          !Number.isSafeInteger(body.expiresAt) ||
          body.expiresAt <= authority.clock() ||
          body.expiresAt > Math.min(authority.clock() + ACCESS_MS, g.expiresAt)
        )
          throw fail('XHS_SESSION_LIMIT', 422);
        body.creatorId = g.creatorId;
      } else if (action === 'list') {
        keys(body, ['confirmRequest']);
        if (body.confirmRequest !== true)
          throw fail('EXPLICIT_REQUEST_REQUIRED', 422);
        if (g.listSpent) throw fail('LIST_BUDGET_USED', 409);
        g.listSpent = true;
      } else if (action === 'detail') {
        keys(body, ['confirmRequest', 'noteId']);
        if (
          body.confirmRequest !== true ||
          typeof body.noteId !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(body.noteId)
        )
          throw fail('EXPLICIT_REQUEST_REQUIRED', 422);
        if (!g.listSpent || g.detailSpent)
          throw fail('DETAIL_BUDGET_USED', 409);
        g.detailSpent = true;
      } else if (action === 'images') {
        keys(body, ['confirmImages', 'maxImages', 'maxBytes']);
        if (
          body.confirmImages !== true ||
          !Number.isInteger(body.maxImages) ||
          body.maxImages < 1 ||
          body.maxImages > 2 ||
          !Number.isInteger(body.maxBytes) ||
          body.maxBytes < 1024 ||
          body.maxBytes > 1000000
        )
          throw fail('IMAGE_LIMIT', 422);
        if (!g.detailSpent || g.imagesSpent)
          throw fail('IMAGE_BUDGET_USED', 409);
        g.imagesSpent = true;
      } else keys(body, []);
      running = true;
      try {
        const collect = async () => {
          try {
            const sample = await backend('sample', {}, g.abort.signal);
            if (authority.current(g))
              g.sampleCache = {
                list: sample.list,
                detail: sample.detail,
                images: sample.images || [],
                reviewed: false,
                archiveAllowed: false,
                sampleCached: true,
              };
          } catch {}
        };
        let result;
        if (action === 'sample' && g.sampleCache) result = g.sampleCache;
        else {
          try {
            result = await backend(action, body, g.abort.signal);
          } finally {
            if (['list', 'detail', 'images'].includes(action)) await collect();
          }
          if (action === 'sample') {
            g.sampleCache = {
              list: result.list,
              detail: result.detail,
              images: result.images || [],
              reviewed: false,
              archiveAllowed: false,
              sampleCached: true,
            };
            result = g.sampleCache;
          }
        }
        if (!authority.current(g)) throw fail('CONFIRMATION_REQUIRED');
        if (action === 'creator') {
          if (typeof result.creator?.id !== 'string')
            throw fail('CREATOR_REJECTED', 422);
          g.creatorId = result.creator.id;
          g.profileUrl = body.profileUrl;
        }
        send(200, {
          data: result,
          accessExpiresAt: g.expiresAt,
          accessScope: 'redbook-small-diagnostic',
          accessBudget: {
            list: Number(g.listSpent),
            detail: Number(g.detailSpent),
            images: Number(g.imagesSpent),
          },
        });
      } finally {
        running = false;
      }
    } catch (error) {
      if (!res.headersSent)
        send(error.safeCode ? error.status : 422, {
          code: error.safeCode || 'DIAGNOSTIC_REJECTED',
          message: '操作未完成；需要本机确认或请求已到预算。不自动重试。',
        });
      else res.destroy();
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.on('close', () => {
    void authority.revoke().catch(() => {});
  });
  return {
    server,
    authority,
    async close() {
      try {
        await authority.revoke();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
module.exports = { ACCESS_MS, PAIR_MS, PairAuthority, directLocal, gateway };
