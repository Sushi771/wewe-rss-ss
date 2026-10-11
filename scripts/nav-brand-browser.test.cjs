const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  { spawn } = require('node:child_process'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  base = path.join(root, 'apps/server/client'),
  evidence =
    process.env.NAV_TEST_EVIDENCE ||
    fs.mkdtempSync(path.join(require('os').tmpdir(), 'wewe-nav-test-'));
fs.mkdirSync(evidence, { recursive: true });
const apiReads = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const image =
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="8" fill="%23007aff"/></svg>';
const feeds = [
  {
    id: 'fixture-one',
    mpName: '示例订阅',
    mpCover: image,
    status: 1,
    collectionRoute: { channel: 'wechat2rss', selectedBy: 'saved' },
  },
  {
    id: 'fixture-two',
    mpName: '另一份示例订阅',
    mpCover: image,
    status: 1,
    collectionRoute: { channel: 'wechat2rss', selectedBy: 'saved' },
  },
];
const items = Array.from({ length: 120 }, (_, i) => ({
  id: 'fixture-article-' + i,
  title:
    i === 0
      ? '一篇示例文章：轻松阅读与保存内容'
      : '阅读列表示例文章 ' + (i + 1),
  mpId: 'fixture-one',
  publishTime: 1791633600 - i * 86400,
  bodyCached: true,
  bodyRetry: { allowed: false, reason: '离线演示' },
  feed: { mpName: '示例订阅', collectionChannel: 'wechat2rss' },
  metrics: null,
  sourceUrl: 'https://example.invalid/article/' + i,
}));
let scenario = 'normal',
  requests = [],
  forbidden = [];
function renderHtml(file) {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\{\{#if acceptanceMode\}\}[\s\S]*?\{\{\/if\}\}/g, '')
    .replaceAll('{{ weweRssServerOriginUrl }}', '')
    .replaceAll('{{ enabledAuthCode }}', 'false')
    .replaceAll('{{ privateOnlineMode }}', 'false')
    .replaceAll('{{ acceptanceMode }}', 'false')
    .replaceAll('{{ iconUrl }}', 'data:,');
}
function data(name, input) {
  apiReads.push({ name, input });
  switch (name) {
    case 'feed.list':
      return { items: feeds };
    case 'feed.groups':
    case 'feed.manualRefreshBatches':
    case 'feed.subscriptionBatches':
    case 'account.list':
      return { items: [] };
    case 'feed.addCapability':
      return {
        sources: [{ source: 'wechat2rss', available: false }],
        existingRepairAvailable: false,
      };
    case 'feed.getInProgressHistoryMp':
      return null;
    case 'feed.isRefreshAllMpArticlesRunning':
      return false;
    case 'article.summary':
      return {
        articles:
          scenario === 'empty' ||
          (input?.search && !input.search.startsWith('alpha'))
            ? 0
            : 12,
        readAvailable: false,
        likeAvailable: false,
      };
    case 'article.list':
      return {
        items:
          scenario === 'empty' ||
          (input?.search && !input.search.startsWith('alpha'))
            ? []
            : scenario === 'long'
              ? items.map((item, i) =>
                  i === 0
                    ? {
                        ...item,
                        title:
                          '这是一篇需要自然换行的长标题，用于检查窄屏阅读和勾选区域。'.repeat(
                            8,
                          ),
                      }
                    : i === 1
                      ? {
                          ...item,
                          bodyCached: false,
                          lastBodyStatus: 'unavailable',
                        }
                      : item,
                )
              : items.slice(
                  Number(input?.cursor || 0),
                  Number(input?.cursor || 0) + 20,
                ),
        nextCursor:
          Number(input?.cursor || 0) + 20 < items.length
            ? Number(input?.cursor || 0) + 20
            : null,
      };
    case 'article.byId':
      return {
        title: items[0].title,
        contentHtml:
          '<h1>示例正文</h1><p>这是一段仅用于界面验收的示例文字。阅读正文时可以查找关键词。</p><p>第二段示例文字，保持正常阅读间距。</p><img alt="本地示例图片" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">',
      };
    case 'collection.verificationStatus':
      return { notices: [] };
    default:
      return { items: [] };
  }
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  requests.push({ method: req.method, path: u.pathname });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') {
    forbidden.push(req.url);
    res.statusCode = 405;
    return res.end('{}');
  }
  if (u.pathname === '/startup-status')
    return res.end(JSON.stringify({ status: 'ready', message: '' }));
  if (u.pathname.startsWith('/trpc/')) {
    const names = u.pathname.slice(6).split(',');
    const inputs = JSON.parse(u.searchParams.get('input') || '{}');
    const results = names.map((name, i) =>
      scenario === 'error' && name === 'article.list'
        ? {
            error: {
              message: '离线示例读取失败',
              code: -32603,
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
            },
          }
        : { result: { data: data(name, inputs[i]) } },
    );
    return setTimeout(
      () => res.end(JSON.stringify(results)),
      scenario === 'loading' ? 15000 : 0,
    );
  }
  if (u.pathname.startsWith('/download/'))
    return res.end(
      JSON.stringify({
        directory: '',
        askEveryTime: true,
        browserAvailable: false,
        available: false,
      }),
    );
  let file = path.join(base, u.pathname.replace(/^\/dash\/?/, ''));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(base, 'index.html');
    if (!fs.existsSync(file)) file = path.join(base, 'index.hbs');
  }
  if (file.endsWith('.html') || file.endsWith('.hbs')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(
      renderHtml(file).replace(
        '<head>',
        '<head><script>window.__WEWE_RSS_SERVER_ORIGIN_URL__=location.origin;window.__WEWE_RSS_ENABLED_AUTH_CODE__=false;</script>',
      ),
    );
  }
  res.setHeader(
    'Content-Type',
    file.endsWith('.js')
      ? 'text/javascript'
      : file.endsWith('.css')
        ? 'text/css'
        : 'application/octet-stream',
  );
  res.end(fs.readFileSync(file));
});

// Real compiled product, deterministic local GET fixtures. No database/upstream writes.
(async () => {
  let child, ws;
  const checks = [];
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const profile = fs.mkdtempSync(path.join(evidence, 'profile-'));
    const chrome =
      process.env.NAV_TEST_BROWSER ||
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    child = spawn(
      chrome,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--no-first-run',
        '--disable-background-networking',
        '--no-proxy-server',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
        '--remote-debugging-port=0',
        '--user-data-dir=' + profile,
        'about:blank',
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let errors = '';
    child.stderr.on('data', (x) => (errors += x));
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let n = 0; n < 100 && !fs.existsSync(portFile); n++) await pause(100);
    assert(fs.existsSync(portFile), errors.slice(-500));
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const tabs = await (
      await fetch('http://127.0.0.1:' + port + '/json/list')
    ).json();
    ws = new WebSocket(
      tabs.find((x) => x.type === 'page' && x.url === 'about:blank')
        .webSocketDebuggerUrl,
    );
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    const ev = async (expression) => {
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
      });
      assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const wait = async (expression, label) => {
      for (let n = 0; n < 100; n++) {
        if (await ev(expression)) return;
        await pause(50);
      }
      assert.fail(label);
    };
    const click = async (expression) => {
      const r = await ev(
        '(()=>{const e=' +
          expression +
          ';if(!e)return null;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
      );
      assert(r, 'click target ' + expression);
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...r,
        button: 'left',
        clickCount: 1,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...r,
        button: 'left',
        clickCount: 1,
      });
      await pause(300);
    };
    const key = async (name, code) => {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: name,
        code: name,
        windowsVirtualKeyCode: code,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: name,
        code: name,
        windowsVirtualKeyCode: code,
      });
      await pause(80);
    };
    const sc =
      "document.querySelector('.feed-article-scroll [class*=overflow-y-auto]')";
    const offset =
      '(()=>{const e=' +
      sc +
      ';const r=e.getBoundingClientRect();const a=[...e.querySelectorAll("[data-article-id]")].find(a=>a.getBoundingClientRect().bottom>r.top);return {top:e.scrollTop,id:a?.dataset.articleId,offset:a?.getBoundingClientRect().top-r.top}})()';
    const home = 'document.querySelector("a[aria-label=返回公众号文章列表]")';
    await send('Page.navigate', { url: origin + '/dash/feeds' });
    await pause(900);
    for (const width of [390, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height: width === 390 ? 844 : 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const route of ['tools', 'accounts'])
        for (const method of ['mouse', 'keyboard']) {
          const keyword = 'alpha-' + width + '-' + route + '-' + method;
          await send('Page.navigate', {
            url: origin + '/dash/feeds?search=' + keyword + '&direction=asc',
          });
          await pause(900);
          await wait(
            '!!document.querySelector("[data-article-id=fixture-article-0]")',
            'list loaded',
          );
          await click(
            '[...document.querySelectorAll("button")].find(e=>e.innerText==="加载更多")',
          );
          await wait(
            '!!document.querySelector("[data-article-id=fixture-article-39]")',
            'second page loaded',
          );
          await ev(
            '(()=>{const e=' +
              sc +
              ';e.scrollTop=650;e.dispatchEvent(new Event("scroll"))})()',
          );
          await pause(250);
          const saved = await ev(offset);
          await click(`document.querySelector('a[href="/dash/${route}"]')`);
          await wait('location.pathname==="/dash/' + route + '"', 'departure');
          assert.equal(await ev(home + '.getAttribute("href")'), '/dash/feeds');
          assert.equal(
            await ev('document.documentElement.scrollWidth>innerWidth'),
            false,
          );
          if (method === 'mouse') await click(home);
          else {
            let focused = false;
            for (let n = 0; n < 30 && !focused; n++) {
              await key('Tab', 9);
              focused = await ev(home + '===document.activeElement');
            }
            assert(focused, 'Tab reaches brand');
            assert(
              await ev(home + '.matches(":focus-visible")'),
              'focus visible',
            );
            assert.notEqual(
              await ev('getComputedStyle(' + home + ').outlineStyle'),
              'none',
            );
            await send('Page.captureScreenshot', { format: 'png' }).then((r) =>
              fs.writeFileSync(
                path.join(
                  evidence,
                  'nav-' + width + '-' + route + '-focus.png',
                ),
                Buffer.from(r.data, 'base64'),
              ),
            );
            await key('Enter', 13);
          }
          await wait(
            'location.pathname==="/dash/feeds"',
            'correct basename return',
          );
          await wait(
            '!!document.querySelector("[data-article-id=fixture-article-39]")',
            'restored second page',
          );
          await wait(
            'Math.abs((' + offset + ').top-' + saved.top + ')<4',
            'scroll restored',
          );
          const restored = await ev(offset);
          assert.equal(restored.id, saved.id);
          assert(Math.abs(restored.offset - saved.offset) < 4);
          assert.equal(
            await ev(
              'document.querySelector("select[aria-label=发布时间顺序]").value',
            ),
            'asc',
          );
          assert.equal(
            apiReads.filter((r) => r.name === 'article.list').at(-1).input
              .search,
            keyword,
          );
          checks.push({
            width,
            route,
            method,
            href: '/dash/feeds',
            restoredAnchor: restored.id,
            scrollDelta: restored.top - saved.top,
          });
          console.log('PASS ' + width + ' ' + route + ' ' + method);
        }
    }
    assert.deepEqual(forbidden, []);
    assert(
      apiReads.every(
        (r) =>
          !/refreshArticles|saveToObsidian|retryBody|addSubscription|login|download/i.test(
            r.name,
          ),
      ),
    );
    fs.writeFileSync(
      path.join(evidence, 'result.json'),
      JSON.stringify({ checks, forbidden, apiReads: apiReads.length }, null, 2),
    );
    console.log('EVIDENCE=' + evidence);
  } finally {
    ws?.close();
    child?.kill();
    child?.stderr.destroy();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
