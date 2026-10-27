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

test('limited recovery compatibility rejects changed authorization, identity and response privacy seams', () => {
  const fixture = require('./fixtures/xhs-original-link-router-seams.json');
  const reviewed = fixture[2].after;
  const routeStart = reviewed.indexOf('    recoverSingleNote:');
  assert.ok(routeStart > 0);
  const route = reviewed.slice(routeStart);
  assert.equal(router.split(route).length, 2);
  assert.equal(router.split(fixture[5].after).length, 2);
  for (const [before, after] of [
    ['this.requireLocalXhsConnection(ctx);', 'this.requireLocalXhsAccess(ctx);'],
    ['confirmLimitedRecovery: z.literal(true)', 'confirmLimitedRecovery: z.boolean()'],
    ['appendUnknownAttempt: z.literal(true).optional()', 'appendUnknownAttempt: z.boolean().optional()'],
    ['input.appendUnknownAttempt === true,', 'true,'],
    ['input.expectedAuthorId,', 'input.url,'],
    ['await this.xhsSubscriptions!.commitLimitedRecovery(result)', 'await Promise.resolve(result)'],
  ]) {
    assert.equal(route.split(before).length, 2);
    const changed = router.replace(route, route.replace(before, after));
    assert.notEqual(changed, router);
    assert.throws(() => restorePreOriginalLinkRouter(changed), /exact PC-link router seam/);
  }
  for (const [before, after] of [
    ["name.endsWith('xiaohongshu.recoverSingleNote')", 'false'],
    ["res.setHeader('Cache-Control', 'no-store');", "res.setHeader('Cache-Control', 'public');"],
    ["res.setHeader('Referrer-Policy', 'no-referrer');", "res.setHeader('Referrer-Policy', 'unsafe-url');"],
  ]) {
    const headers = fixture[5].after;
    assert.equal(headers.split(before).length, 2);
    const changed = router.replace(headers, headers.replace(before, after));
    assert.notEqual(changed, router);
    assert.throws(() => restorePreOriginalLinkRouter(changed), /exact PC-link router seam/);
  }
});

test('batch routes are exact and local checks cannot be hidden by baseline restoration', () => {
  const fixture = require('./fixtures/xhs-original-link-router-seams.json');
  const routes = fixture[8].after;
  assert.equal(router.split(routes).length, 2);
  assert.equal((routes.match(/requireLocalXhsConnection\(ctx/g) || []).length, 4);
  const changed = router.replace(routes, routes.replace('this.requireLocalXhsConnection(ctx);', 'void ctx;'));
  assert.notEqual(changed, router);
  assert.throws(() => restorePreOriginalLinkRouter(changed), /exact PC-link router seam/);
});

test('whole history grants require explicit confirmation and local access at the exact reviewed seams', () => {
  const fixture = require('./fixtures/xhs-original-link-router-seams.json');
  for (const route of [fixture[9].after, fixture[10].after]) {
    assert.equal(router.split(route).length, 2);
    for (const [before, after] of [
      ['confirmHistoryGrant: z.literal(true)', 'confirmHistoryGrant: z.boolean()'],
      ['this.requireLocalXhsAccess(ctx);', 'void ctx;'],
    ]) {
      assert.equal(route.split(before).length, 2);
      const changed=router.replace(route,route.replace(before,after));
      assert.throws(()=>restorePreOriginalLinkRouter(changed), /exact PC-link router seam/);
    }
  }
});
