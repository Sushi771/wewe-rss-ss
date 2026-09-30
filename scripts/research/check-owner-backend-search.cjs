#!/usr/bin/env node
'use strict';
// Necessary backend validation, independent of the prior discovery acceptance.
const fs = require('node:fs'),
  path = require('node:path');
const {
  safePrivateRoot,
  sqliteApi,
  oneAccount,
} = require('./probe-mobile-refresh-preflight.cjs');
const { snapshot, durable } = require('./probe-recent-account-discovery.cjs');
const { environmentGate } = require('./probe-refreshed-mobile-web-health.cjs');
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !path.isAbsolute(args[0])) throw Error('usage_gate');
  environmentGate(process.env);
  const dir = safePrivateRoot(args[0]),
    root = path.resolve(__dirname, '../..');
  const dbPath = path.join(root, 'apps/server/data/wewe-rss.db'),
    before = snapshot(dbPath);
  const db = new (sqliteApi().DatabaseSync)(dbPath, { readOnly: true });
  let vid;
  try {
    db.exec('PRAGMA query_only=ON');
    vid = oneAccount(db).mobile.vid;
  } finally {
    db.close();
  }
  const config = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        'private-data/owner-web-search-20260930/source-config.json',
      ),
    ),
  );
  const { fetchOwnerSearchPage, OwnerSearchStopped } = require(
    path.join(
      root,
      'apps/server/dist/apps/server/src/collection/owner-web-search.js',
    ),
  );
  let result;
  try {
    const page = await fetchOwnerSearchPage({
      sessionFile: path.join(dir, 'session.json'),
      stateFile: path.join(dir, 'request-state.json'),
      ownerVid: vid,
      name: config.name,
      biz: config.biz,
      maxPages: 1,
    });
    durable(path.join(dir, 'backend-page.json'), page);
    result = {
      decision: 'backend_search_succeeded',
      requests: page.requests,
      candidates: page.candidates.length,
      truncated: page.truncated,
      browserConnections: 0,
      pageEvaluations: 0,
      coverage: page.coverage,
    };
  } catch (e) {
    result = {
      decision:
        e instanceof OwnerSearchStopped ? e.reason : 'local_gate_failed',
      browserConnections: 0,
      pageEvaluations: 0,
    };
  }
  const after = snapshot(dbPath);
  result.productionUnchanged = JSON.stringify(before) === JSON.stringify(after);
  durable(path.join(dir, 'backend-result.json'), result);
  console.log(JSON.stringify(result));
  if (
    result.decision !== 'backend_search_succeeded' ||
    !result.productionUnchanged
  )
    process.exitCode = 1;
}
main().catch(() => {
  console.log(JSON.stringify({ decision: 'local_gate_failed' }));
  process.exitCode = 1;
});
