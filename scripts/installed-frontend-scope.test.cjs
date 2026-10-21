'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const base = '48fdf73f4d770001bbb6de3e2383189811e56ccb';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
test('installed frontend patch contains no search, shared protocol, migration or unrelated release-tool changes', () => {
  assert.equal(
    git(
      'diff',
      base,
      '--name-only',
      '--',
      'packages',
      'apps/server/prisma',
      'pnpm-lock.yaml',
      'package.json',
      'apps/web/package.json',
      '.github',
    ),
    '',
  );
  const releaseFiles = git(
    'diff',
    base,
    '--name-only',
    '--',
    'scripts/local-release',
  )
    .split('\n')
    .filter(Boolean);
  const permitted = new Set([
    'active-release.cjs',
    'frontend-update.cjs',
    'frontend-update.test.cjs',
    'frontend-inventory.cjs',
    'frontend-inventory.test.cjs',
    'frontend-companion.cjs',
    'frontend-companion.test.cjs',
    'frontend-writers.ps1',
    'host-write-boundaries.test.cjs',
  ]);
  assert(
    releaseFiles.every((file) => permitted.has(file.split('/').pop())),
    'only the reviewed retain-only frontend update tool may change',
  );
  const server = git('diff', base, '--name-only', '--', 'apps/server')
    .split('\n')
    .filter(Boolean);
  assert(
    server.every((file) => file.endsWith('.spec.ts')),
    'only old UI-handler test fixtures may change under server',
  );
  const list = fs.readFileSync('apps/web/src/pages/feeds/list.tsx', 'utf8');
  assert(
    !/prepareSearch|searchStatus|searchSnippet|ArticleSearchStatus/.test(list),
  );
  assert(!fs.existsSync('apps/web/src/components/ArticleSearchStatus.tsx'));
  assert(
    fs
      .readFileSync('apps/web/src/pages/feeds/index.tsx', 'utf8')
      .includes('article.exportIds'),
  );
});
