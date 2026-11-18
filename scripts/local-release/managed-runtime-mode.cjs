'use strict';
// Explicit reviewed launch policy; it grants no source admission or task resume.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
const quiet = Object.freeze({
  WECHAT2RSS_RECOVERY_HOLD: '1',
  XHS_SUBSCRIPTION_LIVE_ENABLED: '0',
  WEWE_MANAGED_RUNTIME_MODE: 'held',
  ENABLE_SCHEDULED_UPDATES: '0',
  DISABLE_SCHEDULED_UPDATES: '1',
  WECHAT2RSS_ACTIVE_SCHEDULE: '0',
  WECHAT2RSS_ACTIVE_SCHEDULE_ENABLED: '0',
  WECHAT2RSS_CACHE_SYNC_ENABLED: '0',
  WECHAT2RSS_CACHE_MEDIA_ENABLED: '0',
  WECHAT2RSS_CACHE_SYNC: '0',
  WECHAT2RSS_LOCAL_CACHE_SYNC: '0',
  WECHAT2RSS_CACHE_MEDIA: '0',
  WEWE_MANAGED_WECHAT_LOCAL_CACHE: '0',
  WECHAT_DESKTOP_ALLOW_SCHEDULED: '0',
  XHS_COMMENT_COLLECTION_ENABLED: '0',
  SQLITE_PERIODIC_LIFECYCLE_ENABLED: '0',
  SQLITE_RETENTION_SCAN_ENABLED: '0',
});
const digest = (v) =>
  crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function definition(mode) {
  if (mode === undefined) return;
  const fields = Object.keys(mode || {})
    .sort()
    .join(',');
  assert(
    ['manual-xhs-v1', 'scheduled-dual-v1'].includes(mode?.kind) &&
      (fields === 'channelArchives,kind' ||
        (fields === 'channelArchives,kind,wechatLocalCache' &&
          mode.kind === 'scheduled-dual-v1' &&
          mode.wechatLocalCache === true)),
    'MANAGED_MODE_INVALID',
  );
  assert(
    Object.keys(mode.channelArchives || {})
      .sort()
      .join(',') === 'wechat,xiaohongshu',
    'MANAGED_ARCHIVES_REQUIRED',
  );
  for (const channel of ['wechat', 'xiaohongshu'])
    assert(
      /^[a-f0-9]{64}$/.test(mode.channelArchives[channel]),
      'MANAGED_ARCHIVE_DIGEST_REQUIRED',
    );
}
function localCacheEnvironment(database, initial) {
  const data = path.dirname(fs.realpathSync.native(database));
  const project = path.resolve(data, '../../..');
  assert(
    data === path.join(project, 'apps', 'server', 'data'),
    'MANAGED_WECHAT_CACHE_PROJECT_REQUIRED',
  );
  const directory = path.join(project, '.wechat2rss-data');
  const cache = path.join(directory, 'res.db');
  if (initial) {
    const folder = fs.lstatSync(directory);
    const file = fs.lstatSync(cache);
    assert(
      folder.isDirectory() &&
        !folder.isSymbolicLink() &&
        file.isFile() &&
        !file.isSymbolicLink() &&
        file.nlink === 1 &&
        fs.realpathSync.native(directory) === directory &&
        fs.realpathSync.native(cache) === cache &&
        cache !== fs.realpathSync.native(database),
      'MANAGED_WECHAT_CACHE_IDENTITY_INVALID',
    );
  }
  return {
    WEWE_MANAGED_WECHAT_LOCAL_CACHE: '1',
    WECHAT2RSS_ENABLED: '1',
    WECHAT2RSS_CACHE_DB: cache,
    WECHAT2RSS_CACHE_SYNC: '1',
    WECHAT2RSS_LOCAL_CACHE_SYNC: '1',
    WECHAT2RSS_CACHE_MEDIA: '0',
    WECHAT2RSS_ACTIVE_SCHEDULE: '0',
  };
}
function environment(mode, database, { initial = false } = {}) {
  definition(mode);
  if (mode === undefined) return { ...quiet };
  assert(
    process.env.PRIVATE_ONLINE_MODE !== '1' &&
      process.env.WEWE_ACCEPTANCE_MODE !== '1',
    'MANAGED_LOCAL_MODE_REQUIRED',
  );
  const root = path.join(
    path.dirname(fs.realpathSync.native(database)),
    '.collection-channel-control',
  );
  for (const channel of ['wechat', 'xiaohongshu']) {
    const dir = path.join(root, channel),
      file = path.join(dir, 'state.json');
    for (const folder of [root, dir])
      assert(
        fs.lstatSync(folder).isDirectory() &&
          !fs.lstatSync(folder).isSymbolicLink() &&
          fs.realpathSync.native(folder) === folder,
        'MANAGED_CHANNEL_REDIRECTED',
      );
    const s = fs.lstatSync(file);
    assert(
      s.isFile() &&
        !s.isSymbolicLink() &&
        s.nlink === 1 &&
        s.size <= 8 * 1024 ** 2,
      'MANAGED_CHANNEL_INVALID',
    );
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(
      state.version === 1 &&
        Number.isSafeInteger(state.revision) &&
        state.revision > 0 &&
        typeof state.paused === 'boolean' &&
        Array.isArray(state.archived) &&
        state.archived.length > 0 &&
        Array.isArray(state.receipts) &&
        state.receipts.some((x) => /^[a-f0-9]{64}$/.test(x.backupSha256)),
      'MANAGED_ARCHIVE_REQUIRED',
    );
    assert(
      digest(state.archived) === mode.channelArchives[channel],
      'MANAGED_ARCHIVE_CHANGED',
    );
    assert(
      (!initial &&
        (channel !== 'wechat' ||
          (mode.kind === 'scheduled-dual-v1' && !mode.wechatLocalCache))) ||
        state.paused === true,
      'MANAGED_CHANNEL_MUST_BE_PAUSED',
    );
  }
  return {
    ...quiet,
    WECHAT2RSS_RECOVERY_HOLD: '0',
    XHS_SUBSCRIPTION_LIVE_ENABLED: '1',
    WEWE_MANAGED_RUNTIME_MODE: mode.kind,
    ...(mode.kind === 'scheduled-dual-v1'
      ? {
          ENABLE_SCHEDULED_UPDATES: '1',
          DISABLE_SCHEDULED_UPDATES: '0',
          WECHAT2RSS_ACTIVE_SCHEDULE: '1',
        }
      : {}),
    ...(mode.wechatLocalCache ? localCacheEnvironment(database, initial) : {}),
  };
}
function readControl(file) {
  const stat = fs.lstatSync(file);
  assert(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.size <= 1024 * 1024 &&
      fs.realpathSync.native(file) === file,
    'MANAGED_CONTROL_NOT_PLAIN',
  );
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function committed({ journalFile, releaseId, manifestSha256, database }) {
  if (!fs.existsSync(journalFile)) return {};
  const j = readControl(journalFile);
  if (j.runtimeMode === undefined) return {};
  const permit = readControl(journalFile + '.permit');
  assert(
    j.stage === 'completed' &&
      j.package?.id === releaseId &&
      j.package?.sha256 === manifestSha256 &&
      permit.stage === 'completed' &&
      permit.id === releaseId &&
      permit.sha256 === manifestSha256 &&
      permit.transactionId === j.transactionId,
    'MANAGED_COMMIT_REQUIRED',
  );
  return environment(j.runtimeMode, database);
}
module.exports = { quiet, digest, definition, environment, committed };
