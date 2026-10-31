const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  { spawn } = require('node:child_process'),
  assert = require('node:assert/strict');
const { waitForBrowser } = require('./browser-readiness.cjs');
const root = path.resolve(__dirname, '..'),
  base = path.join(root, 'apps/server/client'),
  evidence = fs.mkdtempSync(
    path.join(require('os').tmpdir(), 'wewe-responsive-test-'),
  );
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
  bodyCached: i % 2 === 0,
  bodyRetry: { allowed: false, reason: '离线演示' },
  feed: { mpName: '示例订阅', collectionChannel: 'wechat2rss' },
  metrics: null,
  sourceUrl:
    i === 2
      ? null
      : i === 3
        ? 'javascript:alert(1)'
        : 'https://mp.weixin.qq.com/s/synthetic-article-' + i,
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
    case 'feed.list':
      return { items: feeds };
    case 'feed.cacheRevision':
      return { revision: 'synthetic-stable' };
    case 'article.searchStatus':
      return { total: 120, uncached: 0, pending: 0 };
    case 'xiaohongshu.groups':
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
          status: 'complete',
          metrics: { values: { likes: 0, collects: null, shares: null, comments: null } },
        })),
      };
    case 'xiaohongshu.engagement':
      return engagement;
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
    let errors = '',
      spawnError = null;
    child.stderr.on('data', (x) => {
      errors = (errors + x).slice(-8192);
    });
    child.on('error', (error) => {
      spawnError = error.code || 'UNKNOWN';
    });
    const ready = await waitForBrowser({
      child,
      profile,
      stderr: () => errors,
      spawnError: () => spawnError,
    });
    console.info(
      JSON.stringify({
        event: 'responsive-browser-ready',
        ...ready.diagnostics,
      }),
    );
    ws = new WebSocket(ready.page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
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

    await send('Page.navigate',{url:origin+'/dash/xiaohongshu'});await wait('Boolean(document.querySelector(".content-article-row"))','rows');await click('document.querySelector(".xhs-combined-filter summary")');const add='[...document.querySelectorAll(".xhs-combined-filter button")].find(e=>e.textContent.includes("添加条件"))';await click(add);
    const fill=async()=>ev('(()=>{for(const e of document.querySelectorAll(".xhs-combined-filter input")){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"0");e.dispatchEvent(new Event("input",{bubbles:true}));}})()');await fill();await wait('Boolean(document.querySelector(".content-article-row"))','filtered rows');
    const results=[];for(const [width,height,zoom]of [[390,900,1.25],[320,900,1.25],[390,540,1.25],[390,540,1],[320,540,1.25],[390,480,1.25],[640,540,1.25],[768,540,1.25],[1024,540,1.25],[1440,540,1.25]]){await viewport(width,height,zoom);let g=await geometry();assert.equal(g.documentHeight,g.height,'single viewport '+JSON.stringify(g));assert(!g.overflow);assert(g.region.height>=79);await ev('document.querySelector(".feed-article-scroll").scrollIntoView({block:"nearest"})');const visibleList=await ev('(()=>{const r=document.querySelector(".feed-article-scroll").getBoundingClientRect();return Math.min(innerHeight,r.bottom)-Math.max(0,r.top)})()');assert(visibleList>=79,'list visible after pane scroll '+visibleList);const titleVisible=await ev('(()=>{const e=document.querySelector(".content-article-row [data-original-note-id]");e.focus();e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return h===e||e.contains(h)})()');assert(titleVisible,'article title reachable below sort header');results.push({name:'one-condition-bounded-layout',titleVisible,width,height,zoom,g,visibleList});}
    await viewport(390,540,1.25);for(let n=1;n<8;n++){await click(add);await fill();}assert.equal(await ev('document.querySelectorAll(".xhs-condition-row").length'),8);await wait('Boolean(document.querySelector(".content-article-row"))','eight-condition rows');
    const controls=await ev('(()=>{const root=document.querySelector(".xhs-combined-filter"),els=[...root.querySelectorAll("select,input,button")].filter(e=>!e.disabled);return els.map((e,index)=>({index,label:e.getAttribute("aria-label")||e.textContent.trim()}))})()');for(const c of controls){const hit=await ev('(()=>{const e=[...document.querySelectorAll(".xhs-combined-filter select,.xhs-combined-filter input,.xhs-combined-filter button")].filter(e=>!e.disabled)['+c.index+'];e.focus();e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {focused:document.activeElement===e,hit:e===hit||e.contains(hit),label:e.getAttribute("aria-label")||e.textContent.trim()}})()');assert(hit.focused&&hit.hit,JSON.stringify(hit));}
    await ev('document.querySelector(".xhs-combined-filter select").focus()');for(let n=0;n<12;n++){await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await pause(25);const hit=await ev('(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {inside:!!e.closest(".xhs-combined-filter"),hit:h===e||e.contains(h),label:e.getAttribute("aria-label")}})()');assert(hit.inside&&hit.hit,JSON.stringify(hit));}
    await ev('document.querySelector(".feed-article-scroll").scrollIntoView({block:"nearest"})');const g=await geometry();assert.equal(g.documentHeight,g.height);assert(g.region.height>=79);assert(!g.overflow);const bar=await ev('(()=>{const e=document.querySelector(".xhs-filter-bar");return {height:e.clientHeight,scroll:e.scrollHeight,top:e.scrollTop}})()');assert(bar.scroll>bar.height);const titleHit=await ev('(()=>{const e=document.querySelector(".content-article-row [data-original-note-id]");e.focus();e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {hit:h===e||e.contains(h),focused:document.activeElement===e,top:r.top,bottom:r.bottom,headerPosition:getComputedStyle(document.querySelector(".xhs-note-head")).position,documentHeight:document.documentElement.scrollHeight,height:innerHeight}})()');assert(titleHit.hit&&titleHit.focused&&titleHit.documentHeight===titleHit.height,JSON.stringify(titleHit));results.push({name:'short-window-title-visible-below-sort-header',titleHit});results.push({name:'eight-conditions-all-controls-and-tab-reachable',controls:controls.length,g,bar});const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,'eight-conditions-390-125.png'),Buffer.from(shot.data,'base64'));assert.deepEqual(forbidden,[]);fs.writeFileSync(path.join(evidence,'target-result.json'),JSON.stringify({results,sourceCalls:0,forbidden},null,2));console.log(JSON.stringify({evidence,passed:results.length,failed:0}));
  } finally {
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
    await pause(300);
    ws?.close();
    child?.kill();
    child?.stderr.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
