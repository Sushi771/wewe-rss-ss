#!/usr/bin/env node
// Consistent read-only source backup; exactly one explicit binding on a new owned
// SQLite copy. Never edits the source, env, active pointer, or starts a process.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { DatabaseSync, backup } = require('node:sqlite');
const workspace = path.resolve(__dirname, '..');
const fail = (code) => {
  throw new Error(code);
};
const channels = new Set([
  'unbound',
  'wechat2rss',
  'public-album',
  'owner-web-search',
  'owner-weread-latest',
  'unavailable',
]);
async function prepareWechat2RssTest(settings, root = workspace) {
  const { source, feedId, expectedChannel, expectedName, release } = settings;
  if (
    !/^MP_WXS_\d{5,15}$/.test(feedId || '') ||
    !channels.has(expectedChannel) ||
    typeof expectedName !== 'string' ||
    !expectedName.trim() ||
    expectedName.length > 500
  )
    fail('WECHAT2RSS_TEST_ARGUMENT_INVALID');
  if (
    !source ||
    !path.isAbsolute(source) ||
    fs.lstatSync(source).isSymbolicLink() ||
    !fs.lstatSync(source).isFile()
  )
    fail('WECHAT2RSS_TEST_SOURCE_INVALID');
  let manifest;
  if (release) {
    try {
      manifest = require('./local-release/lib.cjs').verifyRelease(release);
    } catch {
      fail('WECHAT2RSS_TEST_RELEASE_INVALID');
    }
    if (
      manifest.schemaCompatibility !== 'current' ||
      manifest.desktopHelperIncluded !== false
    )
      fail('WECHAT2RSS_TEST_RELEASE_INVALID');
  }
  const canonicalRoot = fs.realpathSync(root);
  let directory = canonicalRoot;
  for (const name of [
    'output',
    'subscription-implementation',
    'wechat2rss-test',
  ]) {
    directory = path.join(directory, name);
    if (fs.existsSync(directory)) {
      const info = fs.lstatSync(directory);
      if (info.isSymbolicLink() || !info.isDirectory())
        fail('WECHAT2RSS_TEST_PATH_INVALID');
    } else fs.mkdirSync(directory);
  }
  const copy = path.join(directory, randomUUID() + '.db');
  // Reserve only our newly generated path. backup() never targets an existing DB.
  fs.closeSync(fs.openSync(copy, 'wx'));
  const original = new DatabaseSync(fs.realpathSync(source), {
    readOnly: true,
  });
  try {
    await backup(original, copy);
  } finally {
    original.close();
  }
  const db = new DatabaseSync(copy);
  try {
    const bad = db
      .prepare('PRAGMA quick_check')
      .all()
      .some((row) => row.quick_check !== 'ok');
    if (bad || db.prepare('PRAGMA foreign_key_check').all().length)
      fail('WECHAT2RSS_TEST_COPY_INVALID');
    // Refuse unknown side-effectful triggers before the single-column mutation.
    if (
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='feeds'",
        )
        .all().length
    )
      fail('WECHAT2RSS_TEST_SCHEMA_UNVERIFIED');
    const feed = db
      .prepare(
        'SELECT id, mp_name, collection_channel, status FROM feeds WHERE id = ?',
      )
      .get(feedId);
    if (!feed || feed.mp_name !== expectedName || feed.status !== 1)
      fail('WECHAT2RSS_TEST_IDENTITY_MISMATCH');
    if ((feed.collection_channel ?? 'unbound') !== expectedChannel)
      fail('WECHAT2RSS_TEST_BINDING_CONFLICT');
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db
        .prepare(
          'UPDATE feeds SET collection_channel = ? WHERE id = ? AND collection_channel IS ?',
        )
        .run('wechat2rss', feedId, feed.collection_channel);
      if (Number(result.changes) !== 1)
        fail('WECHAT2RSS_TEST_BINDING_CONFLICT');
      if (db.prepare('PRAGMA foreign_key_check').all().length)
        fail('WECHAT2RSS_TEST_COPY_INVALID');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
  if (manifest)
    fs.writeFileSync(
      copy + '.rehearsal.json',
      JSON.stringify({ database: copy, releaseId: manifest.id }),
      { flag: 'wx' },
    );
  return {
    database: copy,
    releaseId: manifest?.id || null,
    sourceReadOnly: true,
    isolatedCopy: true,
    bindingChanged: true,
    startsService: false,
    enablesCollection: false,
    requests: 0,
  };
}
async function main() {
  const { values } = parseArgs({
    options: {
      'source-db': { type: 'string' },
      release: { type: 'string' },
      'feed-id': { type: 'string' },
      'expect-channel': { type: 'string' },
      'expect-name': { type: 'string' },
    },
  });
  if (!values['source-db'] || !values.release)
    fail('WECHAT2RSS_TEST_ARGUMENT_INVALID');
  const result = await prepareWechat2RssTest({
    source: path.resolve(values['source-db']),
    release: path.resolve(values.release),
    feedId: values['feed-id'],
    expectedChannel: values['expect-channel'],
    expectedName: values['expect-name'],
  });
  console.log(
    JSON.stringify({
      ...result,
      database: path.relative(workspace, result.database),
    }),
  );
}
if (require.main === module)
  main().catch((error) => {
    const known = new Set([
      'WECHAT2RSS_TEST_ARGUMENT_INVALID',
      'WECHAT2RSS_TEST_SOURCE_INVALID',
      'WECHAT2RSS_TEST_RELEASE_INVALID',
      'WECHAT2RSS_TEST_PATH_INVALID',
      'WECHAT2RSS_TEST_COPY_INVALID',
      'WECHAT2RSS_TEST_SCHEMA_UNVERIFIED',
      'WECHAT2RSS_TEST_IDENTITY_MISMATCH',
      'WECHAT2RSS_TEST_BINDING_CONFLICT',
    ]);
    console.error(
      known.has(error.message)
        ? error.message
        : 'WECHAT2RSS_TEST_PREPARATION_FAILED',
    );
    process.exitCode = 1;
  });
module.exports = { prepareWechat2RssTest };
