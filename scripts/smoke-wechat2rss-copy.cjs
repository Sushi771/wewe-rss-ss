#!/usr/bin/env node
/* Offline importer rehearsal against a disposable SQLite copy only. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const copy = path.resolve(
    root,
    'output/subscription-implementation/copy-smoke.db',
  );
  const production = path.resolve(root, 'apps/server/data/wewe-rss.db');
  assert.notEqual(copy, production);
  if (!fs.existsSync(copy)) throw new Error('COPY_NOT_PREPARED');
  const { PrismaClient } = require(
    path.join(root, 'apps/server/node_modules/@prisma/client'),
  );
  const registry = require(
    path.join(
      root,
      'apps/server/dist/apps/server/src/collection/provider-registry.js',
    ),
  );
  const { CollectionService } = require(
    path.join(
      root,
      'apps/server/dist/apps/server/src/collection/collection.service.js',
    ),
  );
  const dbUrl = `file:${copy.replace(/\\/g, '/')}`;
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  try {
    const feed = await prisma.feed.findFirst({
      where: { id: { startsWith: 'MP_WXS_' } },
      orderBy: { id: 'asc' },
    });
    if (!feed || !/^MP_WXS_\d{5,15}$/.test(feed.id))
      throw new Error('COPY_TARGET_MISSING');
    const oldArticles = await prisma.article.findMany({
      orderBy: { id: 'asc' },
    });
    const oldFeeds = await prisma.feed.findMany({ orderBy: { id: 'asc' } });
    const number = feed.id.slice(7);
    const id = `WX_${number}_999999999999999_1`;
    if (oldArticles.some((item) => item.id === id))
      throw new Error('COPY_FIXTURE_COLLISION');
    const url = `https://mp.weixin.qq.com/s?__biz=${Buffer.from(number).toString('base64')}&mid=999999999999999&idx=1`;
    let refreshes = 0;
    registry.wechat2RssProvider = () => ({
      checkAccountStatus: async () => ({ available: true, challenged: false }),
      refreshSubscription: async () => {
        refreshes++;
        return { accepted: true, pending: true };
      },
      fetchArticles: async () => ({
        articles: [
          {
            id,
            mpId: feed.id,
            url,
            title: '离线模拟验收专用',
            publishTime: Math.floor(Date.now() / 1000) - 86400,
            contentHtml:
              '<div class="rich_media_content" id="js_content"><p>模拟正文</p></div>',
            picUrl: 'https://mmbiz.qpic.cn/fixture.jpg',
          },
        ],
        coverage: 'recent-window',
        upstreamCount: 1,
        bodyMissing: 0,
        imageBlocked: 0,
      }),
    });
    const service = new CollectionService(prisma);
    const input = {
      mpId: feed.id,
      mpName: feed.mpName,
      trigger: 'local-manual',
    };
    const first = await service.collectWechat2RssRecent(input);
    const second = await service.collectWechat2RssRecent(input);
    assert.equal(first.created, 1);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 0);
    assert.equal(refreshes, 1);
    const afterArticles = await prisma.article.findMany({
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(
      afterArticles.filter((item) => item.id !== id),
      oldArticles,
    );
    const afterFeeds = await prisma.feed.findMany({ orderBy: { id: 'asc' } });
    assert.deepEqual(
      afterFeeds.filter((item) => item.id !== feed.id),
      oldFeeds.filter((item) => item.id !== feed.id),
    );
    await prisma.$disconnect();
    const reopened = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    try {
      assert.equal(await reopened.article.count(), oldArticles.length + 1);
      assert.equal(
        (
          await reopened.article.findUnique({ where: { id } })
        )?.contentHtml?.includes('模拟正文'),
        true,
      );
    } finally {
      await reopened.$disconnect();
    }
    console.log(
      JSON.stringify({
        mode: 'offline-mock-copy',
        baselineArticles: oldArticles.length,
        firstCreated: first.created,
        repeatCreated: second.created,
        repeatUpdated: second.updated,
        oldArticleRowsUnchanged: true,
        otherFeedsUnchanged: true,
        restartRead: true,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    'COPY_REHEARSAL_FAILED',
    error instanceof Error ? error.message : 'unknown',
  );
  process.exitCode = 1;
});
