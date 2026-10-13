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
  'refresh, reader/tools return, scoped pagination, URL precedence, clear and failure at 390px',
  { skip: !chromium, timeout: 180000 },
  async () => {
    process.chdir(web);
    const { createServer } = require(require.resolve('vite', { paths: [web] }));
    const server = await createServer({
      root: web,
      cacheDir: path.join(root, 'output/browse-test-vite-cache'),
      configFile: path.join(web, 'vite.config.ts'),
      define: { 'import.meta.env.VITE_SERVER_ORIGIN_URL': JSON.stringify('') },
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'browse-offline-fixture',
          transformIndexHtml(html) {
            return html
              .replace(/<link[^>]+>/g, '')
              .replace(
                /window\.__WEWE_RSS_ENABLED_AUTH_CODE__ = [^;]+;/,
                'window.__WEWE_RSS_ENABLED_AUTH_CODE__ = false;',
              );
          },
        },
      ],
    });
    let browser;
    const failures = [],
      checks = [],
      requests = [];
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
            article(start + i),
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
        channel: process.env.BROWSE_TEST_CHANNEL || 'msedge',
        headless: true,
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
      await page.goto(origin + '/dash/feeds');
      await visible('alpha Article 000');
      await check(
        'zero selection hides actions; row and header selection reveal and clear them',
        async () => {
          const actions = page.getByRole('button', {
            name: '清空选择',
            exact: true,
          });
          assert.equal(await actions.count(), 0);
          await row(0).getByRole('checkbox').check();
          await actions.waitFor();
          await actions.click();
          await actions.waitFor({ state: 'detached' });
          await page
            .getByRole('checkbox', { name: '全选已加载', exact: true })
            .check();
          await page.getByText('已选 20 篇', { exact: true }).waitFor();
          await page
            .getByRole('button', { name: '加载更多', exact: true })
            .click();
          await row(39).waitFor();
          await page.getByText('已选 20 篇', { exact: true }).waitFor();
          assert.equal(await row(39).getByRole('checkbox').isChecked(), false);
          await actions.click();
          await clear();
        },
      );
      await check(
        'date, sort and keyword survive refresh visibly; selection stays empty',
        async () => {
          await page
            .getByLabel('原文发布日期', { exact: true })
            .fill('2026-10-01');
          await page.getByLabel('发布时间顺序').selectOption('asc');
          await page
            .locator('button')
            .filter({ has: page.locator('svg circle[cx="11"]') })
            .click();
          await page.getByPlaceholder('搜索标题或内容...').fill('alpha');
          await page.getByPlaceholder('搜索标题或内容...').press('Escape');
          await visible('alpha Article 000');
          await row(0).getByRole('checkbox').check();
          await page.reload();
          await visible('alpha Article 000');
          assert.equal(
            await page.getByLabel('原文发布日期', { exact: true }).inputValue(),
            '2026-10-01',
          );
          assert.equal(
            await page.getByLabel('发布时间顺序').inputValue(),
            'asc',
          );
          await page
            .locator('[title="搜索：alpha"]')
            .waitFor({ state: 'visible' });
          assert.equal(
            await page.locator('.feed-article-scroll input:checked').count(),
            0,
          );
        },
      );
      let before;
      await check(
        'async second page and article anchor survive refresh and reader close',
        async () => {
          await page
            .getByRole('button', { name: '加载更多', exact: true })
            .click();
          await row(39).waitFor();
          await scroll.evaluate((element) => {
            const row = element.querySelector('[data-article-id="article-25"]');
            element.scrollTop +=
              row.getBoundingClientRect().top -
              element.getBoundingClientRect().top +
              7;
            element.dispatchEvent(new Event('scroll'));
          });
          before = await offset();
          assert.equal(before.id, 'article-25');
          await page.reload();
          await row(39).waitFor();
          await waitTop(before.top);
          await row(26).getByRole('link').click();
          await page.getByTitle('已保存文章正文').waitFor();
          assert.equal(
            await page.getByTitle('已保存文章正文').getAttribute('sandbox'),
            '',
          );
          await page
            .getByRole('button', { name: 'Close', exact: true })
            .click();
          await waitTop(before.top);
          await page
            .getByTitle('已保存文章正文')
            .waitFor({ state: 'detached' });
        },
      );
      await check(
        'tools route return restores list, never auto-opens reader or downloads',
        async () => {
          // The retired tools navigation entry must stay absent. Exercise the
          // retained route directly and use browser Back to return to the list.
          await page.goto(origin + '/dash/tools');
          assert(page.url().includes('/tools'));
          await page.goBack();
          await row(39).waitFor();
          await waitTop(before.top);
          await page
            .getByTitle('已保存文章正文')
            .waitFor({ state: 'detached' });
        },
      );
      await check(
        'switch group/source separates views; explicit query beats cache',
        async () => {
          await page.getByText('Fixture Group', { exact: true }).click();
          await visible('alpha Article 000');
          await page.reload();
          await visible('alpha Article 000');
          assert(requests.at(-1).name !== 'mutation');
          await page.goto(
            origin + '/dash/feeds/source-b?search=none&direction=desc',
          );
          await visible('当前筛选暂无文章');
          assert.equal(
            await page.getByLabel('原文发布日期', { exact: true }).inputValue(),
            '',
          );
          assert.equal(
            await page.getByLabel('发布时间顺序').inputValue(),
            'desc',
          );
          const request = requests
            .filter((r) => r.name === 'article.list')
            .at(-1).input;
          assert.equal(request.mpId, 'source-b');
          assert.equal(request.group, 'all');
          assert.equal(request.search, 'none');
          await clear();
          await visible('alpha Article 000');
          assert(!new URL(page.url()).search);
          await page.reload();
          await visible('alpha Article 000');
        },
      );
      await check(
        'clear removes pagination checkpoints and positions; sort stays default',
        async () => {
          await page
            .getByRole('button', { name: '加载更多', exact: true })
            .click();
          await row(39).waitFor();
          await scroll.evaluate((element) => {
            element.scrollTop = 700;
            element.dispatchEvent(new Event('scroll'));
          });
          await clear();
          await visible('alpha Article 000');
          await waitTop(0);
          await row(39).waitFor({ state: 'detached' });
          assert.equal(
            await page.locator('.feed-article-scroll input:checked').count(),
            0,
          );
        },
      );
      await check(
        'deleted article/empty result/deleted source and group degrade safely',
        async () => {
          await page
            .getByRole('button', { name: '加载更多', exact: true })
            .click();
          await row(39).waitFor();
          await scroll.evaluate((element) => {
            const row = element.querySelector('[data-article-id="article-25"]');
            element.scrollTop +=
              row.getBoundingClientRect().top -
              element.getBoundingClientRect().top;
            element.dispatchEvent(new Event('scroll'));
          });
          deleteAnchor = true;
          await page.reload();
          await row(39).waitFor();
          assert.equal(await row(25).count(), 0);
          empty = true;
          await page.reload();
          await visible('当前筛选暂无文章');
          await waitTop(0);
          empty = false;
          await page.goto(origin + '/dash/feeds/deleted-source');
          await visible('alpha Article 000');
          assert.equal(new URL(page.url()).pathname, '/dash/feeds');
          await page.getByText('Fixture Group', { exact: true }).click();
          await visible('alpha Article 000');
          groups = [];
          await page.reload();
          await visible('alpha Article 000');
          for (
            let n = 0;
            n < 100 &&
            requests.filter((r) => r.name === 'article.list').at(-1).input
              .group !== 'all';
            n++
          )
            await pause(30);
          assert.equal(
            requests.filter((r) => r.name === 'article.list').at(-1).input
              .group,
            'all',
          );
        },
      );
      await check(
        '390px clear remains usable; disabled storage is harmless',
        async () => {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.goto(origin + '/dash/feeds?search=' + 'x'.repeat(700));
          await visible('当前筛选暂无文章');
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
          );
          await clear();
          await visible('alpha Article 000');
          await page.goto(origin + '/dash/feeds?deny-storage=1');
          await visible('alpha Article 000');
          await page.getByLabel('发布时间顺序').selectOption('asc');
          await page.reload();
          await visible('alpha Article 000');
          assert.equal(
            await page.getByLabel('发布时间顺序').inputValue(),
            'desc',
          );
          await clear();
        },
      );
      await check(
        'ten-page restore remains bounded with changed row heights and permits manual pagination',
        async () => {
          deleteAnchor = false;
          empty = false;
          await page.goto(origin + '/dash/feeds');
          await visible('alpha Article 000');
          await clear();
          for (let n = 2; n <= 11; n++) {
            await page
              .getByRole('button', { name: '加载更多', exact: true })
              .click();
            await row(n * 20 - 1).waitFor();
          }
          await scroll.evaluate((element) => {
            element.scrollTop = 800;
            element.dispatchEvent(new Event('scroll'));
          });
          await page.reload();
          await row(199).waitFor();
          await pause(300);
          assert.equal(await page.locator('[data-article-id]').count(), 200);
          assert.equal(await row(219).count(), 0);
          // An older layout's pixel top must yield to the saved article anchor.
          await scroll.evaluate((element) => {
            const article = element.querySelector(
              '[data-article-id="article-25"]',
            );
            element.scrollTop +=
              article.getBoundingClientRect().top -
              element.getBoundingClientRect().top +
              7;
            element.dispatchEvent(new Event('scroll'));
          });
          let saved = await offset();
          await page.addStyleTag({
            content:
              '.compact-row.article-row-ready { min-height: 96px !important; }',
          });
          await scroll.evaluate((element) => {
            const article = element.querySelector(
              '[data-article-id="article-25"]',
            );
            element.scrollTop +=
              article.getBoundingClientRect().top -
              element.getBoundingClientRect().top +
              7;
            element.dispatchEvent(new Event('scroll'));
          });
          saved = await offset();
          await page.reload();
          await row(199).waitFor();
          for (let n = 0; n < 100 && (await offset()).id !== saved.id; n++)
            await pause(30);
          assert.equal((await offset()).id, saved.id);
          assert(Math.abs((await offset()).offset - saved.offset) < 4);
          await page
            .getByRole('button', { name: '加载更多', exact: true })
            .click();
          await row(219).waitFor();
          await clear();
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
            { checks, failures, readRequests: requests.length },
            null,
            2,
          ),
        );
      await browser?.close();
      await server.close();
    }
  },
);
