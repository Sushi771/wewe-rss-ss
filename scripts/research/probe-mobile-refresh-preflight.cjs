#!/usr/bin/env node
'use strict';

// Offline preparation only. This file has no online execution mode.
// It never modifies the source SQLite database or sends a network request.
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const LOGIN_PATH = '/login';
const VERSION_HEADERS = Object.freeze({
  baseapi: '30',
  appver: '2.1.2.10245900',
  basever: '2.1.2.10245900',
  osver: '11',
  channelId: '900',
  'User-Agent':
    'WeRead/2.1.2 WRBrand/Onyx wr_eink Dalvik/2.1.0 (Linux; U; Android 11; BOOX Build/onyx)',
});

function args(argv) {
  if (argv.length === 1 && ['--plan', '--self-test'].includes(argv[0]))
    return { mode: argv[0] };
  if (
    argv.length === 5 &&
    argv[0] === '--preflight' &&
    argv[1] === '--db' &&
    argv[3] === '--private-root' &&
    path.isAbsolute(argv[2]) &&
    path.isAbsolute(argv[4])
  )
    return { mode: '--preflight', dbPath: argv[2], privateRoot: argv[4] };
  throw Error('usage_gate');
}

function within(parent, child) {
  const relative = path.relative(parent, child).toLowerCase();
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function safePrivateRoot(input) {
  const root = fs.realpathSync(PROJECT_ROOT);
  const privateRoot = fs.realpathSync(input);
  if (!fs.statSync(privateRoot).isDirectory()) throw Error('private_root_gate');
  if (
    within(root, privateRoot) &&
    !within(path.join(root, 'private-data'), privateRoot)
  )
    throw Error('private_root_gate');
  return privateRoot;
}

function validMobile(tokenText) {
  let token;
  try {
    token = JSON.parse(tokenText);
  } catch {
    throw Error('account_gate');
  }
  const mobile = token?.mobile;
  if (!mobile || typeof mobile !== 'object' || Array.isArray(mobile))
    throw Error('mobile_gate');
  const vid =
    typeof mobile.vid === 'string'
      ? mobile.vid
      : Number.isSafeInteger(mobile.vid) && mobile.vid > 0
        ? String(mobile.vid)
        : '';
  if (
    !vid.trim() ||
    !['accessToken', 'refreshToken', 'deviceId'].every(
      (key) => typeof mobile[key] === 'string' && mobile[key].trim(),
    )
  )
    throw Error('mobile_gate');
  return { token, mobile: { ...mobile, vid } };
}

function oneAccount(db) {
  const rows = db.prepare('SELECT id, token FROM accounts LIMIT 2').all();
  if (
    rows.length !== 1 ||
    typeof rows[0].id !== 'string' ||
    typeof rows[0].token !== 'string'
  )
    throw Error('account_gate');
  return { row: rows[0], ...validMobile(rows[0].token) };
}

function integrity(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok')
    throw Error('integrity_gate');
  return {
    feeds: db.prepare('SELECT COUNT(*) AS count FROM feeds').get().count,
    articles: db.prepare('SELECT COUNT(*) AS count FROM articles').get().count,
  };
}

function sqliteApi() {
  let api;
  try {
    api = require('node:sqlite');
  } catch {
    throw Error('sqlite_runtime_gate');
  }
  if (
    typeof api.DatabaseSync !== 'function' ||
    typeof api.backup !== 'function'
  )
    throw Error('sqlite_runtime_gate');
  return api;
}

function refreshShape(mobile, timestamp, random) {
  assert(Number.isSafeInteger(timestamp) && Number.isSafeInteger(random));
  assert(random >= 1 && random <= 1000);
  return {
    url: `https://i.weread.qq.com${LOGIN_PATH}`,
    method: 'POST',
    headers: {
      ...VERSION_HEADERS,
      'content-type': 'application/json; charset=UTF-8',
    },
    body: {
      deviceId: mobile.deviceId,
      deviceName: 'BOOX',
      inBackground: 0,
      kickType: 1,
      random,
      refCgi: '',
      refreshToken: mobile.refreshToken,
      signature: createHash('sha256')
        .update(`${timestamp}${mobile.deviceId}${random}`)
        .digest('hex'),
      timestamp,
      trackId: '',
      deviceType: 3,
    },
  };
}

function responseHint(value) {
  if (typeof value !== 'string') return null;
  if (/captcha|验证码|安全验证|verifycenter|请完成验证/i.test(value))
    return 'verification';
  if (
    /访问过于频繁|请求频繁|限流|限频|rate.?limit|too many|throttl/i.test(value)
  )
    return 'rate_limit';
  return null;
}

function classifyRefreshResponse(previous, status, body) {
  if (typeof body === 'string') {
    const hint = responseHint(body);
    return {
      decision: hint ? `stop_${hint}` : 'stop_unexpected_shape',
      candidate: null,
    };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { decision: 'stop_unexpected_shape', candidate: null };
  const hint =
    [body.errMsg, body.msg, body.message].map(responseHint).find(Boolean) ??
    (status === 429 ? 'rate_limit' : null);
  const access = body.accessToken;
  if (typeof access !== 'string' || !access.trim())
    return {
      decision: hint
        ? `stop_${hint}`
        : status === 200
          ? 'stop_no_new_access'
          : 'stop_http',
      candidate: null,
    };
  const providedVid =
    body.vid === undefined
      ? null
      : typeof body.vid === 'string'
        ? body.vid
        : Number.isSafeInteger(body.vid) && body.vid > 0
          ? String(body.vid)
          : null;
  const refresh =
    body.refreshToken === undefined ? previous.refreshToken : body.refreshToken;
  const candidate = {
    ...previous,
    vid: providedVid ?? previous.vid,
    accessToken: access,
    refreshToken: refresh,
  };
  // The candidate is for private recovery first, not for immediate use.
  if (hint) return { decision: `quarantine_${hint}`, candidate };
  if (status !== 200) return { decision: 'quarantine_http', candidate };
  if (providedVid !== null && providedVid !== previous.vid)
    return { decision: 'quarantine_identity_mismatch', candidate };
  if (body.vid !== undefined && providedVid === null)
    return { decision: 'quarantine_invalid_identity', candidate };
  if (typeof refresh !== 'string' || !refresh.trim())
    return { decision: 'quarantine_invalid_refresh', candidate };
  if (body.errCode !== undefined && Number(body.errCode) !== 0)
    return { decision: 'quarantine_business_code', candidate };
  return {
    decision:
      providedVid === null
        ? 'candidate_identity_implicit'
        : 'candidate_identity_matched',
    candidate,
  };
}

function atomicRecovery(runDir, accountId, mobile) {
  const finalPath = path.join(runDir, 'mobile-refresh-recovery.json');
  if (fs.existsSync(finalPath)) throw Error('recovery_exists');
  const tempPath = path.join(
    runDir,
    `.recovery-${randomBytes(8).toString('hex')}.tmp`,
  );
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try {
    fs.writeSync(
      fd,
      JSON.stringify({ formatVersion: 1, accountId, mobile }) + '\n',
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // On any failure, keep the fsynced temporary file for recovery.
  fs.renameSync(tempPath, finalPath);
  const written = JSON.parse(fs.readFileSync(finalPath, 'utf8'));
  if (
    written.accountId !== accountId ||
    JSON.stringify(written.mobile) !== JSON.stringify(mobile)
  )
    throw Error('recovery_verify_gate');
  return finalPath;
}

function rehearse(backupPath, rehearsalPath) {
  fs.copyFileSync(backupPath, rehearsalPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(rehearsalPath, 0o600);
  const { DatabaseSync } = sqliteApi();
  const db = new DatabaseSync(rehearsalPath);
  try {
    const beforeCounts = integrity(db);
    const current = oneAccount(db);
    const next = structuredClone(current.token);
    next.mobile = {
      ...current.mobile,
      accessToken: 'offline-fixture-rotated-access',
      refreshToken: 'offline-fixture-rotated-refresh',
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db
        .prepare('UPDATE accounts SET token = ? WHERE id = ? AND token = ?')
        .run(JSON.stringify(next), current.row.id, current.row.token);
      if (result.changes !== 1) throw Error('rehearsal_update_gate');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const after = oneAccount(db);
    if (
      after.mobile.accessToken !== next.mobile.accessToken ||
      after.mobile.refreshToken !== next.mobile.refreshToken ||
      after.mobile.deviceId !== current.mobile.deviceId ||
      after.mobile.vid !== current.mobile.vid
    )
      throw Error('rehearsal_verify_gate');
    const afterCounts = integrity(db);
    if (
      afterCounts.feeds !== beforeCounts.feeds ||
      afterCounts.articles !== beforeCounts.articles
    )
      throw Error('preservation_gate');
  } finally {
    db.close();
  }
}

async function preflight(dbPath, privateRootInput) {
  if (!fs.statSync(dbPath).isFile()) throw Error('db_gate');
  const privateRoot = safePrivateRoot(privateRootInput);
  const { DatabaseSync, backup } = sqliteApi();
  const source = new DatabaseSync(dbPath, { readOnly: true });
  let runDir;
  try {
    source.exec('PRAGMA query_only=ON');
    const initial = oneAccount(source);
    runDir = fs.mkdtempSync(path.join(privateRoot, 'mobile-refresh-'));
    fs.chmodSync(runDir, 0o700);
    const backupPath = path.join(runDir, 'original.sqlite');
    await backup(source, backupPath);
    fs.chmodSync(backupPath, 0o600);
    const original = new DatabaseSync(backupPath, { readOnly: true });
    try {
      original.exec('PRAGMA query_only=ON');
      integrity(original);
      const copied = oneAccount(original);
      if (
        copied.row.id !== initial.row.id ||
        copied.row.token !== initial.row.token
      )
        throw Error('concurrent_token_change_gate');
    } finally {
      original.close();
    }
    rehearse(backupPath, path.join(runDir, 'rehearsal.sqlite'));
    const fixturePath = atomicRecovery(runDir, initial.row.id, {
      ...initial.mobile,
      accessToken: 'offline-fixture-rotated-access',
      refreshToken: 'offline-fixture-rotated-refresh',
    });
    fs.unlinkSync(fixturePath);
    return {
      decision: 'preflight_ready',
      privateRunDir: runDir,
      backupIntegrity: true,
      copyRehearsal: true,
      atomicRecoveryRehearsal: true,
      productionWrites: 0,
      networkRequests: 0,
    };
  } catch (error) {
    if (runDir) error.privateRunDir = runDir;
    throw error;
  } finally {
    // A failed preflight retains any already-created private backup for review.
    source.close();
  }
}

async function selfTest() {
  assert.equal(args(['--plan']).mode, '--plan');
  assert.throws(() => args(['--execute']), /usage_gate/);
  const mobile = {
    vid: 'fixture-vid',
    accessToken: 'old',
    refreshToken: 'fixture-refresh',
    deviceId: 'fixture-device',
  };
  const shape = refreshShape(mobile, 123456, 7);
  assert.equal(shape.url, 'https://i.weread.qq.com/login');
  assert.equal(
    shape.body.signature,
    createHash('sha256').update('123456fixture-device7').digest('hex'),
  );
  assert.deepEqual(Object.keys(shape.body).sort(), [
    'deviceId',
    'deviceName',
    'deviceType',
    'inBackground',
    'kickType',
    'random',
    'refCgi',
    'refreshToken',
    'signature',
    'timestamp',
    'trackId',
  ]);
  const rotated = classifyRefreshResponse(mobile, 200, {
    vid: 'fixture-vid',
    accessToken: 'new',
    refreshToken: 'new-refresh',
  });
  assert.equal(rotated.decision, 'candidate_identity_matched');
  assert.equal(rotated.candidate.refreshToken, 'new-refresh');
  assert.equal(
    classifyRefreshResponse(mobile, 200, { accessToken: 'new' }).candidate
      .refreshToken,
    mobile.refreshToken,
  );
  assert.equal(
    classifyRefreshResponse(mobile, 200, {
      vid: 'other-account',
      accessToken: 'new',
    }).decision,
    'quarantine_identity_mismatch',
  );
  assert.equal(
    classifyRefreshResponse(mobile, 401, { accessToken: 'new' }).decision,
    'quarantine_http',
  );
  assert.equal(
    classifyRefreshResponse(mobile, 200, {
      accessToken: 'new',
      refreshToken: null,
    }).decision,
    'quarantine_invalid_refresh',
  );
  assert.equal(
    classifyRefreshResponse(mobile, 429, { errMsg: '请求频繁' }).decision,
    'stop_rate_limit',
  );
  assert.equal(
    classifyRefreshResponse(mobile, 200, '<h1>验证码</h1>').decision,
    'stop_verification',
  );
  assert.equal(
    classifyRefreshResponse(mobile, 200, {
      accessToken: 'new',
      errMsg: '安全验证',
    }).decision,
    'quarantine_verification',
  );

  const testRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mobile-refresh-self-test-'),
  );
  try {
    const dbPath = path.join(testRoot, 'fixture.sqlite');
    const privateRoot = path.join(testRoot, 'private');
    fs.mkdirSync(privateRoot);
    const { DatabaseSync } = sqliteApi();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        'CREATE TABLE accounts (id TEXT PRIMARY KEY, token TEXT NOT NULL)',
      );
      db.exec('CREATE TABLE feeds (id TEXT PRIMARY KEY)');
      db.exec('CREATE TABLE articles (id TEXT PRIMARY KEY)');
      db.prepare('INSERT INTO accounts (id, token) VALUES (?, ?)').run(
        'fixture-account',
        JSON.stringify({ mobile, unrelated: 'preserve' }),
      );
      db.prepare('INSERT INTO feeds (id) VALUES (?)').run('fixture-feed');
      db.prepare('INSERT INTO articles (id) VALUES (?)').run('fixture-article');
    } finally {
      db.close();
    }
    const result = await preflight(dbPath, privateRoot);
    assert.equal(result.decision, 'preflight_ready');
    const original = new DatabaseSync(
      path.join(result.privateRunDir, 'original.sqlite'),
      { readOnly: true },
    );
    try {
      assert.equal(oneAccount(original).mobile.accessToken, 'old');
    } finally {
      original.close();
    }
  } finally {
    const tempBase = fs.realpathSync(os.tmpdir());
    const resolved = fs.realpathSync(testRoot);
    if (
      !within(tempBase, resolved) ||
      !path.basename(resolved).startsWith('mobile-refresh-self-test-')
    )
      throw Error('self_test_cleanup_gate');
    fs.rmSync(resolved, { recursive: true });
  }
  return {
    decision: 'self_test_passed',
    networkRequests: 0,
    productionReads: 0,
    productionWrites: 0,
  };
}

async function main() {
  let options;
  try {
    options = args(process.argv.slice(2));
  } catch {
    console.log(JSON.stringify({ decision: 'usage_gate', networkRequests: 0 }));
    process.exitCode = 2;
    return;
  }
  if (options.mode === '--plan') {
    console.log(
      JSON.stringify({
        decision: 'plan_only',
        endpoint: LOGIN_PATH,
        method: 'POST',
        onlineModeAvailable: false,
        maxOnlineRequests: 0,
        backup: 'consistent SQLite backup in private directory',
        rehearsal: 'separate SQLite copy and atomic recovery fixture',
        productionReads: 0,
        productionWrites: 0,
        networkRequests: 0,
      }),
    );
    return;
  }
  try {
    const result =
      options.mode === '--self-test'
        ? await selfTest()
        : await preflight(options.dbPath, options.privateRoot);
    console.log(JSON.stringify(result));
  } catch (error) {
    const safe = new Set([
      'db_gate',
      'private_root_gate',
      'sqlite_runtime_gate',
      'account_gate',
      'mobile_gate',
      'integrity_gate',
      'concurrent_token_change_gate',
      'rehearsal_update_gate',
      'rehearsal_verify_gate',
      'preservation_gate',
    ]);
    console.log(
      JSON.stringify({
        decision: safe.has(error.message) ? error.message : 'preflight_failed',
        ...(options.mode === '--preflight' && error.privateRunDir
          ? { privateRunDir: error.privateRunDir }
          : {}),
        productionWrites: 0,
        networkRequests: 0,
      }),
    );
    process.exitCode = 1;
  }
}

if (require.main === module) main();
