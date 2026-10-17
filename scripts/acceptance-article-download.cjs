// Synthetic local UI/ZIP acceptance. No production app, database, account or platform requests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { inflateRawSync } = require('node:zlib');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const serverRequire = createRequire(
  path.join(root, 'apps/server/package.json'),
);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || 'playwright',
);
const { Module } = serverRequire('@nestjs/common');
const { NestFactory } = serverRequire('@nestjs/core');
const { ConfigService } = serverRequire('@nestjs/config');
const built = path.join(root, 'apps/server/dist/apps/server/src');
const downloads = require(path.join(built, 'article-download'));
const originalBuild = downloads.buildArticleDownload;
const { ArticleDownloadController } = require(
  path.join(built, 'article-download.controller'),
);
const url =
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);

// Read the real archive's central directory, then inflate each stored fixture file.
async function extractFixtureZip(bytes, destination) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(end >= 0, 'valid ZIP end record');
  let cursor = bytes.readUInt32LE(end + 16);
  const files = [];
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10);
    const size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8');
    const local = bytes.readUInt32LE(cursor + 42);
    cursor +=
      46 +
      nameLength +
      bytes.readUInt16LE(cursor + 30) +
      bytes.readUInt16LE(cursor + 32);
    assert(!name.includes('..') && !path.isAbsolute(name));
    if (name.endsWith('/')) continue;
    const offset =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(offset, offset + size);
    assert([0, 8].includes(method));
    const content = method === 8 ? inflateRawSync(compressed) : compressed;
    const file = path.join(destination, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    files.push(name);
  }
  return files;
}

(async () => {
  const output = path.join(root, 'output/playwright/article-download');
  await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-tool-ui-'));
  let app, browser;
  let mode = 'success';
  let calls = 0;
  const upstream = [];
  try {
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    serverRequire('axios').default.get = async () => {
      throw new Error('REAL_NETWORK_DISABLED');
    };
    downloads.buildArticleDownload = async (input, directory) => {
      calls++;
      return originalBuild(input, directory, async (target) => {
        upstream.push(target);
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (target.startsWith('https://mp.weixin.qq.com/')) {
          const html =
            mode === 'verify'
              ? '<div id="js_verify">请完成验证</div>'
              : '<h1 id="activity-name">离线收藏测试</h1><div id="js_content"><p>这是一篇用于回归的合成正文。</p><img data-src="https://mmbiz.qpic.cn/fixture?wx_fmt=png"></div><script>var biz="MTIzNDU2Nzg5MA==";var mid="2247000001";var idx="1";var sn="abcdef";</script>';
          return { status: 200, type: 'text/html', bytes: Buffer.from(html) };
        }
        return {
          status: mode === 'bad-image' ? 302 : 200,
          type: 'image/png',
          bytes: png,
        };
      });
    };
    class FixtureModule {}
    Module({
      controllers: [ArticleDownloadController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({ auth: { code: 'fixture-ui-access' } }),
        },
      ],
    })(FixtureModule);
    app = await NestFactory.create(FixtureModule, { logger: false });
    const client = path.join(root, 'apps/server/client');
    app.useStaticAssets(path.join(client, 'assets'), {
      prefix: '/dash/assets/',
    });
    const template = (await fs.readFile(path.join(client, 'index.hbs'), 'utf8'))
      .replace(/{{#if acceptanceMode}}[\s\S]*?{{\/if}}/g, '')
      .replace(/{{\s*acceptanceMode\s*}}/g, 'true')
      .replace(/{{\s*enabledAuthCode\s*}}/g, 'true')
      .replace(/{{\s*privateOnlineMode\s*}}/g, 'false')
      .replace(/{{[^}]+}}/g, '');
    app
      .getHttpAdapter()
      .get('/dash*', (_req, res) => res.type('html').send(template));
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    browser = await chromium.launch({
      headless: true,
      ...(process.env.BROWSER_EXECUTABLE
        ? { executablePath: process.env.BROWSER_EXECUTABLE }
        : {}),
    });
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1280, height: 850 },
      serviceWorkers: 'block',
    });
    const blocked = [];
    await context.route('**/*', (route) => {
      const target = route.request().url();
      if (
        target.startsWith(origin + '/') ||
        target.startsWith('file:') ||
        target.startsWith(`blob:${origin}/`)
      )
        return route.continue();
      blocked.push(target);
      return route.abort();
    });
    await context.addInitScript(() =>
      localStorage.setItem('authCode', 'fixture-ui-access'),
    );
    const page = await context.newPage();
    await page.goto(origin + '/dash/tools/article-download');
    await page
      .getByRole('heading', { name: '文章下载', exact: true })
      .waitFor();
    await page.getByRole('link', { name: '工具', exact: true }).click();
    assert.equal(new URL(page.url()).pathname, '/dash/tools');
    const input = page.getByRole('textbox', { name: '文章链接' });
    const action = page.getByRole('button', { name: '下载正文和图片' });
    assert(await action.isDisabled());
    await input.fill('https://127.0.0.1/private');
    await action.click();
    await page.getByRole('alert').waitFor();
    assert.equal(calls, 0);
    await input.fill(url);
    // Two immediate native clicks exercise the ref guard before React disables the control.
    await action.evaluate((button) => {
      button.click();
      button.click();
    });
    await page
      .getByRole('status')
      .filter({ hasText: '正在读取正文' })
      .waitFor();
    await page
      .getByRole('status')
      .filter({ hasText: '正文和图片已准备好' })
      .waitFor();
    assert.equal(calls, 1);
    await page.screenshot({
      path: path.join(output, 'desktop-success.png'),
      fullPage: true,
    });
    const saved = page.waitForEvent('download');
    await page.getByRole('link', { name: '保存下载文件' }).click();
    const download = await saved;
    assert.equal(download.suggestedFilename(), '离线收藏测试.zip');
    const archive = path.join(temporary, 'article.zip');
    await download.saveAs(archive);
    const extracted = path.join(temporary, 'extracted');
    const files = await extractFixtureZip(
      await fs.readFile(archive),
      extracted,
    );
    assert(files.includes('index.md') && files.includes('index.html'));
    assert.equal(
      files.filter((file) => file.startsWith('attachments/')).length,
      1,
    );
    const offline = await context.newPage();
    await context.setOffline(true);
    await offline.goto(pathToFileURL(path.join(extracted, 'index.html')).href);
    await offline.getByText('这是一篇用于回归的合成正文。').waitFor();
    await offline.waitForFunction(() =>
      [...document.images].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    );
    await offline.screenshot({
      path: path.join(output, 'offline-article.png'),
      fullPage: true,
    });
    await context.setOffline(false);
    await offline.close();
    mode = 'verify';
    await input.fill(url);
    await action.click();
    await page.getByRole('alert').filter({ hasText: '验证' }).waitFor();
    assert.equal(
      await page.getByRole('link', { name: '保存下载文件' }).count(),
      0,
    );
    await page.screenshot({
      path: path.join(output, 'verification-failure.png'),
      fullPage: true,
    });
    mode = 'bad-image';
    await action.click();
    await page.getByRole('alert').filter({ hasText: '图片' }).waitFor();
    assert.equal(
      await page.getByRole('link', { name: '保存下载文件' }).count(),
      0,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(output, 'mobile-tool.png'),
      fullPage: true,
    });
    assert(
      await page.getByRole('link', { name: '工具', exact: true }).isVisible(),
    );
    const summary = {
      passed: true,
      fixtureOnly: true,
      actualPlatformRequests: 0,
      databaseUsed: false,
      realZipExtracted: true,
      offlineImagesOpened: true,
      duplicateClickRequests: 1,
      invalidUrlRejected: true,
      verificationFailureShown: true,
      imageFailureShown: true,
      toolNavigationVisibleOnMobile: true,
      apiCalls: calls,
      fixtureResources: upstream.length,
      blockedExternalRequests: blocked.length,
    };
    await fs.writeFile(
      path.join(output, 'summary.json'),
      JSON.stringify(summary, null, 2),
    );
    console.log(JSON.stringify(summary));
  } finally {
    downloads.buildArticleDownload = originalBuild;
    if (browser) await browser.close();
    if (app) await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
