const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  { spawn } = require('node:child_process'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  base = path.join(root, 'apps/server/client'),
  evidence = fs.mkdtempSync(
    path.join(require('os').tmpdir(), 'wewe-xhs-combined-'),
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
          metrics: {values:{likes:i<2?null:i===2?0:i,collects:i%7,shares:i%9,comments:i%11},collectedAt:1,evidence:'source-only'},
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

    await send('Page.navigate',{url:origin+'/dash/xiaohongshu'});
    await wait("document.querySelectorAll('.content-article-row').length===20",'initial notes');

    await viewport(1440,900);
    const results=[];
    const button=text=>"[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==="+JSON.stringify(text)+")";
    const select=async(label,value)=>{await ev("(()=>{const e=document.querySelector('select[aria-label=\""+label+"\"]');e.value="+JSON.stringify(value)+";e.dispatchEvent(new Event('change',{bubbles:true}));})()");await pause(100);};
    const input=async(label,value)=>{await click("document.querySelector('input[aria-label=\""+label+"\"]')");await send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});if(value)await send('Input.insertText',{text:value});await pause(100);};
    const count=async expected=>{await wait("document.querySelector('.xhs-list-caption').textContent.includes('当前范围 "+expected+" 条目录')",'matched total '+expected);assert.equal(await ev("document.querySelectorAll('.content-article-row').length"),Math.min(expected,20));};
    await count(120);await click("document.querySelector('.xhs-combined-filter summary')");await click(button('添加条件'));
    assert(await ev("document.querySelector('.xhs-combined-filter [role=alert]').textContent.includes('非负数')"));
    await input('条件 1 数值','100');await count(20);
    await click(button('添加条件'));await select('条件 2 指标','collects');await select('条件 2 比较方式','<=');await input('条件 2 数值','2');await count(8);
    await click("document.querySelector('[role=columnheader] button[aria-label^=点赞排序]')");assert.equal(await ev("document.querySelector('.content-article-row [data-metric=likes]').textContent.trim()"),'119');
    await select('条件匹配方式','or');await count(64);assert.equal(await ev("document.querySelector('[role=columnheader] button[aria-label^=点赞排序]').closest('[role=columnheader]').getAttribute('aria-sort')"),'descending');
    results.push({name:'and-or-global-filter-before-sort',status:'passed'});
    await click("document.querySelector('button[aria-label=\"删除条件 2\"]')");await select('条件 1 比较方式','between');await input('条件 1 下限','0');await input('条件 1 上限','0');await count(1);assert.equal(await ev("document.querySelector('.content-article-row [data-metric=likes]').textContent.trim()"),'0');
    await input('条件 1 下限','-1');assert(await ev("document.querySelector('.xhs-combined-filter [role=alert]').textContent.includes('非负数')"));await count(0);
    await input('条件 1 下限','10');await input('条件 1 上限','2');assert(await ev("document.querySelector('.xhs-combined-filter [role=alert]').textContent.includes('下限不能大于上限')"));
    await click(button('清空条件'));await count(120);assert.equal(await ev("document.querySelector('select[aria-label=条件匹配方式]').value"),'and');
    results.push({name:'zero-unknown-invalid-range-clear',status:'passed'});
    await send('Emulation.setFocusEmulationEnabled',{enabled:true});await ev(button('添加条件')+'.focus()');await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await pause(100);assert.equal(await ev("document.querySelectorAll('.xhs-condition-row').length"),1);
    await input('条件 1 数值','100');await click(button('添加条件'));await select('条件 2 指标','collects');await select('条件 2 比较方式','<');await input('条件 2 数值','3');await count(8);
    for(const width of [320,390,768,1440,2048]){await viewport(width,900);const geometry=await ev("({overflow:document.documentElement.scrollWidth>innerWidth+1,inputs:[...document.querySelectorAll('.xhs-condition-row input,.xhs-condition-row select,.xhs-condition-row button')].map(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.x>=0&&r.right<=innerWidth})})");assert(!geometry.overflow&&geometry.inputs.every(Boolean),JSON.stringify(geometry));const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,'combined-'+width+'.png'),Buffer.from(shot.data,'base64'));results.push({name:'keyboard-and-layout',width,status:'passed',geometry});}
    await viewport(768,440);await click("document.querySelector('input[aria-label=\"条件 2 数值\"]')");results.push({name:'short-window-input-hit',status:'passed'});
    await viewport(390,900);await click("document.querySelector('.xhs-combined-filter summary')");assert.equal(await ev("document.querySelector('.xhs-combined-filter').open"),false);const compact=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,'combined-collapsed-390.png'),Buffer.from(compact.data,'base64'));results.push({name:'collapsed-mobile-results',status:'passed'});
    assert.equal(apiReads.filter(r=>/engagement|comments|prepareOriginalLink|refreshMetrics|resolveSubscription/.test(r.name)).length,0);assert.deepEqual(forbidden,[]);fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({results,forbidden,sourceCalls:0},null,2));console.log(JSON.stringify({evidence,passed:results.length,failed:0}));
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
