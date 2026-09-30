#!/usr/bin/env node
'use strict';
// The owner handles normal official verification in the explicitly opened page.
// No background original request, profile inspection, capture or retry.
const fs = require('node:fs'),
  path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const { inputs } = require('./replay-owner-search-cache.cjs');
const { verifyCandidateOriginal } = require(
  path.join(
    root,
    'apps/server/dist/apps/server/src/collection/article-candidate',
  ),
);
async function main() {
  const input = inputs();
  let selected;
  const excluded = [];
  for (const candidate of input.selected) {
    const cached = await input.resolveCache(candidate);
    if (cached) {
      verifyCandidateOriginal(candidate, cached.html, cached.evidence);
      excluded.push(candidate.id);
    } else if (!selected) selected = candidate;
  }
  if (!selected || excluded.length !== 2)
    throw Error('NO_UNCACHED_DISCOVERED_ORIGINAL_OR_CACHE_GATE_CHANGED');
  const page = JSON.parse(
    fs.readFileSync(
      path.join(root, 'private-data/owner-web-search-20260930/page-1.json'),
      'utf8',
    ),
  );
  // Keep the exact returned URL, including its query, rather than using another
  // URL shape to evade the existing anonymous-route verification stop.
  const raw = page.items.find(
    (i) =>
      i.urlIdentityClaim &&
      `WX_3895431412_${i.urlIdentityClaim.mid}_${i.urlIdentityClaim.idx}` ===
        selected.id,
  );
  if (!raw) throw Error('SELECTED_RAW_RESPONSE_MISSING');
  const url = raw.doc_url.replace(/^http:\/\//, 'https://');
  const action =
    process.argv.length === 3 && process.argv[2] === '--start'
      ? 'Start'
      : process.argv.length === 3 && process.argv[2] === '--plan'
        ? 'Plan'
        : null;
  if (!action) throw Error('usage: --plan or --start');
  console.log(
    JSON.stringify({
      title: selected.title,
      identity: selected.id,
      reason:
        '本轮自主号名搜索候选；近期索引降序中首篇缺可信原文缓存，未完成原文验收；排除两篇已核验缓存',
      excludedVerifiedCaches: excluded.length,
      originalTimeVerified: false,
      backgroundOriginalRequests: 0,
    }),
  );
  if (action === 'Start') {
    const dir = path.join(root, 'private-data/single-account-update-20260930');
    const file = path.join(dir, 'official-original-selection.json');
    if (fs.existsSync(file))
      throw Error(
        'OFFICIAL_VERIFICATION_ALREADY_OPENED_REVIEW_EXISTING_RECORD',
      );
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          candidate: selected,
          rawUrl: url,
          openedAt: new Date().toISOString(),
          previousAnonymousStopRetained: true,
          backgroundRequests: 0,
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
  }
  const result = execFileSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      path.join(__dirname, 'weread-login-window.ps1'),
      '-Action',
      action,
      '-EntryUrl',
      url,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  console.log(result.trim());
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
