'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const base = '48fdf73f4d770001bbb6de3e2383189811e56ccb';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
test('installed frontend patch contains no search, shared protocol, migration or release-tool changes', () => {
  assert.equal(
    git(
      'diff',
      base,
      '--name-only',
      '--',
      'packages',
      'apps/server/prisma',
      'scripts/local-release',
      'pnpm-lock.yaml',
      'package.json',
      'apps/web/package.json',
      '.github',
    ),
    '',
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
