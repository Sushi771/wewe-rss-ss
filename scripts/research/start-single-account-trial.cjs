#!/usr/bin/env node
'use strict';
// Start the existing application against a consistent private copy. This first
// read/export trial has no live update wiring and forbids outbound operations.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'),
  server = path.join(root, 'apps/server');
const privateRoot = path.join(
  root,
  'private-data/single-account-update-20260930',
);
let source = path.join(
  privateRoot,
  'replay-5d1163f9-eb4a-491c-98e7-01e5aa05d3d3/export-only.db',
);
let startedChild;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function noLinks(p) {
  for (let at = path.resolve(p); ; at = path.dirname(at)) {
    if (fs.lstatSync(at).isSymbolicLink()) throw Error('TRIAL_REPARSE_PATH');
    if (path.dirname(at) === at) break;
  }
}
function copyTree(from, to) {
  noLinks(from);
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name),
      dst = path.join(to, entry.name);
    if (entry.isSymbolicLink()) throw Error('TRIAL_LINKED_BUILD');
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--restart'))
    throw Error('usage: start-single-account-trial.cjs [--restart]');
  let previous, previousPrivate;
  const activeFile = path.join(privateRoot, 'active-page-trial.json');
  if (args[0] === '--restart') {
    previous = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
    if (
      !path.resolve(previous.dir).startsWith(privateRoot + path.sep) ||
      path.resolve(previous.database) !== path.join(previous.dir, 'trial.db')
    )
      throw Error('TRIAL_RESTART_PATH_GATE');
    noLinks(previous.dir);
    noLinks(previous.database);
    previousPrivate = JSON.parse(
      fs.readFileSync(path.join(previous.dir, 'private-config.json'), 'utf8'),
    );
    if (!/^[a-f0-9]{64}$/.test(previousPrivate.accessCode))
      throw Error('TRIAL_PRIVATE_CONFIG_GATE');
    source = previous.database;
  }
  noLinks(source);
  noLinks(privateRoot);
  const production = path.join(server, 'data/wewe-rss.db'),
    productionHash = sha(fs.readFileSync(production));
  const dir = fs.mkdtempSync(path.join(privateRoot, 'page-trial-'));
  const runtime = path.join(dir, 'runtime');
  fs.mkdirSync(runtime);
  for (const name of ['attachments', 'exports', 'tmp', 'backups'])
    fs.mkdirSync(path.join(dir, name));
  copyTree(path.join(server, 'dist'), path.join(runtime, 'dist'));
  copyTree(path.join(server, 'client'), path.join(runtime, 'client'));
  fs.copyFileSync(
    path.join(server, 'package.json'),
    path.join(runtime, 'package.json'),
  );
  fs.copyFileSync(
    path.join(root, 'scripts/local-release/offline-guard.cjs'),
    path.join(runtime, 'offline-guard.cjs'),
  );
  const database = path.join(dir, 'trial.db'),
    db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, database);
  } finally {
    db.close();
  }
  noLinks(database);
  assert.equal(fs.statSync(database).nlink, 1, 'TRIAL_HARDLINK_REFUSED');
  assert.notEqual(fs.realpathSync(database), fs.realpathSync(production));
  const check = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(
      check.prepare('PRAGMA integrity_check').get().integrity_check,
      'ok',
    );
    assert.equal(
      check
        .prepare(
          "SELECT COUNT(*) AS n FROM articles WHERE id IN ('WX_3895431412_2247493551_1','WX_3895431412_2247493556_1') AND length(content_html)>100",
        )
        .get().n,
      2,
    );
  } finally {
    check.close();
  }
  fs.writeFileSync(
    database + '.trial.json',
    JSON.stringify({ mode: 'read-export-trial', sourceDatabase: production }),
    { flag: 'wx' },
  );
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  const files = execFileSync(
    'git',
    ['ls-files', 'apps/server/src', 'apps/web', 'packages/shared'],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  )
    .trim()
    .split(/\r?\n/);
  const sourceHash = sha(
    files
      .filter((f) => fs.existsSync(path.join(root, f)))
      .map((f) => f + '\0' + sha(fs.readFileSync(path.join(root, f))))
      .join('\n'),
  );
  const version = commit.slice(0, 7) + ' / source ' + sourceHash.slice(0, 12);
  const budget = JSON.parse(
    fs.readFileSync(path.join(privateRoot, 'request-state.json'), 'utf8'),
  );
  const nextAt = budget.lastAttemptAt + 15 * 60 * 1000;
  const searchNote =
    '后台搜索冷却最早至 ' +
    new Date(nextAt).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    }) +
    '（北京时间）。' +
    (Date.now() >= nextAt
      ? '当前已过冷却；原文来源仍受限，本页未发额外搜索请求。'
      : '尚在冷却，不发送搜索请求。');
  const port = 4120,
    origin = `http://127.0.0.1:${port}`,
    code =
      previousPrivate?.accessCode || crypto.randomBytes(32).toString('hex');
  const env = {
    ...process.env,
    NODE_PATH: path.join(server, 'node_modules'),
    DATABASE_URL: `file:${database.replace(/\\/g, '/')}`,
    DATABASE_TYPE: 'sqlite',
    HOST: '127.0.0.1',
    PORT: String(port),
    PRIVATE_ONLINE_MODE: '1',
    AUTH_CODE: code,
    NODE_ENV: 'development',
    SERVER_ORIGIN_URL: origin,
    DISABLE_SCHEDULED_UPDATES: '1',
    SCHEDULED_MP_IDS: '',
    WECHAT_DESKTOP_MP_IDS: '',
    PLATFORM_URL: 'http://127.0.0.1:1',
    OBSIDIAN_PATH: path.join(dir, 'exports'),
    TEMP: path.join(dir, 'tmp'),
    TMP: path.join(dir, 'tmp'),
    TMPDIR: path.join(dir, 'tmp'),
    WEWE_ACCEPTANCE_MODE: '1',
    WEWE_ACCEPTANCE_VERSION: version,
    WEWE_ACCEPTANCE_SEARCH_NOTE: searchNote,
    REHEARSAL_GUARD_REPORT: path.join(dir, 'network-guard.json'),
  };
  // Avoid inheriting project source secrets or provider settings into the trial.
  for (const k of Object.keys(env))
    if (/WECHAT2RSS|MP2RSS|PROVIDER|FEED_KEY/.test(k)) delete env[k];
  const config = {
    format: 1,
    commit,
    sourceHash,
    version,
    origin,
    database,
    sourceCopy: source,
    productionHash,
    accessCode: code,
    mode: 'read-export-only',
    dir,
  };
  fs.writeFileSync(
    path.join(dir, 'private-config.json'),
    JSON.stringify(config, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
  fs.writeFileSync(path.join(dir, 'login-code.txt'), code + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  // Only an explicit restart may stop the exact previously recorded private
  // trial. Production PID/port and unrelated Node processes are never selected.
  if (previous) {
    const identity = JSON.parse(
      execFileSync(
        'pwsh',
        [
          '-NoProfile',
          '-File',
          path.join(root, 'scripts/local-release/process-identity.ps1'),
          '-Action',
          'Snapshot',
          '-TargetPid',
          String(previous.pid),
          '-Port',
          '4120',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 20000 },
      ),
    );
    if (
      identity.pid !== previous.pid ||
      identity.executable !== process.execPath ||
      !identity.commandLine.includes(
        path.join(previous.dir, 'runtime/dist/apps/server/src/main.js'),
      ) ||
      identity.localAddresses.some((a) => a !== '127.0.0.1')
    )
      throw Error('TRIAL_RESTART_PROCESS_GATE');
    process.kill(previous.pid);
    await new Promise((r) => setTimeout(r, 300));
  }
  const log = fs.openSync(path.join(dir, 'server.log'), 'wx');
  const child = spawn(
    process.execPath,
    [
      '-r',
      path.join(runtime, 'offline-guard.cjs'),
      path.join(runtime, 'dist/apps/server/src/main.js'),
    ],
    {
      cwd: runtime,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
    },
  );
  startedChild = child;
  fs.closeSync(log);
  child.unref();
  config.pid = child.pid;
  fs.writeFileSync(
    path.join(dir, 'process.json'),
    JSON.stringify({
      pid: child.pid,
      executable: process.execPath,
      main: path.join(runtime, 'dist/apps/server/src/main.js'),
    }),
  );
  const deadline = Date.now() + 25000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(origin + '/dash/login');
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) {
    try {
      child.kill();
    } catch {}
    throw Error('TRIAL_START_FAILED: ' + dir);
  }
  const login = await fetch(origin + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = async (p) => {
    const r = await fetch(origin + p, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    return r;
  };
  const html = await (await get('/dash/feeds/MP_WXS_3895431412')).text();
  assert(html.includes(version));
  assert(html.includes('隔离测试'));
  const zip = Buffer.from(
    await (await get('/download/feed/MP_WXS_3895431412.zip')).arrayBuffer(),
  );
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  fs.writeFileSync(path.join(dir, 'exports/local-check.zip'), zip);
  const blocked = await fetch(origin + '/trpc/feed.refreshArticles', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mpId: 'MP_WXS_3895431412' }),
  });
  const failure = await blocked.json();
  assert(failure.error.message.includes('普通更新尚未接通'));
  assert.equal(sha(fs.readFileSync(production)), productionHash);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'network-guard.json')))
      .blockedNetwork,
    0,
  );
  fs.writeFileSync(
    path.join(privateRoot, 'active-page-trial.json'),
    JSON.stringify({ ...config, accessCode: undefined }, null, 2),
  );
  console.log(
    JSON.stringify({
      started: true,
      url: origin + '/dash/feeds/MP_WXS_3895431412',
      version,
      pid: child.pid,
      loginCodeFile: path.join(dir, 'login-code.txt'),
      directory: dir,
      zipBytes: zip.length,
      update: 'blocked-with-explicit-stage',
      productionUnchanged: true,
    }),
  );
}
main().catch((e) => {
  if (startedChild) startedChild.kill();
  console.error(e.message);
  process.exitCode = 1;
});
