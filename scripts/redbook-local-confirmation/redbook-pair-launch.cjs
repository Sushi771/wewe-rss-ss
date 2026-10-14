'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  net = require('node:net'),
  readline = require('node:readline'),
  Module = require('node:module');
const { randomBytes, randomUUID } = require('node:crypto');
// These arguments contain paths only, never passwords or account credentials.
const repo = path.resolve(__dirname, '../..');
const artifact = process.argv[2] && path.resolve(process.argv[2]);
const dir = path.join(
  require('node:os').tmpdir(),
  'wewe-redbook-diagnostic-' + randomUUID(),
);
const PUBLIC_PORT = 49163,
  INNER_PORT = 49164;
const controlWriter = process.stdout.write.bind(process.stdout);
const control = (message) =>
  controlWriter('REDBOOK_CONTROL:' + JSON.stringify(message) + '\n');
// Startup diagnostics contain fixed enums only; never error messages or app logs.
const startupBegan = performance.now();
let startupPhase = 'NODE_ENTERED',
  startupComplete = false;
const startupProgress = (phase) => {
  startupPhase = phase;
  control({
    status: 'starting',
    phase,
    elapsedMs: Math.round(performance.now() - startupBegan),
  });
};
const startupFailure = (error) => {
  if (startupComplete) return;
  const code = [
    'MODULE_NOT_FOUND',
    'ENOENT',
    'EACCES',
    'EADDRINUSE',
    'P1001',
    'P1002',
    'P1003',
  ].includes(error?.code)
    ? error.code
    : error?.message === 'LOCAL_BACKEND_NOT_READY'
      ? 'BACKEND_NOT_READY'
      : 'BOOTSTRAP_ERROR';
  control({ status: 'startup_rejected', phase: startupPhase, code });
  process.exit(1);
};
process.on('unhandledRejection', startupFailure);
process.on('uncaughtException', startupFailure);
startupProgress('NODE_ENTERED');
// Application logs, HTTP bodies and credentials never enter the launcher pipe/log.
const discard = (...args) => {
  const callback = args.find((arg) => typeof arg === 'function');
  if (callback) queueMicrotask(callback);
  return true;
};
process.stdout.write = discard;
process.stderr.write = discard;
let surface,
  closing = false;
const owner = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
async function stop() {
  if (closing) return;
  closing = true;
  try {
    if (surface) await surface.close();
  } catch {
  } finally {
    control({ status: 'stopped' });
    process.exit(0);
  }
}
owner.on('close', () => {
  void stop();
});
owner.on('line', (line) => {
  try {
    const message = JSON.parse(line.replace(/^\uFEFF/, ''));
    if (message.action === 'stop') {
      void stop();
      return;
    }
    if (!surface) {
      control({ status: 'not_ready' });
      return;
    }
    if (message.action === 'revoke') {
      void surface.authority.revoke().then(
        () => control({ status: 'revoked' }),
        () => control({ status: 'cleanup_failed' }),
      );
      return;
    }
    if (message.action === 'approve') {
      control({
        status: surface.authority.approve(message.comparison)
          ? 'approved_24_hours'
          : 'comparison_rejected',
      });
      return;
    }
    control({ status: 'command_rejected' });
  } catch {
    control({ status: 'command_rejected' });
  }
});
async function portCheck(port) {
  const server = net.createServer();
  await new Promise((ok, bad) => {
    server.once('error', bad);
    server.listen(port, '127.0.0.1', ok);
  });
  await new Promise((ok) => server.close(ok));
}
async function main() {
  startupProgress('ARTIFACT_CHECK');
  if (
    !artifact ||
    !fs.existsSync(path.join(artifact, 'server-dist/apps/server/src/main.js'))
  )
    throw Error('COMPILED_ARTIFACT_REQUIRED');

  startupProgress('PORT_CHECK');
  await portCheck(PUBLIC_PORT);
  await portCheck(INNER_PORT);
  fs.mkdirSync(dir, { recursive: false });
  startupProgress('GATEWAY_LOAD');
  const { gateway } = require('./redbook-pair-gateway.cjs');
  const keep =
    /^(path|systemroot|windir|comspec|pathext|userprofile|appdata|localappdata|programdata|programfiles(?:\(x86\))?|number_of_processors|processor_architecture|systemdrive)$/i;
  process.env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => keep.test(key)),
  );
  process.env.NODE_PATH = repo + '/apps/server/node_modules';
  Module._initPaths();
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (name, ...args) {
    return resolve.call(
      this,
      name.startsWith('@server/')
        ? path.join(artifact, 'server-dist/apps/server/src', name.slice(8))
        : name,
      ...args,
    );
  };
  const allowed = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    'edith.xiaohongshu.com',
    'sns-webpic-qc.xhscdn.com',
    'sns-webpic.xhscdn.com',
  ]);
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host =
      first && typeof first === 'object'
        ? first.host
        : typeof args[1] === 'string'
          ? args[1]
          : undefined;
    const port = first && typeof first === 'object' ? first.port : first;
    if (
      (host && !allowed.has(String(host).toLowerCase())) ||
      Number(port) === 4000
    )
      throw Error('ISOLATED_TARGET_DENIED');
    return connect.apply(this, args);
  };
  const internalCode = randomBytes(32).toString('base64url'); // authorized this-run internal protection; never given to browser
  if (!fs.existsSync(path.join(artifact, 'web-dist')))
    throw Error('COMPILED_FRONTEND_REQUIRED');
  fs.symlinkSync(
    path.join(artifact, 'web-dist'),
    path.join(dir, 'client'),
    'junction',
  );
  const database = path.join(dir, 'synthetic.sqlite'),
    tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  Object.assign(process.env, {
    HOST: '127.0.0.1',
    PORT: String(INNER_PORT),
    NODE_ENV: 'production',
    AUTH_CODE: internalCode,
    PRIVATE_ONLINE_MODE: '1',
    DATABASE_TYPE: 'sqlite',
    DATABASE_URL: 'file:' + database.replace(/\\/g, '/'),
    SERVER_ORIGIN_URL: 'http://127.0.0.1:' + INNER_PORT,
    PLATFORM_URL: 'http://127.0.0.1:1',
    DISABLE_SCHEDULED_UPDATES: '1',
    ENABLE_SCHEDULED_UPDATES: '0',
    WECHAT_DESKTOP_ALLOW_SCHEDULED: '0',
    WECHAT_DESKTOP_MP_IDS: '',
    OBSIDIAN_PATH: path.join(dir, 'empty-vault'),
    TEMP: tmp,
    TMP: tmp,
  });
  startupProgress('DATABASE_INIT');
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  if (!fs.existsSync(database))
    for (const folder of fs
      .readdirSync(repo + '/apps/server/prisma/migrations', {
        withFileTypes: true,
      })
      .filter((x) => x.isDirectory())
      .map((x) => x.name)
      .sort())
      for (const statement of fs
        .readFileSync(
          repo + '/apps/server/prisma/migrations/' + folder + '/migration.sql',
          'utf8',
        )
        .split(';')
        .map((x) => x.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'wewe-redbook-diagnostic',
      version:
        JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
          .version || '0.0.0',
    }),
  );
  startupProgress('BACKEND_LOAD');
  process.chdir(dir);
  require(path.join(artifact, 'server-dist/apps/server/src/main.js'));
  const rawRequest = (route, body, signal, cookie) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port: INNER_PORT,
          path: route,
          method: 'POST',
          headers: {
            origin: 'http://127.0.0.1:' + INNER_PORT,
            authorization: internalCode,
            'content-type': 'application/json',
            ...(cookie ? { cookie } : {}),
          },
          signal,
        },
        (response) => {
          let count = 0,
            parts = [];
          response.on('data', (chunk) => {
            count += chunk.length;
            if (count > 8000000) {
              response.destroy();
              reject(Error('LOCAL_RESPONSE_LIMIT'));
            } else parts.push(chunk);
          });
          response.on('error', () => reject(Error('LOCAL_BACKEND_REJECTED')));
          response.on('end', () => {
            if (response.statusCode >= 400) {
              reject(Error('LOCAL_BACKEND_REJECTED'));
              return;
            }
            const raw = Buffer.concat(parts).toString('utf8');
            let value = {};
            try {
              if (raw) value = JSON.parse(raw);
            } catch {
              reject(Error('LOCAL_BACKEND_REJECTED'));
              return;
            }
            resolve({
              value,
              cookie: response.headers['set-cookie']?.[0]?.split(';')[0],
            });
          });
        },
      );
      request.setTimeout(20000, () =>
        request.destroy(Error('LOCAL_BACKEND_TIMEOUT')),
      );
      request.on('error', () => reject(Error('LOCAL_BACKEND_REJECTED')));
      request.end(JSON.stringify(body));
    });
  startupProgress('BACKEND_PROBE');
  let backendReady = false;
  for (
    let attempt = 0;
    attempt < 40 && performance.now() - startupBegan < 35000;
    attempt++
  ) {
    try {
      await rawRequest(
        '/local/redbook/diagnostic/status',
        {},
        AbortSignal.timeout(
          Math.max(
            1,
            Math.min(
              2000,
              Math.floor(35000 - (performance.now() - startupBegan)),
            ),
          ),
        ),
      );
      backendReady = true;
      break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!backendReady) throw Error('LOCAL_BACKEND_NOT_READY');
  const backend = async (action, body, signal) => {
    if (action === 'creator') {
      if (signal?.aborted) throw Error('CANCELLED');
      const creator = await prisma.xhsCreator.upsert({
        where: { profileUrl: body.profileUrl },
        create: {
          id: randomUUID(),
          profileUrl: body.profileUrl,
          displayName: body.displayName.trim(),
        },
        update: {},
      });
      return {
        creator: {
          id: creator.id,
          profileUrl: creator.profileUrl,
          displayName: creator.displayName,
        },
        subscribed: false,
      };
    }
    return (
      await rawRequest('/local/redbook/diagnostic/' + action, body, signal)
    ).value;
  };
  startupProgress('GATEWAY_LISTEN');
  surface = gateway({
    port: PUBLIC_PORT,
    backend,
    html: fs.readFileSync(path.join(__dirname, 'redbook-pair.html'), 'utf8'),
    script: fs.readFileSync(path.join(__dirname, 'redbook-pair.js'), 'utf8'),
    css: fs.readFileSync(path.join(__dirname, 'redbook-pair.css'), 'utf8'),
    onControl: control,
  });
  await new Promise((ok, bad) => {
    surface.server.once('error', bad);
    surface.server.listen(PUBLIC_PORT, '127.0.0.1', ok);
  });
  startupComplete = true;
  control({
    status: 'ready',
    url: 'http://127.0.0.1:' + PUBLIC_PORT + '/pair',
    scope: 'small-diagnostic-only',
    durationHours: 24,
  });
}
main().catch(startupFailure);
