const restorePreOriginalLinkRouter = require('./xhs-original-link-router-seams.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/server')] }),
);
const {
  restoreXhsReaderRoute,
  restoreXhsReaderService,
} = require('./xhs-reader-removal.cjs');
const seam = require('./fixtures/xhs-reader-removal.json');
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const router = read('apps/server/src/trpc/trpc.router.ts');
const service = read('apps/server/src/collection/xiaohongshu.service.ts');

test('only the exact platform reader route was deleted; all archive/engagement/WeChat routes are preserved', () => {
  assert.equal(
    hash(restoreXhsReaderRoute(ts, restorePreOriginalLinkRouter(router))),
    seam.baselineRouterSha256,
  );
});
test('only the exact reader method/import were deleted; native download/cache/export implementation is preserved', () => {
  assert.equal(
    hash(restoreXhsReaderService(ts, service)),
    seam.baselineServiceSha256,
  );
  for (const name of ['prepareLocalDownload', 'export', 'engagement'])
    assert.match(service, new RegExp('async ' + name + '\\('));
});
test('restoring a body route or service method fails the explicit deletion contract', () => {
  assert.throws(
    () => restoreXhsReaderRoute(ts, restoreXhsReaderRoute(ts, router)),
    /must remain deleted/,
  );
  assert.throws(
    () => restoreXhsReaderService(ts, restoreXhsReaderService(ts, service)),
    /must remain deleted/,
  );
});
test('changing a native download gate cannot hide behind the deleted reader seam', () => {
  const changed = service.replace("status: 'complete'", "status: 'partial'");
  assert.notEqual(changed, service);
  assert.notEqual(
    hash(restoreXhsReaderService(ts, changed)),
    seam.baselineServiceSha256,
  );
});
