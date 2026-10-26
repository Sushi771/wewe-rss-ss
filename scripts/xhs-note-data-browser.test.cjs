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
  status: i < 2 ? 'complete' : i >= 252 ? 'video-skipped' : 'listed',
  publishTime: i === 2 ? 0 : 1791633600 - i * 86400,
  title:
    i === 2
      ? '合成笔记 2 ' + '用于窄窗验证的长标题'.repeat(8)
      : '合成笔记 ' + i,
  metrics: i === 1 || i === 2 ? snapshot : null,
}));
let slow = false;
function data(name, input) {
  apiReads.push({ name, input });
  switch (name) {
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
    case 'xiaohongshu.engagement':
      return input.noteId === noteKey(1) || input.noteId === noteKey(2)
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
    // Every catalog row keeps its original link, irrespective of archive state.
    for (let count = 20; count < 266; count += 20) {
      await click(
        `[...document.querySelectorAll('button')].find(e=>e.textContent.includes('加载更多'))`,
      );
    }
    await wait(
      'document.querySelectorAll(".content-article-row").length===266',
      '266 rows loaded',
    );
    const links = await ev(
      `[...document.querySelectorAll('.content-article-row a')].map(a=>({href:a.getAttribute('href'),target:a.target,rel:a.rel}))`,
    );
    assert.equal(links.length, 266);
    const expectedLinks = new Set(
      items.map(
        (note) =>
          'https://www.xiaohongshu.com/explore/' + JSON.parse(note.id)[2],
      ),
    );
    assert.equal(new Set(links.map((link) => link.href)).size, 266);
    links.forEach((link) => {
      assert(expectedLinks.has(link.href));
      assert.equal(link.target, '_blank');
      assert.equal(link.rel, 'noopener noreferrer');
    });
    assert.equal(await ev('document.querySelectorAll("iframe").length'), 0);
    checks.push({
      links: 266,
      bodyReads: apiReads.filter((x) => x.name === 'xiaohongshu.body').length,
    });
    for (const width of [320, 390, 768, 1024, 1440, 1580]) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await click(action(2));
      await wait(
        'document.body.innerText.includes("已保存评论 19 条")',
        '19 comments available for listed note',
      );
      const layout = await ev(
        `(()=>{const dialog=document.querySelector('[role=dialog]'),scroll=document.querySelector('.xhs-data-scroll'),doc=document.querySelector('.xhs-data-document'),close=document.querySelector('button[aria-label="关闭互动与评论"]'),r=close.getBoundingClientRect();return {width:innerWidth,docWidth:doc.getBoundingClientRect().width,dialogWidth:dialog.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth+1,scrolls:[...dialog.querySelectorAll('*')].filter(e=>getComputedStyle(e).overflowY==='auto'&&e.scrollHeight>e.clientHeight+1).length,closeVisible:r.top>=0&&r.bottom<=innerHeight,text:dialog.innerText};})()`,
      );
      assert(!layout.overflow, JSON.stringify(layout));
      assert(layout.docWidth <= 721);
      assert(layout.closeVisible);
      assert(layout.scrolls <= 1);
      assert.match(layout.text, /赞 0/);
      assert.match(layout.text, /分享 未知/);
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
    // Four combinations: both complete notes, and two directory-only notes.
    for (const i of [0, 1, 2, 3]) {
      await click(action(i));
      await wait(
        'document.querySelector("[role=dialog]")&&!document.body.innerText.includes("正在读取本地互动")',
        'local data complete',
      );
      const text = await ev(
        'document.querySelector("[role=dialog]").innerText',
      );
      assert.equal(text.includes('已保存评论 19 条'), i === 1 || i === 2);
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
    await click(action(1));
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
      'PASS 266 safe external links; 6 responsive widths; four combinations; delayed close/switch; zero body reads. EVIDENCE=' +
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
