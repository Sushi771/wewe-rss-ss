const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const policy = require('./managed-runtime-mode.cjs');
function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-xhs-policy-'));
  const database = path.join(root, 'db');
  fs.writeFileSync(database, 'synthetic database identity only');
  const channelArchives = {};
  const files = {};
  for (const c of ['wechat', 'xiaohongshu']) {
    const folder = path.join(root, '.collection-channel-control', c);
    fs.mkdirSync(folder, { recursive: true });
    files[c] = path.join(folder, 'state.json');
    const archived = [
      {
        kind: c === 'wechat' ? 'wechat-batch' : 'xhs-task',
        id: 'retained',
        digest: 'a'.repeat(64),
      },
    ];
    fs.writeFileSync(
      files[c],
      JSON.stringify({
        version: 1,
        revision: 1,
        paused: true,
        archived,
        receipts: [{ backupSha256: 'b'.repeat(64) }],
      }),
    );
    channelArchives[c] = policy.digest(archived);
  }
  try {
    return run({
      root,
      database,
      files,
      mode: { kind: 'manual-xhs-v1', channelArchives },
    });
  } finally {
    assert(
      path.dirname(root) === fs.realpathSync.native(os.tmpdir()) ||
        path.dirname(root) === os.tmpdir(),
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('manual mode disables all timers and keeps approval separate from source admission', () =>
  fixture((f) => {
    const e = policy.environment(f.mode, f.database, { initial: true });
    assert.equal(e.WECHAT2RSS_RECOVERY_HOLD, '0');
    assert.equal(e.XHS_SUBSCRIPTION_LIVE_ENABLED, '1');
    for (const k of [
      'ENABLE_SCHEDULED_UPDATES',
      'WECHAT2RSS_ACTIVE_SCHEDULE',
      'WECHAT2RSS_ACTIVE_SCHEDULE_ENABLED',
      'WECHAT2RSS_CACHE_SYNC_ENABLED',
      'WECHAT2RSS_CACHE_MEDIA_ENABLED',
      'WECHAT_DESKTOP_ALLOW_SCHEDULED',
      'XHS_COMMENT_COLLECTION_ENABLED',
      'SQLITE_PERIODIC_LIFECYCLE_ENABLED',
      'SQLITE_RETENTION_SCAN_ENABLED',
    ])
      assert.equal(e[k], '0');
    assert.equal(e.DISABLE_SCHEDULED_UPDATES, '1');
    assert.equal(
      policy.environment(undefined, f.database).XHS_SUBSCRIPTION_LIVE_ENABLED,
      '0',
    );
  }));
test('a missing, unpaused or changed archive fails closed before mode changes', () =>
  fixture((f) => {
    const s = JSON.parse(fs.readFileSync(f.files.xiaohongshu));
    s.paused = false;
    fs.writeFileSync(f.files.xiaohongshu, JSON.stringify(s));
    assert.throws(
      () => policy.environment(f.mode, f.database, { initial: true }),
      /MANAGED_CHANNEL_MUST_BE_PAUSED/,
    );
    assert.equal(
      policy.environment(f.mode, f.database).WECHAT2RSS_RECOVERY_HOLD,
      '0',
    );
    s.archived[0].id = 'changed';
    fs.writeFileSync(f.files.xiaohongshu, JSON.stringify(s));
    assert.throws(
      () => policy.environment(f.mode, f.database),
      /MANAGED_ARCHIVE_CHANGED/,
    );
    fs.unlinkSync(f.files.xiaohongshu);
    assert.throws(() => policy.environment(f.mode, f.database));
  }));
test('normal startup uses only a committed role and matching permit, preserving manual mode after restart', () =>
  fixture((f) => {
    const j = path.join(f.root, '.wewe-update.json'),
      args = {
        journalFile: j,
        releaseId: 'candidate',
        manifestSha256: 'c'.repeat(64),
        database: f.database,
      },
      record = {
        stage: 'completed',
        transactionId: 'transaction',
        package: { id: args.releaseId, sha256: args.manifestSha256 },
        runtimeMode: f.mode,
      };
    fs.writeFileSync(j, JSON.stringify(record));
    fs.writeFileSync(
      j + '.permit',
      JSON.stringify({
        stage: 'completed',
        transactionId: 'transaction',
        id: args.releaseId,
        sha256: args.manifestSha256,
      }),
    );
    assert.equal(policy.committed(args).ENABLE_SCHEDULED_UPDATES, '0');
    assert.throws(
      () => policy.committed({ ...args, releaseId: 'foreign' }),
      /MANAGED_COMMIT_REQUIRED/,
    );
    record.stage = 'recovering';
    fs.writeFileSync(j, JSON.stringify(record));
    assert.throws(() => policy.committed(args), /MANAGED_COMMIT_REQUIRED/);
  }));
test('unknown mode fields and private/acceptance environments cannot grant manual access', () =>
  fixture((f) => {
    assert.throws(
      () =>
        policy.definition({
          ...f.mode,
          environment: { XHS_COMMENT_COLLECTION_ENABLED: '1' },
        }),
      /MANAGED_MODE_INVALID/,
    );
    assert.throws(() => policy.definition({ kind: 'all-live' }));
    const old = process.env.PRIVATE_ONLINE_MODE;
    try {
      process.env.PRIVATE_ONLINE_MODE = '1';
      assert.throws(
        () => policy.environment(f.mode, f.database),
        /MANAGED_LOCAL_MODE_REQUIRED/,
      );
    } finally {
      if (old === undefined) delete process.env.PRIVATE_ONLINE_MODE;
      else process.env.PRIVATE_ONLINE_MODE = old;
    }
  }));

test('both schedules require previously archived, paused channels at install, then permit independent resumes', () =>
  fixture((f) => {
    f.mode.kind = 'scheduled-dual-v1';
    const environment = policy.environment(f.mode, f.database, {
      initial: true,
    });
    assert.equal(environment.ENABLE_SCHEDULED_UPDATES, '1');
    assert.equal(environment.DISABLE_SCHEDULED_UPDATES, '0');
    assert.equal(environment.WECHAT2RSS_ACTIVE_SCHEDULE, '1');
    assert.equal(environment.WECHAT2RSS_CACHE_MEDIA_ENABLED, '0');
    assert.equal(environment.XHS_COMMENT_COLLECTION_ENABLED, '0');
    const w = JSON.parse(fs.readFileSync(f.files.wechat));
    w.paused = false;
    fs.writeFileSync(f.files.wechat, JSON.stringify(w));
    assert.throws(
      () => policy.environment(f.mode, f.database, { initial: true }),
      /MANAGED_CHANNEL_MUST_BE_PAUSED/,
    );
    assert.equal(
      policy.environment(f.mode, f.database).WEWE_MANAGED_RUNTIME_MODE,
      'scheduled-dual-v1',
    );
    assert.throws(
      () =>
        policy.environment({ ...f.mode, kind: 'manual-xhs-v1' }, f.database),
      /MANAGED_CHANNEL_MUST_BE_PAUSED/,
    );
  }));
