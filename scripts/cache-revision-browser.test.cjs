'use strict';
// Actual product React page, synthetic local reads, isolated headless browser.
// Requires an existing Playwright runtime; never installs packages or starts the backend.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..'),
  web = path.join(root, 'apps/web');
let chromium;
try {
  ({ chromium } = require(
    process.env.BROWSE_TEST_PLAYWRIGHT || 'playwright-core',
  ));
} catch {
  /* explicit skip */
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test(
  'revision to actual list, unchanged stability, reconnect, background, reader, filters and 390px',
  { skip: !chromium, timeout: 180000 },
  async () => {
    // Serve an existing product build, avoiding development-server warmup.
    const client = path.join(root, 'apps/server/client');
    const html = fs
      .readFileSync(path.join(client, 'index.hbs'), 'utf8')
      .replace(/{{#if acceptanceMode}}[\s\S]*?{{\/if}}/g, '')
      .replace(/<link[^>]*rel="icon"[^>]*>/g, '')
      .replace(
        /window\.__WEWE_RSS_SERVER_ORIGIN_URL__ = [^;]+;/,
        "window.__WEWE_RSS_SERVER_ORIGIN_URL__ = '';",
      )
      .replace(
        /window\.__WEWE_RSS_(ENABLED_AUTH_CODE|PRIVATE_ONLINE_MODE|ACCEPTANCE_MODE)__ = [^;]+;/g,
        (_, key) => `window.__WEWE_RSS_${key}__ = false;`,
      );
    const httpServer = require('node:http').createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname.startsWith('/dash/assets/')) {
        const filename = path.basename(pathname);
        const file = path.join(client, 'assets', filename);
        if (!fs.existsSync(file)) {
          res.writeHead(404);
          return res.end();
        }
        res.setHeader(
          'Content-Type',
          filename.endsWith('.css') ? 'text/css' : 'text/javascript',
        );
        return res.end(fs.readFileSync(file));
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    });
    const server = {
      httpServer,
      listen: () =>
        new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve)),
      close: () => {
        httpServer.closeAllConnections();
        return new Promise((resolve) => httpServer.close(resolve));
      },
    };
    let browser;
    const failures = [],
      checks = [],
      requests = [];
    const timings = {};
    const feed = (id) => ({
      id,
      mpName: 'Fixture ' + id,
      mpCover: '',
      mpIntro: '',
      status: 0,
      updateTime: 0,
      syncTime: 0,
      hasHistory: -1,
      order: 0,
      groupId: id === 'source-a' ? 'group-a' : null,
      collectionChannel: 'unavailable',
      collectionRoute: { channel: 'unavailable', selectedBy: 'saved' },
      lastCollectionResult: null,
      _count: { articles: 260 },
    });
    let revision = 'epoch:0',
      inserted = false,
      disconnected = false;
    let deleteAnchor = false,
      empty = false,
      groups = [{ id: 'group-a', name: 'Fixture Group', order: 0 }];
    const article = (n) => ({
      id: 'article-' + n,
      mpId: 'source-a',
      title: 'alpha Article ' + String(n).padStart(3, '0'),
      picUrl: '',
      publishTime: 1700000000,
      sourceUrl: '#',
      metrics: null,
      readCount: null,
      likeCount: null,
      feed: feed('source-a'),
      bodyCached: true,
      lastBodyStatus: 'available',
      bodyRetry: { allowed: false, reason: '' },
    });
    const api = (name, input) => {
      requests.push({ name, input });
      if (name === 'feed.cacheRevision') {
        if (disconnected) throw Error('offline fixture');
        return { revision };
      }
      if (name === 'feed.cacheSyncStatus') return { enabled: true, feeds: [] };
      if (name === 'feed.groups') return { items: groups };
      if (
        [
          'feed.subscriptionBatches',
          'feed.subscriptionTasks',
          'feed.manualRefreshBatches',
        ].includes(name)
      )
        return { items: [] };
      if (name === 'collection.verificationStatus')
        return { status: 'idle', verificationActive: false };
      if (name === 'feed.list')
        return {
          items: [feed('source-a'), feed('source-b')],
          nextCursor: null,
        };
      if (name === 'feed.getInProgressHistoryMp') return [];
      if (name === 'feed.isRefreshAllMpArticlesRunning') return false;
      if (name === 'feed.addCapability')
        return {
          available: false,
          existingRepairAvailable: false,
          sources: [],
        };
      if (name === 'article.summary')
        return {
          articles: 120,
          cachedBodies: 120,
          readAvailable: 120,
          likeAvailable: 120,
        };
      if (name === 'article.byId')
        return {
          ...article(25),
          contentHtml: '<p>Fixture saved article only.</p>',
        };
      if (name === 'article.list') {
        if (empty || (input?.search && input.search !== 'alpha'))
          return { items: [], nextCursor: null };
        const start = Number(input?.cursor || 0),
          end = Math.min(start + 20, 260);
        return {
          items: Array.from({ length: end - start }, (_, i) =>
            article(start + i - (inserted ? 1 : 0)),
          ).filter((item) => !deleteAnchor || item.id !== 'article-25'),
          nextCursor: end < 260 ? end : null,
        };
      }
      failures.push('Unexpected API: ' + name);
      throw Error(failures.at(-1));
    };
    try {
      await server.listen();
      const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
      browser = await chromium.launch({
        ...(process.env.BROWSE_TEST_EXECUTABLE
          ? { executablePath: process.env.BROWSE_TEST_EXECUTABLE }
          : { channel: process.env.BROWSE_TEST_CHANNEL || 'msedge' }),
        headless: true,
        timeout: 30000,
      });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
      // Keep blocked-storage behavior limited to browse keys; original auth is out of scope.
      await context.addInitScript(() => {
        if (location.search.includes('deny-storage')) {
          for (const method of ['getItem', 'setItem', 'removeItem']) {
            const original = Storage.prototype[method];
            Storage.prototype[method] = function (key, ...args) {
              if (key.startsWith('wewe.feed-browse'))
                throw Error('fixture blocked storage');
              return original.call(this, key, ...args);
            };
          }
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => failures.push(error.message));
      await context.route('**/*', async (route) => {
        const req = route.request(),
          url = new URL(req.url());
        if (
          url.origin === 'https://r2-assets.111965.xyz' &&
          req.resourceType() === 'image'
        )
          return route.fulfill({
            contentType: 'image/png',
            body: Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5QAAAABJRU5ErkJggg==',
              'base64',
            ),
          });
        if (url.origin !== origin) {
          failures.push('Blocked external request: ' + url.origin);
          return route.abort();
        }
        if (req.method() !== 'GET') {
          failures.push('Blocked mutation: ' + url.pathname);
          return route.abort();
        }
        if (url.pathname === '/startup-status')
          return route.fulfill({
            contentType: 'application/json',
            body: '{"status":"ready","message":""}',
          });
        if (!url.pathname.startsWith('/trpc/')) return route.continue();
        const names = url.pathname.slice(6).split(','),
          inputs = JSON.parse(url.searchParams.get('input') || '{}');
        if (names.includes('article.list')) await pause(180);
        try {
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(
              names.map((name, i) => ({
                result: { data: api(name, inputs[i]) },
              })),
            ),
          });
        } catch {
          await route.abort();
        }
      });
      const visible = async (text) =>
        page.getByText(text, { exact: true }).waitFor({ state: 'visible' });
      const row = (n) => page.locator('[data-article-id="article-' + n + '"]');
      const scroll = page
        .locator('.feed-article-scroll [class*="overflow-y-auto"]')
        .first();
      const check = async (name, action) => {
        console.log('CHECK ' + name);
        await action();
        checks.push(name);
        console.log('PASS ' + name);
      };
      const clear = () =>
        page
          .getByRole('button', { name: '清除筛选与浏览位置', exact: true })
          .click();
      const offset = () =>
        page.evaluate(() => {
          const element = document.querySelector(
            '.feed-article-scroll [class*="overflow-y-auto"]',
          );
          const rect = element.getBoundingClientRect();
          const anchor = [
            ...element.querySelectorAll('[data-article-id]'),
          ].find((row) => row.getBoundingClientRect().bottom > rect.top);
          return {
            id: anchor?.dataset.articleId,
            offset: anchor?.getBoundingClientRect().top - rect.top,
            top: element.scrollTop,
          };
        });
      const waitTop = async (value) => {
        for (let n = 0; n < 100; n++) {
          const actual = await offset();
          if (Math.abs(actual.top - value) < 4) return;
          await pause(40);
        }
        assert.fail(
          'list position did not restore: ' + JSON.stringify(await offset()),
        );
      };

      await page.goto(origin + '/dash/feeds/source-a');
      await visible('alpha Article 000');
      const listReads = () =>
        requests.filter((r) => r.name === 'article.list').length;
      const revReads = () =>
        requests.filter((r) => r.name === 'feed.cacheRevision').length;
      await pause(1100);
      await check(
        'unchanged version neither rereads lists nor shifts the scroll',
        async () => {
          const before = listReads();
          await pause(2200);
          assert.equal(listReads(), before);
          assert.equal((await offset()).top, 0);
        },
      );
      await check(
        'new article reaches actual product list within 2 seconds of revision',
        async () => {
          const started = Date.now();
          inserted = true;
          revision = 'epoch:1';
          await visible('alpha Article 0-1');
          timings.revisionToVisibleMs = Date.now() - started;
          assert(timings.revisionToVisibleMs < 2000);
          await page
            .getByRole('button', { name: '更新完成', exact: true })
            .count()
            .then((n) => assert.equal(n, 0));
        },
      );
      await check(
        'loaded pages, anchor and selected row survive changed revision',
        async () => {
          await page
            .getByRole('button', { name: '加载更多', exact: true })
            .click();
          await row(38).waitFor();
          await row(25).getByRole('checkbox').check();
          await scroll.evaluate((el) => {
            el.scrollTop = 1800;
            el.dispatchEvent(new Event('scroll'));
          });
          const saved = await offset(),
            before = listReads();
          revision = 'epoch:2';
          for (let n = 0; n < 100 && listReads() < before + 2; n++)
            await pause(30);
          await pause(400);
          assert.equal(await row(38).count(), 1);
          const after = await offset();
          assert.equal(after.id, saved.id);
          assert(Math.abs(after.offset - saved.offset) < 4);
          assert(await row(25).getByRole('checkbox').isChecked());
        },
      );
      await check(
        'reading modal remains open while revision changes',
        async () => {
          await row(25).getByText('alpha Article 025', { exact: true }).click();
          await page.getByRole('dialog').waitFor();
          revision = 'epoch:3';
          await pause(1600);
          assert.equal(await page.getByRole('dialog').count(), 1);
          await page.keyboard.press('Escape');
          await page.getByRole('dialog').waitFor({ state: 'detached' });
        },
      );
      await check(
        'read disconnection preserves content and retries the unseen revision',
        async () => {
          const before = listReads();
          disconnected = true;
          revision = 'epoch:disconnected';
          await page
            .getByText(
              '暂无法读取最新列表，已有内容保留；恢复连接后自动检查。',
              { exact: true },
            )
            .waitFor();
          await pause(2200);
          assert.equal(listReads(), before);
          assert.equal(await row(25).count(), 1);
          disconnected = false;
          await page.evaluate(() => {
            Object.defineProperty(navigator, 'onLine', {
              configurable: true,
              get: () => false,
            });
            window.dispatchEvent(new Event('offline'));
            Object.defineProperty(navigator, 'onLine', {
              configurable: true,
              get: () => true,
            });
            window.dispatchEvent(new Event('online'));
          });
          await page
            .getByText(
              '暂无法读取最新列表，已有内容保留；恢复连接后自动检查。',
              { exact: true },
            )
            .waitFor({ state: 'detached' });
          assert(listReads() > before);
        },
      );
      await check(
        'visible but blurred, offline and hidden pages stop version reads and catch up on return',
        async () => {
          await page.evaluate(() => {
            window.__fixtureFocus = false;
            document.hasFocus = () => window.__fixtureFocus;
            window.dispatchEvent(new Event('blur'));
          });
          await pause(200);
          let before = revReads();
          revision = 'epoch:4';
          await pause(1300);
          assert.equal(revReads(), before);
          await page.evaluate(() => {
            window.__fixtureFocus = true;
            window.dispatchEvent(new Event('focus'));
          });
          await pause(1400);
          await page.evaluate(() => {
            Object.defineProperty(navigator, 'onLine', {
              configurable: true,
              get: () => false,
            });
            window.dispatchEvent(new Event('offline'));
          });
          before = revReads();
          revision = 'epoch:5';
          await pause(1300);
          assert.equal(revReads(), before);
          await page.evaluate(() => {
            Object.defineProperty(navigator, 'onLine', {
              configurable: true,
              get: () => true,
            });
            window.dispatchEvent(new Event('online'));
          });
          await pause(1400);
          await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', {
              configurable: true,
              get: () => 'hidden',
            });
            document.dispatchEvent(new Event('visibilitychange'));
          });
          before = revReads();
          revision = 'epoch:6';
          await pause(1300);
          assert.equal(revReads(), before);
          await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', {
              configurable: true,
              get: () => 'visible',
            });
            document.dispatchEvent(new Event('visibilitychange'));
          });
          await pause(1400);
          assert(revReads() > before);
        },
      );
      await check(
        '390px filter keeps date, direction and keyword across revision',
        async () => {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.goto(
            origin +
              '/dash/feeds/source-a?search=alpha&dateStart=2026-10-01&direction=asc',
          );
          await visible('alpha Article 0-1');
          await pause(1100);
          const before = listReads();
          revision = 'epoch:7';
          for (let n = 0; n < 100 && listReads() <= before; n++)
            await pause(30);
          assert.equal(
            await page.evaluate(
              () =>
                JSON.parse(sessionStorage.getItem('wewe.feed-browse.filters'))
                  .filters.articleDates.start,
            ),
            '2026-10-01',
          );
          assert.equal(
            await page.getByLabel('发布时间顺序').inputValue(),
            'asc',
          );
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
          );
          assert.equal(
            requests.filter((r) => r.name === 'article.list').at(-1).input
              .search,
            'alpha',
          );
        },
      );
      assert.deepEqual(failures, []);
      assert(
        requests.every(
          (request) =>
            !/refreshArticles|saveToObsidian|retryBody|addSubscription|login|download/i.test(
              request.name,
            ),
        ),
      );
    } finally {
      if (process.env.BROWSE_TEST_RESULT)
        fs.writeFileSync(
          process.env.BROWSE_TEST_RESULT,
          JSON.stringify(
            { checks, failures, readRequests: requests.length, timings },
            null,
            2,
          ),
        );
      await browser?.close();
      await server.close();
    }
  },
);
