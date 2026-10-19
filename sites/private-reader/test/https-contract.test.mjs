// Local simulation only. No Sites identity proof, real app caller or tunnel.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateReaderWorker } from '../worker.mjs';
import {
  createReaderController,
  createReaderRequest,
} from '../reader-model.mjs';
import { fixture, authorId, itemId } from './fixtures.mjs';

const authors = { action: 'authors', platform: 'wechat' };
const readActions = new Set([
  'capability',
  'authors',
  'items',
  'body',
  'download',
]);
const fail = (code) => Object.assign(Error(code), { code });

function ephemeralTLS() {
  const directory = mkdtempSync(join(tmpdir(), 'sites-https-synthetic-'));
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  try {
    const executable =
      process.platform === 'win32'
        ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'
        : 'openssl';
    execFileSync(
      executable,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  } finally {
    // Only exact files created by this function; no recursive cleanup.
    for (const file of [keyPath, certPath]) {
      try {
        unlinkSync(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    rmdirSync(directory);
  }
}

async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  assert.equal(server.address().address, '127.0.0.1');
  return `https://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}
async function boundedBody(request, limit = 32768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw fail('BAD_REQUEST');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Explicit CA trust for this connection only. Never disable TLS validation.
function wire(url, { ca, method = 'POST', headers = {}, body, signal } = {}) {
  assert.equal(new URL(url).hostname, '127.0.0.1');
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      { ca, method, headers, signal, agent: false },
      (reply) => {
        const chunks = [];
        let size = 0;
        reply.on('data', (chunk) => {
          size += chunk.length;
          if (size > 6000000) reply.destroy(fail('BAD_RESPONSE'));
          else chunks.push(chunk);
        });
        reply.on('error', reject);
        reply.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: reply.statusCode,
              headers: reply.headers,
            }),
          ),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

async function simulation(t) {
  const tls = ephemeralTLS();
  const machineSecret = randomBytes(32).toString('hex');
  let suppliedSecret = machineSecret;
  let viewer = 'owner'; // Simulated trusted dispatch, never read from HTTP headers.
  let mode = 'online';
  let appAuthorized = true; // Independent synthetic app authentication result.
  const f = fixture();
  const deniedApp = fixture({ localViewer: 'other' });
  const audit = [];
  let gatewayRequests = 0;
  const record = (hop, code) => audit.push({ hop, code });
  const replyJSON = (response, status, value) => {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    });
    response.end(JSON.stringify(value));
  };
  const gateway = https.createServer(tls, async (request, response) => {
    gatewayRequests++;
    try {
      // No query, other path, arbitrary URL, write action or credential passthrough.
      if (request.url !== '/private/read' || request.method !== 'POST')
        throw fail('NOT_FOUND');
      const received = Buffer.from(request.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${machineSecret}`);
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      )
        throw fail('UNAUTHORIZED');
      if (request.headers['content-type'] !== 'application/json')
        throw fail('BAD_REQUEST');
      const command = JSON.parse(await boundedBody(request));
      if (!readActions.has(command.action) || command.platform !== 'wechat')
        throw fail('BAD_REQUEST');
      if (mode === 'timeout') return; // Aborted by server transport deadline.
      const result = await (appAuthorized ? f : deniedApp).gateway.execute(
        command,
        {},
      );
      record('gateway', 'OK');
      replyJSON(response, 200, { ok: true, data: result });
    } catch (error) {
      const code = [
        'UNAUTHORIZED',
        'BAD_REQUEST',
        'NOT_FOUND',
        'FORBIDDEN',
      ].includes(error.code)
        ? error.code
        : 'BAD_REQUEST';
      record('gateway', code);
      replyJSON(
        response,
        code === 'UNAUTHORIZED'
          ? 401
          : code === 'NOT_FOUND'
            ? 404
            : code === 'FORBIDDEN'
              ? 403
              : 400,
        { ok: false, code },
      );
    }
  });
  const gatewayURL = await listen(gateway);
  const gatewayPort = gateway.address().port;
  t.after(() => close(gateway));
  const worker = createPrivateReaderWorker({
    authorize: async () =>
      viewer === null ? null : { isOwner: viewer === 'owner' },
    browserScript: '/* synthetic browser asset; no connection configuration */',
    transport: {
      async send(command, { signal }) {
        try {
          const response = await wire(gatewayURL + '/private/read', {
            ca: tls.cert,
            signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
            headers: {
              'content-type': 'application/json',
              ...(suppliedSecret
                ? { authorization: `Bearer ${suppliedSecret}` }
                : {}),
            },
            body: JSON.stringify(command),
          });
          const result = await response.json();
          if (!response.ok || result.ok !== true)
            throw fail(result.code || 'PC_UNAVAILABLE');
          return result.data;
        } catch (error) {
          if (error.name === 'AbortError') throw fail('REQUEST_TIMEOUT');
          throw error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN'
            ? error
            : fail('PC_UNAVAILABLE');
        }
      },
    },
  });
  const proxy = https.createServer(tls, async (incoming, outgoing) => {
    try {
      const body = await boundedBody(incoming);
      const request = new Request(proxyURL + incoming.url, {
        method: incoming.method,
        headers: incoming.headers,
        ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body }),
      });
      const response = await worker.fetch(request);
      record('proxy', String(response.status));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      record('proxy', 'BAD_REQUEST');
      replyJSON(outgoing, 400, { ok: false, code: 'BAD_REQUEST' });
    }
  });
  const proxyURL = await listen(proxy);
  t.after(() => close(proxy));
  const requests = [];
  const fetchImpl = async (endpoint, options) => {
    assert.equal(endpoint, '/api/subscriptions');
    requests.push({ endpoint, ...options });
    return wire(proxyURL + endpoint, {
      ...options,
      ca: tls.cert,
      headers: { ...options.headers, origin: proxyURL },
    });
  };
  return {
    f,
    deniedApp,
    audit,
    requests,
    machineSecret,
    gatewayURL,
    proxyURL,
    tls,
    fetchImpl,
    read: createReaderRequest({ fetchImpl }),
    raw: (command, headers = {}) =>
      wire(proxyURL + '/api/subscriptions', {
        ca: tls.cert,
        headers: {
          origin: proxyURL,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(command),
      }),
    get gatewayRequests() {
      return gatewayRequests;
    },
    setViewer(value) {
      viewer = value;
    },
    setSecret(value) {
      suppliedSecret = value;
    },
    setMode(value) {
      mode = value;
    },
    setAppAuthorized(value) {
      appAuthorized = value;
    },
    async offline() {
      await close(gateway);
    },
    async reconnect() {
      await listen(gateway, gatewayPort);
    },
  };
}

test('loopback HTTPS: original client -> server proxy -> original read gateway, synthetic body/download', async (t) => {
  const s = await simulation(t);
  const controller = createReaderController({ request: s.read });
  await controller.loadAuthors();
  await controller.openAuthor(authorId);
  await controller.openItem(itemId);
  assert.equal(controller.getState().body.title, 'Synthetic owner article');
  const download = await controller.download();
  assert.match(await download.blob.text(), /Synthetic body/);
  assert.deepEqual(
    s.f.calls.map(([name]) => name),
    ['feed.list', 'article.list', 'article.byId', 'article.byId'],
  );
  for (const request of s.requests) {
    assert.equal(request.credentials, 'same-origin');
    assert.equal(request.redirect, 'error');
    assert.deepEqual(Object.keys(request.headers), ['Content-Type']);
  }
  const publicPage = await wire(s.proxyURL + '/', {
    ca: s.tls.cert,
    method: 'GET',
  });
  const publicJS = await wire(s.proxyURL + '/reader.js', {
    ca: s.tls.cert,
    method: 'GET',
  });
  const browserBytes =
    JSON.stringify(s.requests) +
    (await publicPage.text()) +
    (await publicJS.text()) +
    JSON.stringify(controller.getState());
  assert(!browserBytes.includes(s.machineSecret));
  assert(!browserBytes.includes(s.gatewayURL));
  assert(!browserBytes.includes('PRIVATE_TOKEN'));
  assert(s.audit.length > 0);
  assert(
    s.audit.every((record) => Object.keys(record).join(',') === 'hop,code'),
  );
  assert.doesNotMatch(
    JSON.stringify(s.audit),
    /Synthetic body|cached-synthetic|authorization|Bearer|PRIVATE_TOKEN|synthetic-item/i,
  );
  assert(!JSON.stringify(s.audit).includes(s.machineSecret));
});

test('loopback HTTPS: missing/other visitor and forged owner headers never reach gateway', async (t) => {
  const s = await simulation(t);
  for (const [viewer, status, code] of [
    [null, 401, 'UNAUTHORIZED'],
    ['other', 403, 'FORBIDDEN'],
  ]) {
    s.setViewer(viewer);
    const response = await s.raw(authors, {
      'oai-authenticated-user-id': 'owner',
      'x-is-owner': 'true',
      authorization: 'Bearer claimed-owner',
      'oai-sites-authorization': 'Bearer service-is-not-visitor',
    });
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
  }
  assert.equal(s.gatewayRequests, 0);
  assert.equal(s.f.calls.length, 0);
});

test('loopback HTTPS: machine auth and app auth are both mandatory', async (t) => {
  const s = await simulation(t);
  for (const secret of [null, 'wrong-machine-secret']) {
    s.setSecret(secret);
    await assert.rejects(s.read(authors), { code: 'UNAUTHORIZED' });
  }
  assert.equal(s.f.calls.length, 0);
  s.setSecret(s.machineSecret);
  s.setAppAuthorized(false);
  await assert.rejects(s.read(authors), { code: 'FORBIDDEN' });
  assert.equal(s.deniedApp.calls.length, 0);
  s.setAppAuthorized(true);
  assert.equal((await s.read(authors)).items.length, 1);
});

test('loopback HTTPS: timeout, offline and explicit reconnect preserve error state without retries', async (t) => {
  const s = await simulation(t);
  const controller = createReaderController({ request: s.read });
  s.setMode('timeout');
  await controller.loadAuthors();
  // Original Worker contract maps an upstream deadline to PC_UNAVAILABLE.
  assert.equal(controller.getState().status, 'offline');
  assert.equal(s.gatewayRequests, 1);
  assert.equal(s.f.calls.length, 0);
  s.setMode('online');
  await s.offline();
  await controller.loadAuthors();
  assert.equal(controller.getState().status, 'offline');
  assert.equal(controller.getState().body, null);
  assert.equal(s.requests.length, 2);
  await s.reconnect();
  await controller.loadAuthors();
  assert.equal(controller.getState().authors.length, 1);
  assert.equal(s.requests.length, 3);
  assert.equal(s.f.calls.length, 1);
});

test('loopback HTTPS: browser deadline explicitly reports timeout and makes one attempt', async (t) => {
  const s = await simulation(t);
  s.setMode('timeout');
  const controller = createReaderController({
    request: createReaderRequest({ fetchImpl: s.fetchImpl, timeoutMs: 60 }),
  });
  await controller.loadAuthors();
  assert.equal(controller.getState().status, 'timeout');
  assert.equal(controller.getState().body, null);
  assert.equal(s.requests.length, 1);
  assert.equal(s.f.calls.length, 0);
});

test('loopback HTTPS: narrow routes, writes, arbitrary parameters and untrusted TLS fail closed', async (t) => {
  const s = await simulation(t);
  for (const command of [
    { action: 'refresh', platform: 'wechat', authorId },
    {
      action: 'status',
      platform: 'wechat',
      operationId: 'synthetic-operation',
    },
    { ...authors, url: 'https://attacker.invalid' },
    { ...authors, path: 'C:\\private' },
  ])
    assert.equal((await s.raw(command)).ok, false);
  assert.equal(s.gatewayRequests, 0);
  for (const [method, path] of [
    ['GET', '/private/read'],
    ['POST', '/trpc'],
    ['POST', '/private/read?url=x'],
  ]) {
    const response = await wire(s.gatewayURL + path, {
      ca: s.tls.cert,
      method,
    });
    assert.equal(response.status, 404);
  }
  const response = await wire(s.gatewayURL + '/private/read', {
    ca: s.tls.cert,
    headers: {
      authorization: `Bearer ${s.machineSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'refresh', platform: 'wechat', authorId }),
  });
  assert.equal(response.status, 400);
  await assert.rejects(wire(s.gatewayURL + '/private/read'), {
    code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
  });
  assert.equal(s.f.calls.length, 0);
});
