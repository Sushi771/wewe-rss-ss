// Boot the actual built Nest HTTP server twice against an already-rehearsed copy.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { parseArgs } = require('node:util');
const options = parseArgs({
  options: {
    copy: { type: 'string' },
    manifest: { type: 'string' },
    'runtime-root': { type: 'string' },
    'expect-created': { type: 'string' },
  },
}).values;
const runtime = fs.realpathSync(options['runtime-root']);
process.env.ALBUM_QA_RUNTIME_ROOT = runtime;
const {
  snapshot,
  preservation,
  inside,
} = require('./album-acceptance-rehearsal.cjs');
const privateRoot = path.join(runtime, 'private-data', 'album-loop-qa');
const database = fs.realpathSync(options.copy);
assert(inside(privateRoot, database), 'HTTP_ACCEPTANCE_ONLY_PRIVATE_COPY');
const root = path.join(path.dirname(database), `http-${crypto.randomUUID()}`);
fs.mkdirSync(root);
const manifest = fs.realpathSync(options.manifest);
const before = snapshot(database);
const launch = path.join(root, 'launch');
fs.mkdirSync(path.join(launch, 'prisma'), { recursive: true });
fs.mkdirSync(path.join(launch, 'scripts'));
const server = path.join(runtime, 'apps/server');
for (const file of [
  'package.json',
  'prisma/schema.prisma',
  'scripts/backup-sqlite.py',
])
  fs.copyFileSync(path.join(server, file), path.join(launch, file));

async function port() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const selected = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return selected;
}
async function main() {
  const stages = [];
  for (const stage of ['start', 'restart']) {
    const auth = crypto.randomBytes(32).toString('hex');
    const listenPort = await port();
    const base = `http://127.0.0.1:${listenPort}`;
    const log = fs.openSync(path.join(root, `${stage}.log`), 'wx');
    // Clean launch cwd has no .env. Only OS/runtime variables are inherited.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|USERPROFILE|SQLITE_BACKUP_PYTHON)$/i.test(
          key,
        ),
      ),
    );
    Object.assign(env, {
      DATABASE_URL: `file:${database.replace(/\\/g, '/')}`,
      DATABASE_TYPE: 'sqlite',
      HOST: '127.0.0.1',
      PORT: String(listenPort),
      NODE_ENV: 'development',
      PRIVATE_ONLINE_MODE: '1',
      AUTH_CODE: auth,
      DISABLE_SCHEDULED_UPDATES: '1',
      PLATFORM_URL: 'http://127.0.0.1:9',
      UPDATE_DELAY_TIME: '0',
      OBSIDIAN_PATH: path.join(root, 'unused-vault'),
      SERVER_ORIGIN_URL: base,
      ALBUM_QA_RUNTIME_ROOT: runtime,
      ALBUM_QA_MANIFEST: manifest,
      ALBUM_QA_NETWORK_REPORT: path.join(root, `${stage}-network.json`),
    });
    const child = spawn(
      process.execPath,
      [
        '--require',
        path.join(__dirname, 'album-service-replay-preload.cjs'),
        path.join(server, 'dist/apps/server/src/main.js'),
      ],
      {
        cwd: launch,
        env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', log, log],
      },
    );
    let exited = false;
    const closed = new Promise((resolve) =>
      child.once('close', () => {
        exited = true;
        resolve();
      }),
    );
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (exited) throw new Error('HTTP_SERVER_EARLY_EXIT_CHECK_PRIVATE_LOG');
        try {
          ready =
            (
              await fetch(`${base}/auth/login`, {
                signal: AbortSignal.timeout(1000),
              })
            ).status !== 0;
        } catch {}
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert(ready, 'HTTP_SERVER_NOT_READY');
      const endpoint = `${base}/trpc/feed.refreshArticles`;
      const anon = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mpId: 'MP_WXS_3895431412' }),
      });
      assert.equal(anon.status, 401);
      const login = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: auth }),
      });
      assert.equal(login.status, 204);
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert(cookie?.startsWith('wewe_private_session='));
      const update = await fetch(endpoint, {
        method: 'POST',
        headers: { cookie, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ mpId: 'MP_WXS_3895431412' }),
        signal: AbortSignal.timeout(180000),
      });
      const body = await update.json();
      fs.writeFileSync(
        path.join(root, `${stage}-update.json`),
        JSON.stringify(body),
      );
      assert.equal(update.status, 200, 'AUTHENTICATED_UPDATE_FAILED');
      const result = body.result?.data?.[0] || body.result?.data?.json?.[0];
      assert(result, 'HTTP_UPDATE_RESULT_SHAPE');
      assert.equal(result.created, Number(options['expect-created'] || '0'));
      assert.equal(result.source, 'public-album');
      assert.equal(result.coverage, 'selected-albums');
      const rss = await fetch(
        `${base}/feeds/MP_WXS_3895431412.rss?mode=fulltext&limit=5000`,
        { headers: { cookie } },
      );
      assert.equal(rss.status, 200);
      fs.writeFileSync(path.join(root, `${stage}.rss`), await rss.text());
      const zip = await fetch(`${base}/download/feed/MP_WXS_3895431412.zip`, {
        headers: { cookie },
        signal: AbortSignal.timeout(180000),
      });
      assert.equal(zip.status, 200);
      const bytes = Buffer.from(await zip.arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304');
      fs.writeFileSync(path.join(root, `${stage}.zip`), bytes);
      preservation(before, snapshot(database), true);
      stages.push({
        stage,
        unauthorizedUpdate: anon.status,
        authenticatedUpdate: update.status,
        created: result.created,
        articles: result.articles,
        rss: rss.status,
        zip: zip.status,
        zipBytes: bytes.length,
      });
    } finally {
      child.kill();
      await closed;
      fs.closeSync(log);
    }
  }
  const report = {
    boundary:
      'actual Nest HTTP service/start/restart; upstream real-response offline replay only',
    cronDisabled: true,
    stages,
    oldArticlesUnchanged: true,
    reportDirectory: root,
  };
  fs.writeFileSync(
    path.join(root, 'result.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
main().catch(() => {
  console.error('HTTP_ACCEPTANCE_FAILED_CHECK_PRIVATE_LOG');
  process.exitCode = 1;
});
