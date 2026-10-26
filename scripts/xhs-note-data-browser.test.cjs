// Isolated compiled-product acceptance. No backend, database or upstream requests.
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  { spawn } = require('node:child_process'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  base =
    process.env.XHS_DATA_TEST_CLIENT || path.join(root, 'apps/server/client');
// Evidence and the browser profile are always fresh synthetic test artifacts.
// Do not read or reuse a caller-selected evidence directory or browser profile.
const evidence = fs.mkdtempSync(
  path.join(require('node:os').tmpdir(), 'xhs-data-ui-'),
);
function resolveChromium(env = process.env) {
  const isFile = (file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  };
  if (env.RESPONSIVE_TEST_BROWSER) {
    assert(isFile(env.RESPONSIVE_TEST_BROWSER),
      'RESPONSIVE_TEST_BROWSER must identify an installed Chromium executable');
    return env.RESPONSIVE_TEST_BROWSER;
  }
  const names = process.platform === 'win32'
    ? ['chrome.exe', 'msedge.exe', 'chromium.exe']
    : ['google-chrome', 'chromium', 'chromium-browser', 'chrome'];
  for (const directory of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (isFile(candidate)) return candidate;
    }
  }
  assert.fail('Set RESPONSIVE_TEST_BROWSER or add Chromium to PATH');
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  apiReads = [],
  requests = [],
  forbidden = [];
const budgets = new Map();
const noteKey = (i) =>
  JSON.stringify([
    'xiaohongshu',
    'note',
    (i + 1).toString(16).padStart(24, '0'),
  ]);
const snapshot = {
  values: { likes: 0, collects: 12, shares: null, comments: 19 },
  collectedAt: 1760000000000,
  contract: 'synthetic',
  evidence: 'source-only',
};
const profile = { ...snapshot, values: { fans: 424242, following: null } };
const sampleSnapshot = {
  ...snapshot,
  values: { likes: 7, collects: 4, shares: 2, comments: 6 },
};
const comments = Array.from({ length: 19 }, (_, i) => ({
  id: 'comment-' + i,
  rootId: i === 0 || i === 10 ? null : i < 10 ? 'comment-0' : 'comment-10',
  parentId: i === 1 ? 'comment-0' : null,
  authorId: null,
  authorName: '合成评论者' + i,
  content:
    i === 0
      ? '<script>仅按文字展示</script> ' + '长评论'.repeat(100)
      : '合成评论内容 ' + i,
  likes: i === 0 ? 0 : null,
  publishedAt: null,
  collectedAt: 1760000000000,
}));
const empty = {
  metrics: null,
  creatorMetrics: profile,
  totalSaved: 0,
  returned: 0,
  offset: 0,
  windows: [],
  comments: [],
};
const engagement = {
  ...empty,
  metrics: snapshot,
  totalSaved: 19,
  returned: 19,
  comments,
  windows: [
    {
      scope: 'top',
      pages: 1,
      state: 'returned-end',
      collectedAt: 1760000000000,
      code: null,
      nextCursor: null,
    },
    {
      scope: 'root:comment-0',
      pages: 1,
      state: 'partial',
      collectedAt: 1760000000000,
      code: null,
      nextCursor: 'synthetic',
    },
  ],
};
const items = Array.from({ length: 266 }, (_, i) => ({
  id: noteKey(i),
  creatorId: 'creator-one',
  creatorName: '合成博主',
  kind: i >= 252 ? 'video' : 'image-text',
  status: i < 2 || i === 4 ? 'complete' : i >= 252 ? 'video-skipped' : 'listed',
  publishTime: i === 3 ? 0 : 1791633600 - i * 86400,
  title:
    i === 2
      ? '合成笔记 2 ' + '用于窄窗验证的长标题'.repeat(8)
      : '合成笔记 ' + i,
  metrics: i === 2 ? sampleSnapshot : i === 4 ? snapshot : null,
}));
let slow = false;
function data(name, input) {
  apiReads.push({ name, input });
  switch (name) {
    case 'xiaohongshu.sourceRequestBudget':
      return budgets.get(JSON.stringify(input)) ?? null;
    case 'xiaohongshu.list':
      return {
        items: [
          {
            id: 'creator-one',
            displayName: '合成博主',
            enabled: false,
            groupId: null,
            metrics: profile,
            _count: { notes: 266 },
          },
        ],
      };
    case 'xiaohongshu.notes':
      return { items, total: 266, queryVersion: 'f'.repeat(64) };
    case 'xiaohongshu.recentTasks':
      return {
        items:
          process.env.XHS_DATA_TEST_RECOVERY === '1'
            ? [
                {
                  taskId: 'history-fixture',
                  creatorId: 'creator-one',
                  kind: 'download',
                  state: 'completed',
                  total: 266,
                  completed: 2,
                  skipped: 14,
                  failed: 0,
                  remaining: 250,
                  resumable: false,
                },
              ]
            : [],
      };
    case 'xiaohongshu.engagement':
      return input.noteId === noteKey(2)
        ? { ...engagement, metrics: sampleSnapshot }
        : input.noteId === noteKey(4)
          ? engagement
          : empty;
    case 'xiaohongshu.capability':
      return {
        configured: false,
        canRefresh: false,
        canSubscribe: false,
        canCollectComments: false,
        canExport: true,
        message: '离线合成验收',
      };
    case 'xiaohongshu.connectionStatus':
      return {
        connected: false,
        canRestore: false,
        canConnect: false,
        message: '离线合成验收',
      };
    case 'collection.verificationStatus':
      return { notices: [] };
    case 'xiaohongshu.body':
      forbidden.push('body query');
      throw Error('BODY_QUERY_FORBIDDEN');
    default:
      return { items: [] };
  }
}
function renderHtml(file) {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\{\{#if acceptanceMode\}\}[\s\S]*?\{\{\/if\}\}/g, '')
    .replaceAll('{{ weweRssServerOriginUrl }}', '')
    .replaceAll('{{ enabledAuthCode }}', 'false')
    .replaceAll('{{ privateOnlineMode }}', 'false')
    .replaceAll('{{ acceptanceMode }}', 'false')
    .replaceAll('{{ iconUrl }}', 'data:,')
    .replace(
      '<head>',
      '<head><script>window.__WEWE_RSS_SERVER_ORIGIN_URL__=location.origin;window.__WEWE_RSS_ENABLED_AUTH_CODE__=false;</script>',
    );
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  requests.push({ method: req.method, path: u.pathname });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (
    req.method === 'POST' &&
    u.pathname === '/trpc/xiaohongshu.configureSourceRequestBudget'
  ) {
    let payload = '';
    req.on('data', (chunk) => (payload += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(payload),
        input = parsed[0] ?? parsed;
      apiReads.push({
        name: 'xiaohongshu.configureSourceRequestBudget',
        input,
      });
      const value = {
        budgetId: 'synthetic-budget',
        limit: input.totalLimit,
        used: 2,
        remaining: input.totalLimit - 2,
        nextAt: 0,
        intervalMs: input.intervalMs,
      };
      budgets.set(JSON.stringify(input.scope), value);
      const result = { result: { data: value } };
      res.end(
        JSON.stringify(u.searchParams.get('batch') === '1' ? [result] : result),
      );
    });
    return;
  }
  if (
    req.method === 'POST' &&
    u.pathname === '/trpc/xiaohongshu.prepareOriginalLink'
  ) {
    let payload = '';
    req.on('data', (chunk) => (payload += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(payload),
        input = parsed[0] ?? parsed;
      apiReads.push({ name: 'xiaohongshu.prepareOriginalLink', input });
      const batch = u.searchParams.get('batch') === '1';
      const result =
        input.noteId === noteKey(0)
          ? {
              error: {
                message: 'synthetic source failure',
                code: -32603,
                data: { code: 'FORBIDDEN', httpStatus: 403 },
              },
            }
          : {
              result: {
                data: {
                  state: 'ready',
                  url:
                    'https://www.xiaohongshu.com/explore/' +
                    JSON.parse(input.noteId)[2] +
                    (input.refreshContext ? '?xsec_token=synthetic-renewed&xsec_source=pc_share' : '?xsec_token=synthetic-private&xsec_source=pc_share'),
                },
              },
            };
      setTimeout(() => res.end(JSON.stringify(batch ? [result] : result)), 60);
    });
    return;
  }
  if (req.method !== 'GET') {
    forbidden.push(req.url);
    res.statusCode = 405;
    return res.end('{}');
  }
  if (u.pathname === '/startup-status')
    return res.end(JSON.stringify({ status: 'ready', message: '' }));
  if (u.pathname.startsWith('/trpc/')) {
    const names = u.pathname.slice(6).split(','),
      inputs = JSON.parse(u.searchParams.get('input') || '{}'),
      batch = u.searchParams.get('batch') === '1';
    const result = names.map((n, i) => ({
      result: { data: data(n, batch ? inputs[i] : inputs) },
    }));
    const first = batch ? inputs[0] : inputs;
    return setTimeout(
      () => res.end(JSON.stringify(batch ? result : result[0])),
      slow &&
        names.includes('xiaohongshu.engagement') &&
        first?.noteId === noteKey(0)
        ? 900
        : 0,
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
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
    file = path.join(
      base,
      fs.existsSync(path.join(base, 'index.html')) ? 'index.html' : 'index.hbs',
    );
  if (/\.html$|\.hbs$/.test(file)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(renderHtml(file));
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
(async () => {
  let child, ws;
  const checks = [];
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const profile = fs.mkdtempSync(path.join(evidence, 'profile-'));
    const chrome = resolveChromium();
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
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
    const tabs = await (
      await fetch('http://127.0.0.1:' + port + '/json/list', {
        signal: AbortSignal.timeout(5000),
      }).catch((e) => {
        throw Error(
          'CDP localhost read failed: ' +
            JSON.stringify(e.cause) +
            '; browser stderr: ' +
            errors.slice(-1500),
        );
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
          ';if(!e)return null;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
      );
      if (!r) {
        fs.writeFileSync(
          path.join(evidence, 'missing-target.json'),
          JSON.stringify(
            {
              expression,
              errors: runtimeErrors,
              url: await ev('location.href'),
              page: await ev('document.body.innerText'),
              rows: await ev(
                'document.querySelectorAll(".content-article-row").length',
              ),
            },
            null,
            2,
          ),
        );
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(
          path.join(evidence, 'missing-target.png'),
          Buffer.from(shot.data, 'base64'),
        );
      }
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
    const runtimeErrors = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') runtimeErrors.push(m.params);
    });
    await send('Runtime.enable');
    await send('Page.enable');

    await send('Page.navigate', { url: origin + '/dash/xiaohongshu' });
    await wait(
      'document.querySelectorAll(".content-article-row").length===20',
      '20 initial rows',
    );
    const action = (i) =>
      `[...document.querySelectorAll('.content-article-row button[data-note-id]')].find(e=>e.getAttribute('data-note-id')===${JSON.stringify(noteKey(i))})`;
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(
        path.join(evidence, name + '.png'),
        Buffer.from(r.data, 'base64'),
      );
    };
    if (process.env.XHS_DATA_TEST_RECOVERY === '1') {
      const disclosure =
        'document.querySelector(\'section[aria-label="最近笔记任务"] details\')';
      await wait(`Boolean(${disclosure})`, 'recent task history rendered');
      const opened = await ev(`${disclosure}.open`);
      fs.writeFileSync(
        path.join(evidence, 'recovery-default.json'),
        JSON.stringify({ opened }, null, 2),
      );
      await shot('recovery-entry');
      assert.equal(
        opened,
        false,
        'recent task history must be collapsed on entry',
      );
      await click(`${disclosure}.querySelector('summary')`);
      assert.equal(await ev(`${disclosure}.open`), true);
      await key('Escape', 27);
      assert.equal(await ev(`${disclosure}.open`), false);
      await send('Page.reload', { ignoreCache: true });
      await wait(`Boolean(${disclosure})`, 'recent task history after reload');
      assert.equal(await ev(`${disclosure}.open`), false);
      await wait(
        'document.querySelectorAll(".content-article-row").length===20',
        'rows after recovery reload',
      );
      if (process.env.XHS_DATA_TEST_RECOVERY_ONLY === '1') {
        console.log(
          'PASS actual compiled bundle: recent history collapsed on entry/reload; explicit open and Escape close.',
        );
        return;
      }
    }
    // Every catalog row can explicitly prepare its original link, regardless of archive state.
    for (let count = 20; count < 266; count += 20) {
      await click(
        `[...document.querySelectorAll('button')].find(e=>e.textContent.includes('加载更多'))`,
      );
    }
    await wait(
      'document.querySelectorAll(".content-article-row").length===266',
      '266 rows loaded',
    );
    assert.equal(
      apiReads.filter((x) => x.name === 'xiaohongshu.prepareOriginalLink')
        .length,
      0,
      'no link preparation on render',
    );
    const titles = await ev(
      `[...document.querySelectorAll('[data-original-note-id]')].map(e=>e.getAttribute('data-original-note-id'))`,
    );
    assert.equal(titles.length, 266);
    assert.equal(new Set(titles).size, 266);
    titles.forEach((key) => assert(items.some((note) => note.id === key)));
    for (const i of [2, 4]) {
      await click(
        `[...document.querySelectorAll('[data-original-note-id]')].find(e=>e.getAttribute('data-original-note-id')===${JSON.stringify(noteKey(i))})`,
      );
      await wait(
        `Boolean([...document.querySelectorAll('.content-article-row')].find(row=>row.querySelector('button[data-note-id]')?.getAttribute('data-note-id')===${JSON.stringify(noteKey(i))})?.querySelector('a[target="_blank"]'))`,
        'prepared link ready',
      );
    }
    const links = await ev(
      `[...document.querySelectorAll('.content-article-row a[target="_blank"]')].map(e=>({url:e.href,rel:e.rel,referrerPolicy:e.referrerPolicy}))`,
    );
    assert.equal(links.length, 2);
    for (const link of links) {
      assert(link.url.includes('xsec_token=synthetic-private'));
      assert.equal(link.rel, 'noopener noreferrer');
      assert.equal(link.referrerPolicy, 'no-referrer');
    }
    const beforeRenew = apiReads.filter(x=>x.name==='xiaohongshu.prepareOriginalLink').length;
    await click(`document.querySelector('.xhs-note-origin-refresh')`);
    await wait(`[...document.querySelectorAll('.xhs-note-title[href]')].some(e=>e.href.includes('synthetic-renewed'))`, 'explicit renewal settled');
    assert.equal(apiReads.filter(x=>x.name==='xiaohongshu.prepareOriginalLink').length,beforeRenew+1);
    assert.equal(apiReads.filter(x=>x.name==='xiaohongshu.prepareOriginalLink').at(-1).input.refreshContext,true);
    checks.push({explicitRenewal:true});
    await click(
      `[...document.querySelectorAll('[data-original-note-id]')].find(e=>e.getAttribute('data-original-note-id')===${JSON.stringify(noteKey(0))})`,
    );
    await wait(
      'Boolean(document.querySelector(".xhs-note-origin [role=alert]"))',
      'fixed prepare failure visible',
    );
    assert.equal(
      apiReads.filter((x) => x.name === 'xiaohongshu.prepareOriginalLink')
        .length,
      4,
    );
    assert.equal(await ev('document.querySelectorAll("iframe").length'), 0);
    checks.push({
      explicitPrepareTitles: 266,
      bodyReads: apiReads.filter((x) => x.name === 'xiaohongshu.body').length,
    });
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1580,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await ev(`document.querySelector('.feed-article-scroll').scrollTop=0`);
    const cellValues = (i) =>
      ev(
        `[...(${action(i)}).closest('.content-article-row').querySelectorAll('[data-metric]')].map(e=>e.textContent.trim())`,
      );
    assert.deepEqual(await cellValues(0), ['—', '—', '—', '—']);
    assert.deepEqual(await cellValues(2), ['7', '4', '2', '6']);
    const listGeometry = await ev(
      `(()=>{const row=document.querySelectorAll('.content-article-row')[1],list=document.querySelector('.feed-article-scroll');return {rowHeight:row.getBoundingClientRect().height,listTop:list.getBoundingClientRect().top,width:list.clientWidth,scrollWidth:list.scrollWidth}})()`,
    );
    assert(listGeometry.rowHeight <= 72, JSON.stringify(listGeometry));
    assert(listGeometry.listTop < 300, JSON.stringify(listGeometry));
    await shot('compact-list-1580');
    checks.push({
      listGeometry,
      visibleMetricSample: [7, 4, 2, 6],
      unknown: 'dash with uncollected label',
    });
    for (const width of [320, 390, 768, 1024, 1440, 1580, 2048]) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await shot('list-' + width);
      assert(
        await ev(
          `(()=>{const title=(${action(2)}).closest('.content-article-row').querySelector('.xhs-note-title'),hint=title.querySelector('.xhs-note-origin-hint'),a=title.getBoundingClientRect(),b=hint.getBoundingClientRect();return b.right<=a.right+1&&b.bottom<=a.bottom+1})()`,
        ),
        'long titles retain a visible prepare/open label',
      );
      assert(
        await ev(
          `(()=>{const list=document.querySelector('.feed-article-scroll');return list.scrollWidth<=list.clientWidth+1})()`,
        ),
        'list fits available width',
      );
      await click(action(2));
      await wait(
        'document.body.innerText.includes("已保存评论 19 条")',
        '19 comments available for listed note',
      );
      // The real theme animates the portal. Wait for the required final geometry
      // before measuring; keep the same bounds and centered-layout assertions.
      await wait(
        `(()=>{const e=document.querySelector('[role=dialog]');if(!e)return false;const r=e.getBoundingClientRect();return Math.abs(r.left+r.width/2-innerWidth/2)<3 && Math.abs(r.top+r.height/2-innerHeight/2)<3 && r.top>=23 && r.bottom<=innerHeight-23 && document.querySelector('.xhs-data-document').getBoundingClientRect().width<=721})()`,
        'data panel reached centered viewport geometry',
      );
      const layout = await ev(
        `(()=>{const dialog=document.querySelector('[role=dialog]'),scroll=document.querySelector('.xhs-data-scroll'),doc=document.querySelector('.xhs-data-document'),close=document.querySelector('button[aria-label="关闭互动与评论"]'),r=close.getBoundingClientRect();return {width:innerWidth,docWidth:doc.getBoundingClientRect().width,dialogWidth:dialog.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth+1,scrolls:[...dialog.querySelectorAll('*')].filter(e=>getComputedStyle(e).overflowY==='auto'&&e.scrollHeight>e.clientHeight+1).length,closeVisible:r.top>=0&&r.bottom<=innerHeight,text:dialog.innerText};})()`,
      );
      assert(!layout.overflow, JSON.stringify(layout));
      layout.dialogRect = await ev(
        `(()=>{const r=document.querySelector('[role=dialog]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewportHeight:innerHeight}})()`,
      );
      assert(
        await ev(
          `(()=>{const r=document.querySelector('[role=dialog]').getBoundingClientRect();return Math.abs(r.left+r.width/2-innerWidth/2)<3 && Math.abs(r.top+r.height/2-innerHeight/2)<3 && r.top>=23 && r.bottom<=innerHeight-23})()`,
        ),
        'data panel centered with viewport margins',
      );
      if (layout.docWidth > 721) await shot('failure-document-width-' + width);
      assert(layout.docWidth <= 721, JSON.stringify(layout));
      assert(layout.closeVisible);
      assert(layout.scrolls <= 1);
      assert.match(layout.text, /赞 7/);
      assert.match(layout.text, /分享 2/);
      assert.match(layout.text, /粉丝 424,242/);
      assert(!layout.text.includes('关注 未知'));
      assert(!layout.text.includes('未保存文字正文'));
      if (width === 390 || width === 1580) await shot('summary-' + width);
      await click(
        `[...document.querySelectorAll('.xhs-data-document summary')].find(e=>e.textContent.includes('已保存评论'))`,
      );
      assert.equal(
        await ev(
          'document.querySelectorAll(".xhs-data-document ol > li").length',
        ),
        19,
      );
      assert(
        await ev(
          'document.querySelector(".xhs-data-document").innerText.includes("精确回复对象 未知")',
        ),
      );
      await ev('document.querySelector(".xhs-data-scroll").scrollTop=10000');
      assert(
        await ev(
          `(()=>{const r=document.querySelector('button[aria-label="关闭互动与评论"]').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`,
        ),
      );
      await shot('data-' + width);
      checks.push(layout);
      await key('Escape', 27);
      await wait(
        '!document.querySelector("[role=dialog]")',
        'Escape closes data panel',
      );
    }
    await send('Emulation.setDeviceMetricsOverride', {
      width: 2048,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const columns = await ev(
      `(()=>{const head=document.querySelector('.xhs-note-head'),row=document.querySelectorAll('.content-article-row')[1],list=document.querySelector('.feed-article-scroll');const h=[...head.children].slice(3,7).map(e=>e.getBoundingClientRect().x),m=[...row.querySelectorAll('[data-metric]')].map(e=>e.getBoundingClientRect().x);return {h,m,rowHeight:row.getBoundingClientRect().height,listTop:list.getBoundingClientRect().top}})()`,
    );
    columns.h.forEach((x, i) =>
      assert(Math.abs(x - columns.m[i]) < 1, JSON.stringify(columns)),
    );
    assert(columns.rowHeight <= 80);
    assert(columns.listTop < 300);
    checks.push({ desktop2048: columns });
    await ev(
      `document.querySelector('.feed-content').style.maxWidth='650px';document.querySelector('.feed-article-scroll').scrollTop=0`,
    );
    assert(
      await ev(
        `getComputedStyle(document.querySelector('.xhs-note-head')).display==='none'`,
      ),
    );
    assert(
      await ev(
        `(()=>{const l=document.querySelector('.feed-article-scroll');return l.scrollWidth<=l.clientWidth+1})()`,
      ),
    );
    await shot('sidebar-constrained-2048');
    await ev(`document.querySelector('.feed-content').style.maxWidth=''`);
    // Four combinations: both complete notes, and two directory-only notes.
    for (const i of [0, 4, 2, 3]) {
      await click(action(i));
      await wait(
        'document.querySelector("[role=dialog]")&&!document.body.innerText.includes("正在读取本地互动")',
        'local data complete',
      );
      const text = await ev(
        'document.querySelector("[role=dialog]").innerText',
      );
      assert.equal(text.includes('已保存评论 19 条'), i === 4 || i === 2);
      await click(
        'document.querySelector(\'button[aria-label="关闭互动与评论"]\')',
      );
      await wait('!document.querySelector("[role=dialog]")', 'close');
    }
    // A delayed result from a closed note cannot replace the next note's data.
    slow = true;
    await send('Page.reload', { ignoreCache: true });
    await wait(
      'document.querySelectorAll(".content-article-row").length===20',
      'reset rows',
    );
    await click(action(0));
    await key('Escape', 27);
    await wait('!document.querySelector("[role=dialog]")', 'close pending');
    await click(action(4));
    await wait(
      'document.body.innerText.includes("已保存评论 19 条")',
      'second data',
    );
    await pause(1100);
    assert(
      await ev(
        'document.querySelector("[role=dialog]").innerText.includes("已保存评论 19 条")',
      ),
    );
    await key('Escape', 27);
    await wait(
      '!document.querySelector("[role=dialog]")',
      'final close animation settled',
    );
    await pause(100);
    assert.equal(
      await ev('document.querySelectorAll("[role=dialog]").length'),
      0,
    );
    assert.equal(
      apiReads.filter(
        (x) => x.name === 'xiaohongshu.configureSourceRequestBudget',
      ).length,
      0,
      'mount and title clicks never configure a budget',
    );
    await click(
      `[...document.querySelectorAll('summary')].find(e=>e.textContent.includes('来源与本机保存设置'))`,
    );
    await wait(
      `document.body.innerText.includes('共享来源请求额度 · 尚未配置')`,
      'stable creator budget read',
    );
    await click(`document.querySelector('.xhs-source-budget summary')`);
    await ev(
      `(()=>{const e=document.querySelector('input[aria-label="来源请求总额度"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'20');e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await click(
      `document.querySelector('.xhs-source-budget button[type=submit]')`,
    );
    await wait(
      `document.body.innerText.includes('剩余 18 次 / 总计 20 次')`,
      'explicit stable budget save',
    );
    const configCalls = apiReads.filter(
      (x) => x.name === 'xiaohongshu.configureSourceRequestBudget',
    );
    assert.equal(configCalls.length, 1);
    assert.deepEqual(configCalls[0].input, {
      scope: { purpose: 'resolution' },
      totalLimit: 20,
      intervalMs: 5000,
    });
    assert.equal(
      apiReads.filter((x) => x.name === 'xiaohongshu.prepareOriginalLink')
        .length,
      4,
      'saving never retries a source request',
    );
    await shot('source-budget-2048');
    await click(
      `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='订阅')`,
    );
    await wait(
      `document.querySelector('[role=dialog]')?.innerText.includes('剩余 18 次 / 总计 20 次')`,
      'subscription sees the same shared quota',
    );
    assert.equal(
      await ev(`document.querySelectorAll('.xhs-source-budget').length`),
      1,
      'only one shared allowance is shown',
    );
    assert.equal(
      apiReads.filter(
        (x) => x.name === 'xiaohongshu.configureSourceRequestBudget',
      ).length,
      1,
    );
    await shot('shared-budget-subscription');
    await key('Escape', 27);
    await wait(
      '!document.querySelector("[role=dialog]")',
      'subscription closes',
    );
    for (const call of apiReads.filter(
      (x) => x.name === 'xiaohongshu.prepareOriginalLink',
    ))
      assert.deepEqual(Object.keys(call.input), call.input.refreshContext ? ['noteId','refreshContext'] : ['noteId']);
    checks.push({ explicitBudgetSaves: 1, autoConfigure: 0 });
    assert.deepEqual(forbidden, []);
    assert.equal(
      apiReads.filter((x) => x.name === 'xiaohongshu.body').length,
      0,
    );
    fs.writeFileSync(
      path.join(evidence, 'result.json'),
      JSON.stringify({ checks, forbidden, apiReads, requests }, null, 2),
    );
    console.log(
      'PASS 266 explicit link entries; 7 responsive widths; four combinations; delayed close/switch; zero body reads. EVIDENCE=' +
        evidence,
    );
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
