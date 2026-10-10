// Opt-in real Edge verification, using a fresh ephemeral browser profile.
// Set WEWE_PLAYWRIGHT_MODULE to an existing Playwright installation.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(
  process.env.WEWE_PLAYWRIGHT_MODULE || 'playwright',
);

(async () => {
  const output = path.resolve(__dirname, '../output/playwright');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  try {
    await page.goto('http://localhost:4000/dash/feeds/MP_WXS_3895431412', {
      waitUntil: 'networkidle',
    });
    const snapshot = await page.locator('body').ariaSnapshot();
    await fs.writeFile(path.join(output, 'edge-before.yml'), snapshot);
    await page.screenshot({
      path: path.join(output, 'edge-before.png'),
      fullPage: true,
    });
    console.log(snapshot);
    if (process.argv.includes('--bind-albums')) {
      await page
        .getByRole('button', { name: '公开合集补采', exact: true })
        .click();
      console.log(await page.getByRole('dialog').ariaSnapshot());
      await page
        .getByRole('textbox', { name: '公开合集 ID 公开合集 ID', exact: true })
        .fill('2527940920407949313,3588220544052641807');
      const responsePromise = page.waitForResponse(
        (response) => response.url().includes('collection.collectPublicAlbums'),
        { timeout: 60000 },
      );
      await page
        .getByRole('button', { name: '补采并绑定合集', exact: true })
        .click();
      const response = await responsePromise;
      const result = await response.json();
      await fs.writeFile(
        path.join(output, 'edge-first-collection-result.json'),
        JSON.stringify(result, null, 2),
      );
      await page
        .getByRole('dialog')
        .waitFor({ state: 'hidden', timeout: 45000 });
      await page
        .getByRole('status')
        .filter({ hasText: '本次操作' })
        .waitFor({ timeout: 10000 });
      await fs.writeFile(
        path.join(output, 'edge-first-collection.yml'),
        await page.locator('body').ariaSnapshot(),
      );
      await page.screenshot({
        path: path.join(output, 'edge-first-collection.png'),
        fullPage: true,
      });
      console.log(JSON.stringify({ firstCollection: result }));
    }
    if (process.argv.includes('--inspect-dialog')) {
      await page
        .getByRole('button', { name: '公开合集补采', exact: true })
        .click();
      console.log(await page.locator('body').ariaSnapshot());
    }
    if (process.argv.includes('--inspect-export')) {
      const row = page.locator('.compact-row').filter({
        has: page.getByRole('link', {
          name: '徐汇要建一个南模9年制学校？',
          exact: true,
        }),
      });
      if ((await row.count()) !== 1)
        throw new Error(
          'Target export row is duplicated; repair identities before export',
        );
      await row.getByRole('checkbox').check();
      console.log(await page.locator('body').ariaSnapshot());
    }
    if (process.argv.includes('--export')) {
      const row = page.locator('.compact-row').filter({
        has: page.getByRole('link', {
          name: '徐汇要建一个南模9年制学校？',
          exact: true,
        }),
      });
      if ((await row.count()) !== 1)
        throw new Error('Target export row is duplicated');
      await row.getByRole('checkbox').check();
      const selected = await page.locator('body').ariaSnapshot();
      await fs.writeFile(
        path.join(output, 'edge-export-selected.yml'),
        selected,
      );
      const responsePromise = page.waitForResponse(
        (response) => response.url().includes('article.saveToObsidian'),
        { timeout: 60000 },
      );
      await page
        .getByRole('button', { name: '批量导出 Obsidian (1)', exact: true })
        .click();
      const payload = await (await responsePromise).json();
      const saved = (Array.isArray(payload) ? payload[0] : payload).result
        ?.data;
      if (!saved?.success) throw new Error('Real Edge export failed');
      await page
        .getByText('成功导出 1 篇文章', { exact: true })
        .waitFor({ timeout: 15000 });
      const markdown = await fs.readFile(saved.path, 'utf8');
      const names = [
        ...new Set(
          markdown.match(/image\/image_[a-f0-9]+\.(?:png|jpe?g|gif|webp)/g) ||
            [],
        ),
      ];
      const images = await Promise.all(
        names.map(async (name) => {
          const bytes = await fs.readFile(
            path.join(path.dirname(saved.path), name),
          );
          return {
            name,
            bytes: bytes.length,
            jpeg: bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
          };
        }),
      );
      const summary = {
        markdownPath: saved.path,
        bodyPresent: markdown.includes('南模'),
        favoriteMissing: markdown.includes('| 收藏 | 未提供 |'),
        incorrectlyLabelsWcd: markdown.includes('数据来源：WeChatDownload'),
        images,
      };
      await fs.writeFile(
        path.join(output, 'edge-export-result.json'),
        JSON.stringify(summary, null, 2),
      );
      await page.screenshot({
        path: path.join(output, 'edge-export.png'),
        fullPage: true,
      });
      console.log(JSON.stringify({ realEdgeExport: summary }));
      if (
        !summary.bodyPresent ||
        images.length !== 7 ||
        images.some((image) => !image.jpeg)
      )
        throw new Error('Real export body/image checks failed');
    }
    if (process.argv.includes('--update')) {
      // The target detail page exposes one update button in the observed UI.
      const update = page.getByRole('button', { name: '更新', exact: true });
      if ((await update.count()) !== 1)
        throw new Error('Target update button is not unique');
      const responsePromise = page.waitForResponse(
        (response) => response.url().includes('feed.refreshArticles'),
        { timeout: 60000 },
      );
      await update.click();
      const response = await responsePromise;
      const result = await response.json();
      await fs.writeFile(
        path.join(output, 'edge-repeat-update-result.json'),
        JSON.stringify(result, null, 2),
      );
      await page
        .getByRole('status')
        .filter({ hasText: '本次操作' })
        .waitFor({ timeout: 45000 });
      const after = await page.locator('body').ariaSnapshot();
      await fs.writeFile(path.join(output, 'edge-after.yml'), after);
      await page.screenshot({
        path: path.join(output, 'edge-after.png'),
        fullPage: true,
      });
      console.log(after);
      console.log(JSON.stringify({ repeatedUpdate: result }));
    }
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
