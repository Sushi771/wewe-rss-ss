// Synthetic desktop save acceptance. No real upstream, browser credentials or production database.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const server = process.env.LOCAL_RELEASE_ROOT
  ? path.join(path.resolve(process.env.LOCAL_RELEASE_ROOT), 'server')
  : path.join(root, 'apps/server');
const localRequire = createRequire(path.join(server, 'package.json'));
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || 'playwright',
);
const { Module } = localRequire('@nestjs/common');
const { NestFactory } = localRequire('@nestjs/core');
const { ConfigService } = localRequire('@nestjs/config');
const built = path.join(server, 'dist/apps/server/src');
const downloads = require(path.join(built, 'article-download'));
const picker = require(path.join(built, 'article-folder-picker'));
const originalBuild = downloads.buildArticleDownload;
const single = require(path.join(built, 'wechat2rss-single-download'));
const originalPrepare = single.prepareWechat2RssSingleDownload;
const { buildArticleMarkdown } = require(path.join(built, 'article-export'));
const originalPicker = picker.pickArticleDirectory;
const { ArticleDownloadController } = require(
  path.join(built, 'article-download.controller'),
);
const url =
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
(async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wewe-tool-save-ui-'),
  );
  const destination = path.join(
    temporary,
    'Obsidian Vault',
    '公众号的文章（待分类）',
  );
  const output = path.join(root, 'output/playwright/article-local-save');
  await fs.mkdir(destination, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  let app, browser;
  let mode = 'success',
    cancelPicker = false,
    calls = 0,
    pickerCalls = 0,
    resources = 0;
  try {
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    process.env.DATABASE_URL = 'file:' + path.join(temporary, 'unused.sqlite');
    await fs.writeFile(
      path.join(temporary, '.article-download-settings.json'),
      JSON.stringify({ directory: destination, askEveryTime: false }),
    );
    localRequire('axios').default.get = async () => {
      throw new Error('REAL_NETWORK_DISABLED');
    };
    picker.pickArticleDirectory = async () => {
      pickerCalls++;
      return cancelPicker ? null : destination;
    };
    downloads.buildArticleDownload = async () => {
      throw new Error('PUBLIC_ARTICLE_FORBIDDEN');
    };
    // Simulate only the trusted Wechat2RSS source boundary. The real client and
    // exact cache/media contracts are tested by wechat2rss-single-download.spec.ts.
    single.prepareWechat2RssSingleDownload = async (input) => {
      assert.equal(input, url);
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (mode === 'cache-failure')
        throw new downloads.ArticleDownloadError(
          'Wechat2RSS 缓存读取失败，未保存，不使用其他来源。',
          409,
          { code: 'WECHAT2RSS_SINGLE_CACHE_READ_FAILED' },
        );
      if (mode === 'bad-image')
        throw new downloads.ArticleDownloadError(
          'Wechat2RSS 图片资源校验失败，未保存。',
          422,
          { code: 'WECHAT2RSS_SINGLE_IMAGES_UNAVAILABLE' },
        );
      return async (directory) => {
        resources++;
        const exported = await buildArticleMarkdown(
          {
            id: 'WX_1234567890_2247000001_1',
            title: '离线保存测试',
            sourceUrl: null,
            contentHtml:
              '<div id="js_content"><p>这是一篇用于本机保存回归的合成正文。</p><img src="data:image/png;base64,' +
              png.toString('base64') +
              '"></div>',
            lastBodyStatus: 'available',
            metrics: null,
            publishTime: 1700000000,
          },
          '',
          directory,
          async () => {
            throw new Error('REMOTE_MEDIA_FORBIDDEN');
          },
          'image',
        );
        await fs.writeFile(
          path.join(directory, 'index.md'),
          '# 离线保存测试\n\n' + exported.markdown,
        );
        return {
          articleId: 'WX_1234567890_2247000001_1',
          title: '离线保存测试',
          imageCount: 1,
          source: 'wechat2rss',
        };
      };
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
    app.useStaticAssets(path.join(server, 'client/assets'), {
      prefix: '/dash/assets/',
    });
    const template = (
      await fs.readFile(path.join(server, 'client/index.hbs'), 'utf8')
    )
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
      viewport: { width: 1280, height: 900 },
      serviceWorkers: 'block',
    });
    const blocked = [];
    await context.route('**/*', (route) => {
      const target = route.request().url();
      if (target.startsWith(origin + '/') || target.startsWith('file:'))
        return route.continue();
      blocked.push(target);
      return route.abort();
    });
    await context.addInitScript(() =>
      localStorage.setItem('authCode', 'fixture-ui-access'),
    );
    const page = await context.newPage();
    await page.goto(origin + '/dash/tools/article-download');
    await page.getByText(destination, { exact: true }).waitFor();
    const input = page.getByRole('textbox', { name: '文章链接' });
    const action = page.getByRole('button', { name: '下载正文和图片' });
    const ask = page.getByRole('checkbox', { name: '每次下载询问路径' });
    assert(!(await ask.isChecked()));
    assert(await action.isDisabled());
    await input.fill('https://127.0.0.1/private');
    await action.click();
    await page.getByRole('alert').waitFor();
    assert.equal(calls, 0);
    await input.fill(url);
    await action.evaluate((button) => {
      button.click();
      button.click();
    });
    await page
      .getByRole('status')
      .filter({ hasText: '正文和图片已保存到本机' })
      .waitFor();
    assert.equal(calls, 1);
    assert.equal(pickerCalls, 0);
    const state = await page.locator('body').innerText();
    assert(!state.includes('保存 ZIP'));
    const days = await fs.readdir(destination);
    assert.equal(days.length, 1);
    const dateDir = path.join(destination, days[0]);
    const folders = await fs.readdir(dateDir);
    assert.equal(folders.length, 1);
    const article = path.join(dateDir, folders[0]);
    const markdown = await fs.readFile(path.join(article, '正文.md'), 'utf8');
    assert(markdown.includes('合成正文'));
    const relative = markdown.match(/\(image\/([^\)]+)\)/)[1];
    assert(
      (await fs.readFile(path.join(article, 'image', relative))).equals(png),
    );
    assert(
      !(await fs.readdir(article)).some((name) =>
        /\.zip|index\.html/.test(name),
      ),
    );
    const viewer = path.join(temporary, 'offline-image-check.html');
    await fs.writeFile(
      viewer,
      `<p>合成保存验证</p><img src="${pathToFileURL(path.join(article, 'image', relative)).href}">`,
    );
    const offline = await context.newPage();
    await context.setOffline(true);
    await offline.goto(pathToFileURL(viewer).href);
    await offline.waitForFunction(() =>
      [...document.images].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    );
    await context.setOffline(false);
    await offline.close();
    await fs.writeFile(path.join(article, '正文.md'), '用户自己的笔记');
    await action.click();
    await page.getByRole('status').filter({ hasText: '今天已保存' }).waitFor();
    assert.equal(
      await fs.readFile(path.join(article, '正文.md'), 'utf8'),
      '用户自己的笔记',
    );
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith('/article/settings') &&
          response.request().method() === 'POST',
      ),
      ask.check(),
    ]);
    cancelPicker = true;
    const beforeCancel = calls;
    await action.click();
    await page
      .getByRole('status')
      .filter({ hasText: '已取消选择路径' })
      .waitFor();
    assert.equal(calls, beforeCancel);
    cancelPicker = false;
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith('/article/settings') &&
          response.request().method() === 'POST',
      ),
      ask.uncheck(),
    ]);
    await page.reload();
    await page.getByText(destination, { exact: true }).waitFor();
    assert(!(await ask.isChecked()));
    mode = 'cache-failure';
    await input.fill(url);
    await action.click();
    await page.getByRole('alert').filter({ hasText: '缓存读取' }).waitFor();
    mode = 'bad-image';
    await action.click();
    await page.getByRole('alert').filter({ hasText: '图片' }).waitFor();
    assert.equal((await fs.readdir(dateDir)).length, 1);
    await page.screenshot({
      path: path.join(output, 'desktop-tool.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(output, 'mobile-tool.png'),
      fullPage: true,
    });
    const summary = {
      passed: true,
      syntheticOnly: true,
      actualPlatformRequests: 0,
      productionDatabaseUsed: false,
      directMarkdownAndImageSave: true,
      offlineImageOpened: true,
      noZip: true,
      duplicateClickRequests: 1,
      duplicateUserNotesPreserved: true,
      cancellationDoesNotDownload: true,
      promptingPreferenceRemembered: true,
      failureDoesNotCreateCompleteDirectory: true,
      nativeDialogMocked: true,
      apiCalls: calls,
      fixtureResources: resources,
      blockedExternalRequests: blocked.length,
    };
    await fs.writeFile(
      path.join(output, 'summary.json'),
      JSON.stringify(summary, null, 2),
    );
    console.log(JSON.stringify(summary));
  } finally {
    downloads.buildArticleDownload = originalBuild;
    picker.pickArticleDirectory = originalPicker;
    if (browser) await browser.close();
    if (app) await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
