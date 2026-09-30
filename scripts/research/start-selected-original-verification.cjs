#!/usr/bin/env node
'use strict';
// The owner invokes --start and handles normal official verification.
// No background original request, profile inspection, capture or retry.
const fs = require('node:fs'),
  path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const config = JSON.parse(
  fs.readFileSync(
    path.join(
      root,
      'private-data/owner-web-search-20260930/source-config.json',
    ),
  ),
);
const page = JSON.parse(
  fs.readFileSync(
    path.join(root, 'private-data/owner-web-search-20260930/page-1.json'),
  ),
);
const selected = page.items
  .filter(
    (i) =>
      i.sourceNameMatched &&
      i.urlIdentityClaim?.biz === config.biz &&
      i.timestamp >= Date.parse(page.capturedAt) / 1000 - 7 * 86400,
  )
  .sort((a, b) => b.timestamp - a.timestamp)[0];
if (!selected) throw Error('NO_DISCOVERED_RECENT_ORIGINAL');
const url = selected.doc_url.replace(/^http:\/\//, 'https://');
const action =
  process.argv.length === 3 && process.argv[2] === '--start'
    ? 'Start'
    : process.argv.length === 3 && process.argv[2] === '--plan'
      ? 'Plan'
      : null;
if (!action) throw Error('usage: --plan or --start');
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
