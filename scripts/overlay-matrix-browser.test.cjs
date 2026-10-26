const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  { spawn } = require('node:child_process'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  base = path.join(root, 'apps/server/client'),
  evidence = fs.mkdtempSync(
    path.join(require('os').tmpdir(), 'wewe-overlay-matrix-'),
  );
fs.mkdirSync(evidence, { recursive: true });
const apiReads = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const image =
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="8" fill="%23007aff"/></svg>';
// Deliberately non-login synthetic code with four distinct corner markers.
const qrImage =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="white"/><path d="M32 32h56v56H32z M168 32h56v56h-56z M32 168h56v56H32z M168 168h56v56h-56z" fill="black"/><path d="M44 44h32v32H44z M180 44h32v32h-32z M44 180h32v32H44z M180 180h32v32h-32z" fill="white"/><path d="M112 32h16v32h-16z M112 96h32v16h-32z M96 128h48v16H96z M128 160h16v64h-16z M160 112h64v16h-64z" fill="black"/><rect x="4" y="4" width="12" height="12" fill="red"/><rect x="240" y="4" width="12" height="12" fill="green"/><rect x="4" y="240" width="12" height="12" fill="blue"/><rect x="240" y="240" width="12" height="12" fill="purple"/></svg>',
  );
const withoutSnUrl =
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=12&idx=1';
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
  bodyCached: i % 2 === 0,
  bodyRetry: { allowed: false, reason: '离线演示' },
  feed: { mpName: '示例订阅', collectionChannel: 'wechat2rss' },
  metrics: null,
  sourceUrl:
    i < 2
      ? withoutSnUrl
      : i === 2
        ? null
        : i === 3
          ? 'javascript:alert(1)'
          : 'https://mp.weixin.qq.com/s/synthetic-article-' + i,
}));
let batchReads = 0;
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
const engagement = {
  metrics: {
    values: { likes: 0, collects: 12, shares: null, comments: 2 },
    collectedAt: 1760000000000,
    contract: 'synthetic',
    evidence: 'source-only',
  },
  creatorMetrics: null,
  totalSaved: 2,
  returned: 2,
  offset: 0,
  windows: [
    {
      scope: 'top',
      pages: 1,
      state: 'returned-end',
      collectedAt: 1760000000000,
      code: null,
      nextCursor: null,
    },
  ],
  comments: [
    {
      id: 'root',
      rootId: null,
      parentId: null,
      authorName: '合成评论者',
      content: '<script>literal</script> ' + '长评论'.repeat(60),
      likes: 0,
      publishedAt: null,
      collectedAt: 1760000000000,
    },
    {
      id: 'reply',
      rootId: 'root',
      parentId: null,
      authorName: '合成回复者',
      content: '仅合成回复',
      likes: null,
      publishedAt: null,
      collectedAt: 1760000000000,
    },
  ],
};
function data(name, input) {
  apiReads.push({ name, input });
  switch (name) {
    case 'feed.subscriptionBatches': {
      if (scenario !== 'exceptions') return { items: [] };
      const blocked = ++batchReads > 1;
      return {
        items: [
          {
            batchId: 'synthetic-batch',
            state: blocked ? 'paused' : 'running',
            items: Array.from({ length: 35 }, (_, index) => ({
              index,
              feedId: null,
              state: blocked ? 'blocked' : 'running',
              code: blocked ? 'CACHE_READ_FAILED' : null,
              listReady: false,
              bodyReady: false,
            })),
          },
        ],
      };
    }
    case 'feed.list':
      return { items: feeds };
    case 'feed.cacheRevision':
      return { revision: 'synthetic-stable' };
    case 'article.searchStatus':
      return { total: 120, uncached: 0, pending: 0 };
    case 'xiaohongshu.groups':
    case 'feed.groups':
      return {
        items: [
          { id: 'fixture-folder', name: '合成文件夹', position: 0, count: 0 },
        ],
      };
    case 'feed.manualRefreshBatches':

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
            : 120,
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
    case 'xiaohongshu.capability':
      return { canRefresh: false };
    case 'xiaohongshu.connectionStatus':
      return { connected: false, stored: false };
    case 'xiaohongshu.sourceRequestBudget':
      return null; // No configured budget in this layout-only synthetic fixture.
    case 'xiaohongshu.list':
      return {
        items: [
          {
            id: 'creator-one',
            displayName: '合成博主',
            enabled: false,
            groupId: null,
            _count: { notes: 120 },
          },
        ],
      };
    case 'xiaohongshu.notes':
      return {
        items: items.map((item, i) => ({
          ...item,
          id: JSON.stringify(['xiaohongshu', 'note', 'fixture-' + i]),
          creatorId: 'creator-one',
          creatorName: '合成博主',
          kind: 'image-text',
          status: 'complete',
        })),
      };
    case 'xiaohongshu.engagement':
      return engagement;
    case 'feed.cacheSyncStatus':
      return { feeds: [], media: [] };
    case 'collection.verificationStatus':
      return {
        notices:
          scenario === 'notice'
            ? Array.from({ length: 12 }, (_, i) => ({
                feedId: 'notice-' + i,
                feedName: '合成公众号 ' + i,
                stage: '合成状态',
                state: 'expired',
                accountName: '合成账号',
                accountTail: '0000',
                officialUrl: 'https://example.invalid/',
              }))
            : [],
      };
    case 'feed.subscriptionTasks':
    case 'account.manualRefreshOptions':
    case 'xiaohongshu.wholeCreatorJobs':
    case 'xiaohongshu.recentTasks':
      return { items: [] };
    default:
      forbidden.push('Unmocked query: ' + name);
      return null;
  }
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  requests.push({ method: req.method, path: u.pathname });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (
    req.method === 'POST' &&
    /\/trpc\/account.wechat2rssLogin(Start|Poll|Close)$/.test(u.pathname)
  ) {
    const state =
      scenario === 'account-error'
        ? 'failed'
        : scenario.startsWith('account-wait')
          ? 'waiting'
          : 'expired';
    const data = u.pathname.endsWith('Close')
      ? {}
      : {
          state,
          message:
            state === 'expired' ? '合成登录状态。'.repeat(100) : '合成登录状态',
          sessionId: 'synthetic-session',
          expiresAt: Date.now() + 180000,
          qrcode: scenario === 'account-wait-qr' ? qrImage : undefined,
        };
    return res.end(JSON.stringify({ result: { data } }));
  }
  if (
    req.method === 'POST' &&
    u.pathname === '/trpc/collection.preview' &&
    scenario === 'import-long'
  ) {
    return setTimeout(
      () =>
        res.end(
          JSON.stringify({
            result: {
              data: {
                csvFiles: 2,
                articles: 80,
                bodies: 60,
                feeds: [{ name: '合成导入来源' }],
                sample: Array.from({ length: 50 }, (_, i) => ({
                  title: '合成预览文章 ' + i + '，长标题。'.repeat(8),
                })),
                warnings: ['合成警告。'.repeat(60)],
              },
            },
          }),
        ),
      1000,
    );
  }
  if (
    req.method === 'POST' &&
    u.pathname === '/trpc/collection.preview' &&
    scenario === 'import-error'
  ) {
    return res.end(
      JSON.stringify({
        error: {
          message: '合成预览失败',
          code: -32603,
          data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
        },
      }),
    );
  }
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
    const batch = u.searchParams.get('batch') === '1';
    const results = names.map((name, i) =>
      scenario === 'error' && name === 'article.list'
        ? {
            error: {
              message: '离线示例读取失败',
              code: -32603,
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
            },
          }
        : { result: { data: data(name, batch ? inputs[i] : inputs) } },
    );
    return setTimeout(
      () => res.end(JSON.stringify(batch ? results : results[0])),
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
      process.env.RESPONSIVE_TEST_BROWSER ||
      (process.env.PATH || '')
        .split(path.delimiter)
        .filter(Boolean)
        .flatMap((directory) =>
          [
            'msedge.exe',
            'chrome.exe',
            'google-chrome',
            'chromium',
            'chromium-browser',
          ].map((name) => path.join(directory, name)),
        )
        .find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
    assert(
      chrome,
      'Set RESPONSIVE_TEST_BROWSER to an installed Chromium browser',
    );
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
      await fetch('http://127.0.0.1:' + port + '/json/list', {
        signal: AbortSignal.timeout(5000),
      })
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
      if (m.method === 'Runtime.exceptionThrown')
        console.log('RUNTIME ' + JSON.stringify(m.params.exceptionDetails));
      if (m.id) {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.timer);
        m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        const timer = setTimeout(() => {
          pending.delete(n);
          reject(Error('Isolated CDP timed out: ' + method));
        }, 10000);
        pending.set(n, { resolve, reject, timer });
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
      fs.writeFileSync(
        path.join(evidence, 'failure.json'),
        JSON.stringify(
          {
            label,
            requests,
            apiReads,
            page: await ev(
              '({text:document.body.innerText,html:document.documentElement.outerHTML.slice(-18000),toolbar:document.querySelector(".feed-reading-toolbar")?.outerHTML,active:document.activeElement?.outerHTML,docHeight:document.documentElement.scrollHeight,innerHeight})',
            ),
          },
          null,
          2,
        ),
      );
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(
        path.join(evidence, 'failure.png'),
        Buffer.from(shot.data, 'base64'),
      );
      assert.fail(label);
    };
    const click = async (expression) => {
      const r = await ev(
        '(()=>{const e=' +
          expression +
          ';if(!e)return null;e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
      );
      assert(r, 'click target ' + expression);
      const hit = await ev(
        `(()=>{const e=${expression}, hit=document.elementFromPoint(${r.x},${r.y});return {ok:e===hit||e.contains(hit),target:e.outerHTML.slice(0,150),hit:hit?.outerHTML.slice(0,150),x:${r.x},y:${r.y},body:[...document.body.children].map(e=>({tag:e.tagName,h:e.getBoundingClientRect().height,bottom:e.getBoundingClientRect().bottom})),shell:document.querySelector('.app-shell').scrollHeight}})()`,
      );
      assert(hit.ok, JSON.stringify(hit));
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
    await send('Page.enable');
    await send('Runtime.enable');
    const firstRow = () =>
      ev('Boolean(document.querySelector(".content-article-row"))');
    const viewport = async (width, height, zoom = 1) => {
      // Browser zoom changes the effective CSS viewport; DPR represents the physical scale.
      await send('Emulation.setDeviceMetricsOverride', {
        width: Math.round(width / zoom),
        height: Math.round(height / zoom),
        deviceScaleFactor: zoom,
        mobile: false,
      });
      await pause(100);
    };
    const geometry = () =>
      ev(`(()=>{
      const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
      const visible=e=>!!e&&e.getBoundingClientRect().width>0&&getComputedStyle(e).visibility!=='hidden';
      const content=document.querySelector('.feed-content'), row=document.querySelector('.content-article-row');
      const region=[...document.querySelectorAll('[role=region]')].find(e=>/文章列表|笔记列表/.test(e.getAttribute('aria-label')));
      const sidebar=document.querySelector('.feed-sidebar');
      const actions=[...document.querySelectorAll('.feed-reading-toolbar button')].filter(visible);
      return {width:innerWidth,height:innerHeight,documentHeight:document.documentElement.scrollHeight,shellHeight:document.querySelector('.app-shell').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth+1,
        content:rect(content),row:rect(row),region:rect(region),sidebar:visible(sidebar),sourceControls:visible(document.querySelector('.feed-source-controls')),
        nav:[...document.querySelectorAll('.mac-nav-pill')].map(e=>({text:e.textContent,visible:visible(e),...rect(e)})),
        actions:actions.map(e=>({text:e.textContent,...rect(e)})),
        filterSummary:document.querySelector('.content-date-filter summary').textContent,
        checked:document.querySelectorAll('.content-article-row input:checked').length};
    })()`);
    const cases = [];
    const button = (text) =>
      `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
    const navigate = async (route = '/dash/feeds/fixture-one') => {
      await viewport(1440, 900);
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.removeEventListener('message', listener);
          reject(Error('navigation load timeout'));
        }, 8000);
        const listener = (e) => {
          if (JSON.parse(e.data).method === 'Page.loadEventFired') {
            clearTimeout(timer);
            ws.removeEventListener('message', listener);
            resolve();
          }
        };
        ws.addEventListener('message', listener);
      });
      await send('Page.navigate', { url: origin + route });
      await loaded;
      await wait("Boolean(document.querySelector('.app-shell'))", 'app shell');
      await pause(500);
    };
    const more = async () => {
      await click("document.querySelector('[aria-label=更多订阅操作]')");
    };
    const dismiss = async () => {
      await key('Escape', 27);
      await pause(400);
    };
    const snapshot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(
        path.join(evidence, name + '.png'),
        Buffer.from(r.data, 'base64'),
      );
    };
    const modalMatrix = async (name) => {
      await wait(
        "Boolean(document.querySelector('.app-dialog'))",
        name + ' dialog',
      );
      for (const [physicalWidth, physicalHeight, zoom = 1] of [
        [2048, 956],
        [1440, 900],
        [768, 600],
        [390, 844],
        [320, 568],
        [667, 320],
        [790, 480, 2],
      ]) {
        const width = Math.round(physicalWidth / zoom),
          height = Math.round(physicalHeight / zoom);
        await viewport(physicalWidth, physicalHeight, zoom);
        await pause(200);
        const g = await ev(
          `(()=>{const d=document.querySelector('.app-dialog'),b=d.querySelector('.app-dialog-body'),h=d.querySelector('header'),f=d.querySelector('footer'),c=[...d.querySelectorAll('button[aria-label=Close],button[aria-label=关闭互动与评论]')].find(e=>e.getBoundingClientRect().width>0);const rect=e=>{const r=e?.getBoundingClientRect();return r&&{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height}};const hit=e=>{if(!e)return true;const r=e.getBoundingClientRect(),p=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return p===e||e.contains(p)};b.scrollTop=b.scrollHeight;return{box:rect(d),header:rect(h),footer:rect(f),close:rect(c),headerHit:hit(h),closeHit:hit(c),bodyScroll:b.scrollTop,bodyHeight:b.clientHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,blocked:!document.querySelector('.app-shell').contains(document.elementFromPoint(2,2)),focus:d.contains(document.activeElement),bodyOverflow:getComputedStyle(b).overflowY}})()`,
        );
        assert(
          g.box.x >= 8 &&
            g.box.right <= width - 8 &&
            g.box.y >= 8 &&
            g.box.bottom <= height - 8,
          JSON.stringify(g),
        );
        assert(g.box.w <= 900, 'dialog width bounded');
        assert(Math.abs(g.box.x - (width - g.box.w) / 2) < 2, 'centered');
        assert(
          g.headerHit && g.closeHit && !g.overflow && g.blocked,
          JSON.stringify(g),
        );
        assert(
          g.bodyHeight > 20 &&
            g.bodyOverflow === (name === 'account-wait-qr' ? 'hidden' : 'auto'),
          JSON.stringify(g),
        );
        if (name === 'account-wait-qr') {
          const qr = await ev(
            `(()=>{const i=document.querySelector('.wechat-login-qr'),r=i.getBoundingClientRect(),b=i.closest('.app-dialog-body').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,body:{x:b.x,y:b.y,right:b.right,bottom:b.bottom},loaded:i.complete&&i.naturalWidth===256,corners:[[r.x+6,r.y+6],[r.right-6,r.y+6],[r.x+6,r.bottom-6],[r.right-6,r.bottom-6]].map(([x,y])=>document.elementFromPoint(x,y)===i),hintVisible:getComputedStyle(document.querySelector('.wechat-qr-short-hint')).display!=='none'};})()`,
          );
          assert(
            qr.loaded &&
              qr.width >= 160 &&
              qr.height >= 160 &&
              Math.abs(qr.width - qr.height) < 1,
            JSON.stringify(qr),
          );
          assert(
            qr.x >= qr.body.x &&
              qr.right <= qr.body.right &&
              qr.y >= qr.body.y &&
              qr.bottom <= qr.body.bottom &&
              qr.corners.every(Boolean),
            JSON.stringify(qr),
          );
          if (height <= 520)
            assert(qr.hintVisible, 'short-window guidance is visible');
          g.qr = qr;
          await snapshot('qr-complete-' + width + 'x' + height);
        }
        if (g.footer) assert(g.footer.bottom <= height - 8, 'footer visible');
        await key('Tab', 9);
        assert(
          await ev(
            "document.querySelector('.app-dialog').contains(document.activeElement)",
          ),
          'keyboard focus retained',
        );
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Tab',
          code: 'Tab',
          windowsVirtualKeyCode: 9,
          modifiers: 8,
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Tab',
          code: 'Tab',
          windowsVirtualKeyCode: 9,
          modifiers: 8,
        });
        assert(
          await ev(
            "document.querySelector('.app-dialog').contains(document.activeElement)",
          ),
          'reverse keyboard focus retained',
        );
        cases.push({
          name,
          width,
          height,
          zoom,
          status: 'passed',
          geometry: g,
        });
        if (width === 2048 || width === 390 || height === 320)
          await snapshot(name + '-' + width + 'x' + height);
      }
      if (name === 'account-wait-qr') {
        await viewport(395, 220);
        const fallback = await ev(
          "(()=>{const i=document.querySelector('.wechat-login-qr'),p=document.querySelector('.wechat-qr-too-small'),c=document.querySelector('.app-dialog button[aria-label=Close]'),r=c.getBoundingClientRect();return {hidden:getComputedStyle(i).display==='none',messageVisible:getComputedStyle(p).display!=='none',closeHit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===c||c.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()",
        );
        assert(
          fallback.hidden && fallback.messageVisible && fallback.closeHit,
          JSON.stringify(fallback),
        );
        cases.push({
          name: 'account-qr-too-small',
          width: 395,
          height: 220,
          status: 'passed',
          fallback,
        });
        await snapshot('qr-height-fallback-395x220');
      }
      await dismiss();
      assert.equal(
        await ev("Boolean(document.querySelector('.app-dialog'))"),
        false,
        'Escape closes',
      );
    };
    const run = async (name, fn) => {
      if (
        process.env.OVERLAY_TEST_CASE &&
        !name.includes(process.env.OVERLAY_TEST_CASE)
      )
        return;
      try {
        await fn();
      } catch (e) {
        cases.push({ name, status: 'failed', reason: e.message });
        await snapshot('failure-' + name);
        fs.writeFileSync(
          path.join(evidence, 'failure-' + name + '.json'),
          JSON.stringify(
            await ev(
              "({active:document.activeElement?.outerHTML,dialogs:[...document.querySelectorAll('[role=dialog]')].map(e=>e.outerHTML),toasts:[...document.querySelectorAll('[data-sonner-toast]')].map(e=>e.outerHTML)})",
            ),
            null,
            2,
          ),
        );
        console.log('FAIL ' + name + ': ' + e.message.slice(0, 400));
      } finally {
        console.log('DONE ' + name);
      }
    };
    await run('wechat-export', async () => {
      await navigate();
      await wait(
        "document.querySelectorAll('.content-article-row').length===20",
        '20 rows',
      );
      await ev(
        "window.linkEvents=[];document.addEventListener('click',e=>{const a=e.target.closest('.content-article-row a');if(a){window.linkEvents.push({href:a.getAttribute('href'),target:a.target,rel:a.rel,prevented:e.defaultPrevented});e.preventDefault();}})",
      );
      await click("document.querySelector('.content-article-row a')");
      await ev(
        "document.querySelectorAll('.content-article-row a')[1].focus()",
      );
      await key('Enter', 13);
      const links = await ev('window.linkEvents');
      assert.equal(links.length, 2);
      assert(
        links.every(
          (x) =>
            !x.prevented &&
            x.target === '_blank' &&
            x.rel.includes('noopener') &&
            x.href === withoutSnUrl,
        ),
      );
      assert.equal(apiReads.filter((r) => r.name === 'article.byId').length, 0);
      await click("document.querySelector('.compact-list-header label')");
      assert.equal(
        await ev(
          "document.querySelectorAll('.content-article-row input:checked').length",
        ),
        20,
      );
      await click(button('导出文章'));
      assert(
        await ev(
          "document.querySelector('.app-dialog').textContent.includes('选中文章（20 篇）')",
        ),
      );
      assert.equal(
        await ev("document.querySelector('select[aria-label=导出方式]').value"),
        'obsidian',
      );
      await modalMatrix('wechat-export');
    });
    await run('wechat-import', async () => {
      await navigate();
      await more();
      await click(button('导入已有文件'));
      await modalMatrix('wechat-import');
    });
    await run('wechat-import-long', async () => {
      scenario = 'import-long';
      await navigate();
      await more();
      await click(button('导入已有文件'));
      await wait("Boolean(document.querySelector('.app-dialog input'))", 'import input mounted');
      await click("document.querySelector('.app-dialog input')");
      await send('Input.insertText', { text: 'C:/synthetic-only' });
      await click(button('预览'));
      await key('Escape', 27);
      assert(
        await ev("Boolean(document.querySelector('.app-dialog'))"),
        'pending preview cannot dismiss',
      );
      await wait(
        "document.querySelector('.app-dialog')?.textContent.includes('合成预览文章')",
        'long preview',
      );
      await modalMatrix('wechat-import-long');
      scenario = 'normal';
    });
    await run('wechat-album', async () => {
      await navigate();
      await more();
      await click(button('官方合集订阅'));
      await modalMatrix('wechat-album');
    });
    await run('wechat-add', async () => {
      await navigate();
      await click(
        "document.querySelectorAll('.feed-sidebar > div:first-child button')[1]",
      );
      await modalMatrix('wechat-add');
    });
    await run('folder-create', async () => {
      await navigate();
      await click("document.querySelector('[aria-label=新建文件夹]')");
      await modalMatrix('folder-create');
    });
    await run('folder-rename', async () => {
      await navigate();
      await click(
        'document.querySelector(\'[aria-label="文件夹 合成文件夹 更多操作"]\')',
      );
      await click("document.querySelector('[data-key=rename]')");
      await modalMatrix('folder-rename');
    });
    await run('folder-members', async () => {
      await navigate();
      await click(
        'document.querySelector(\'[aria-label="文件夹 合成文件夹 更多操作"]\')',
      );
      await click("document.querySelector('[data-key=add]')");
      await modalMatrix('folder-members');
    });
    await run('wechat-repair', async () => {
      await navigate();
      await more();
      await click(button('修复本号来源'));
      await modalMatrix('wechat-repair');
    });
    for (const mode of ['create', 'rename'])
      await run('xhs-folder-' + mode, async () => {
        await navigate('/dash/xiaohongshu');
        if (mode === 'create')
          await click("document.querySelector('[aria-label=新建文件夹]')");
        else {
          await click(
            'document.querySelector(\'[aria-label="文件夹 合成文件夹 更多操作"]\')',
          );
          await click(
            "document.querySelector('[data-key=" +
              (mode === 'rename' ? 'rename' : 'add') +
              "]')",
          );
        }
        await modalMatrix('xhs-folder-' + mode);
      });
    cases.push({
      name: 'xhs-folder-members',
      status: 'not-reachable',
      note: 'f8412cb does not pass members to ManagementFolders; no add-member entry exists. Final task8 XHS branch needs its own review.',
    });
    await run('wechat-exceptions', async () => {
      scenario = 'exceptions';
      batchReads = 0;
      await navigate();
      await wait(
        "Boolean(document.querySelector('.app-dialog'))",
        'exception transition',
      );
      await click("document.querySelector('.app-dialog details summary')");
      await modalMatrix('wechat-exceptions');
      scenario = 'normal';
    });
    await run('wechat-account', async () => {
      await navigate('/dash/accounts');
      await click(button('添加微信账号'));
      await modalMatrix('wechat-account');
    });
    for (const state of ['account-wait', 'account-wait-qr', 'account-error'])
      await run(state, async () => {
        scenario = state;
        await navigate('/dash/accounts');
        await click(button('添加微信账号'));
        await modalMatrix(state);
        scenario = 'normal';
      });
    await run('xhs-data', async () => {
      await navigate('/dash/xiaohongshu');
      await wait(
        "Boolean(document.querySelector('[aria-label^=查看互动与评论]'))",
        'xhs data entry',
      );
      await click("document.querySelector('[aria-label^=查看互动与评论]')");
      await modalMatrix('xhs-data');
    });
    await run('xhs-export', async () => {
      await navigate('/dash/xiaohongshu');
      await more();
      await click(button('导出已保存 ZIP'));
      await modalMatrix('xhs-export');
    });
    await run('xhs-add', async () => {
      await navigate('/dash/xiaohongshu');
      await click(button('订阅'));
      await modalMatrix('xhs-add');
    });
    for (const route of ['/dash/feeds/fixture-one', '/dash/xiaohongshu']) {
      await run(
        (route.includes('xiaohongshu') ? 'xhs' : 'wechat') + '-popovers',
        async () => {
          await navigate(route);
          for (const [width, height] of [
            [2048, 956],
            [390, 600],
            [667, 320],
          ]) {
            await viewport(width, height);
            if (width < 800)
              await click(
                "document.querySelector('.feed-source-controls button[aria-controls]')",
              );
            await click("document.querySelector('[aria-label=分组帮助]')");
            const box = await ev(
              "(()=>{const e=[...document.querySelectorAll('[data-slot=content]')].find(e=>e.textContent.includes('拖动文件夹手柄')),r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight}})()",
            );
            assert(
              box.x >= 0 &&
                box.right <= box.w &&
                box.y >= 0 &&
                box.bottom <= box.h,
              JSON.stringify(box),
            );
            await dismiss();
            if (width < 800)
              await click(
                "document.querySelector('.feed-source-controls button[aria-controls]')",
              );
            await more();
            await snapshot(
              (route.includes('xiaohongshu') ? 'xhs' : 'wechat') +
                '-more-' +
                width,
            );
            await dismiss();
            cases.push({
              name: route + ' popovers',
              width,
              height,
              status: 'passed',
            });
          }
        },
      );
      await run(
        (route.includes('xiaohongshu') ? 'xhs' : 'wechat') + '-calendar',
        async () => {
          await navigate(route);
          await click("document.querySelector('.content-date-filter summary')");
          for (const [width, height, zoom = 1] of [
            [2048, 956],
            [390, 640],
            [790, 480],
            [790, 480, 2],
          ]) {
            await viewport(width, height, zoom);
            const trigger =
              "document.querySelector('.content-date-filter button[aria-label*=打开日历]')";
            await click(trigger);
            await wait(
              "Boolean(document.querySelector('[data-slot=content] [role=grid]'))",
              'calendar grid',
            );
            const g = await ev(
              "(()=>{const e=[...document.querySelectorAll('[data-slot=content]')].find(e=>e.querySelector('[role=grid]')&&getComputedStyle(e).overflowY==='auto');e.scrollTop=0;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight,scrollable:e.scrollHeight>e.clientHeight}})()",
            );
            assert(
              g.x >= 0 && g.right <= g.w + 1 && g.y >= 0 && g.bottom <= g.h + 1,
              JSON.stringify(g),
            );
            await snapshot(
              (route.includes('xiaohongshu') ? 'xhs' : 'wechat') +
                '-calendar-' +
                width +
                'x' +
                height,
            );
            await dismiss();
            assert(
              await ev(
                "document.activeElement?.getAttribute('aria-label')?.includes('打开日历')",
              ),
              'calendar focus restored',
            );
            cases.push({
              name: route + ' calendar',
              width,
              height,
              status: 'passed',
              geometry: g,
            });
          }
        },
      );
    }
    await run('native-confirm-cancel', async () => {
      await navigate();
      await click(
        'document.querySelector(\'[aria-label="文件夹 合成文件夹 更多操作"]\')',
      );
      const listener = async (e) => {
        const m = JSON.parse(e.data);
        if (m.method === 'Page.javascriptDialogOpening')
          await send('Page.handleJavaScriptDialog', { accept: false });
      };
      ws.addEventListener('message', listener);
      await click("document.querySelector('[data-key=delete]')");
      await pause(200);
      ws.removeEventListener('message', listener);
      assert.deepEqual(forbidden, []);
      cases.push({ name: 'native-confirm-cancel', status: 'passed' });
    });
    await run('notice-below-export', async () => {
      scenario = 'notice';
      await navigate();
      await click(button('查看处理说明'));
      await click(button('导出文章'));
      await modalMatrix('notice-below-export');
      scenario = 'normal';
    });
    await run('toast-with-import', async () => {
      scenario = 'import-error';
      await navigate();
      await more();
      await click(button('导入已有文件'));
      await wait("Boolean(document.querySelector('.app-dialog input'))", 'import input mounted');
      await click("document.querySelector('.app-dialog input')");
      await send('Input.insertText', { text: 'C:/synthetic-only' });
      await click(button('预览'));
      await wait(
        "Boolean(document.querySelector('[data-sonner-toast]'))",
        'synthetic error toast',
      );
      await modalMatrix('toast-with-import');
      scenario = 'normal';
    });
    await run('navigation-and-search-tooltips', async () => {
      await navigate();
      await send('Emulation.setFocusEmulationEnabled', { enabled: true });
      for (const selector of [
        '[aria-label=账号管理]',
        '[aria-label=返回公众号文章列表]',
        '.feed-reading-toolbar button[aria-label*=搜索]',
      ]) {
        const point = await ev(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: 2,
          y: 2,
        });
        await pause(100);
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          pointerType: 'mouse',
          ...point,
        });
        await pause(1300);
        await wait(
          "Boolean(document.querySelector('[role=tooltip]'))",
          'tooltip ' + selector,
        );
        const g = await ev(
          "(()=>{const e=document.querySelector('[role=tooltip]'),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight,text:e.textContent,hit:e===hit||e.contains(hit)}})()",
        );
        assert(
          g.x >= 0 && g.right <= g.w && g.y >= 0 && g.bottom <= g.h && g.hit,
          JSON.stringify(g),
        );
        cases.push({ name: selector, status: 'passed', geometry: g });
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: 2,
          y: 2,
        });
        await pause(300);
      }
    });
    await navigate('/dash/tools');
    for (const [width, height] of [
      [1440, 900],
      [390, 640],
      [790, 480],
    ]) {
      await viewport(width, height);
      assert(
        await ev("document.body.innerText.includes('下载')"),
        'routed tools rendered',
      );
      assert(
        await ev('document.documentElement.scrollWidth<=innerWidth+1'),
        'tools do not overflow',
      );
    }
    cases.push({
      name: 'tools',
      status: 'inspected',
      note: 'Tools render in-page controls; no application Dialog/Drawer/Sheet instances in routed tool sources.',
    });
    assert.deepEqual(forbidden, []);
    assert.equal(apiReads.filter((r) => r.name === 'article.byId').length, 0);
    fs.writeFileSync(
      path.join(evidence, 'result.json'),
      JSON.stringify(
        {
          cases,
          forbidden,
          bodyCalls: 0,
          apiReads,
          source: 'compiled Vite app with local synthetic HTTP API',
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        evidence,
        passed: cases.filter((x) => x.status === 'passed').length,
        failed: cases.filter((x) => x.status === 'failed').length,
      }),
    );
    if (cases.some((x) => x.status === 'failed')) process.exitCode = 1;
  } finally {
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
    ws?.close();
    child?.kill();
    child?.stderr?.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
