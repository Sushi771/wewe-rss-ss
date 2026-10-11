'use strict';
// Actual date component and installed React/Tailwind in isolated, headless Chromium.
// Synthetic page state only; no application, database or upstream requests.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = process.env.DATE_SHORTCUTS_REPO || path.resolve(__dirname, '..');
const sourceRoot = process.env.DATE_SHORTCUTS_SOURCE || root;
const web = path.join(root, 'apps/web');
const chrome =
  process.env.LAYOUT_TEST_BROWSER ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find(fs.existsSync);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test(
  'real offline date dropdown, click-time Shanghai boundary, manual edit, clear and narrow layout',
  { skip: !chrome, timeout: 120000 },
  async () => {
    const temp = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wewe-date-shortcuts-browser-'),
    );
    const entry = path.join(temp, 'fixture.tsx');
    const modulePath = (p) => JSON.stringify(p.replaceAll('\\', '/'));
    fs.writeFileSync(
      entry,
      `
import React,{useState} from ${modulePath(path.join(web, 'node_modules/react/index.js'))};
import {createRoot} from ${modulePath(path.join(web, 'node_modules/react-dom/client.js'))};
import ArticleDateFilter from ${modulePath(path.join(sourceRoot, 'apps/web/src/components/ArticleDateFilter.tsx'))};
import {dateSelectionFilter} from ${modulePath(path.join(sourceRoot, 'apps/web/src/utils/article-date-selection.ts'))};
import ArticleReader from ${modulePath(path.join(sourceRoot, 'apps/web/src/components/ArticleReader.tsx'))};
import {markArticleText} from ${modulePath(path.join(sourceRoot, 'apps/web/src/utils/article-reader-find.ts'))};
import {Modal,ModalContent,ModalBody,NextUIProvider} from ${modulePath(require.resolve('@nextui-org/react', { paths: [web] }).replace(/index\.js$/, 'index.mjs'))};
window.markArticleText=markArticleText;
window.blobs={created:[],revoked:[]};
const create=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{const url=create(blob);window.blobs.created.push(url);return url;};
URL.revokeObjectURL=url=>{window.blobs.revoked.push(url);revoke(url);};
const OriginalDate=Date;
window.testNow='2026-10-10T15:59:59Z';
window.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:[window.testNow]));}};
function App(){
 const [dates,setDates]=useState({mode:'day',start:'',end:''});
 const [selected,setSelected]=useState(['old']);
 const [reading,setReading]=useState(false),[find,setFind]=useState(false),[id,setId]=useState(0);
 const other={mpId:'a',group:'g',search:'keyword',direction:'asc'};
 window.fixture={dates,selected,filter:{...other,...dateSelectionFilter(dates)}};
 return <NextUIProvider><ArticleDateFilter value={dates} onChange={next=>{setDates(next);setSelected([])}}/>
 <button id="open-reader" onClick={()=>setReading(true)}>Read</button>
 <Modal isOpen={reading} onClose={()=>{setFind(false);setReading(false)}} isKeyboardDismissDisabled={find}>
 <ModalContent><ModalBody><button id="switch-reader" onClick={()=>{setFind(false);setId(id+1)}}>Switch</button>
 <ArticleReader key={id} contentHtml={id?'<p>Other body</p>':'<p>needle .*[x] <b>needle</b></p><p style="margin-top:1500px">needle</p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><a href="/saved">saved link</a><script>window.readerUnsafe=true</script>'} findOpen={find} onFindOpenChange={setFind}/>
 </ModalBody></ModalContent></Modal></NextUIProvider>;
}
createRoot(document.getElementById('root')).render(<App/>);
`,
    );
    const { build } = await import(
      pathToFileURL(
        path.join(
          path.dirname(require.resolve('vite', { paths: [web] })),
          'dist/node/index.js',
        ),
      ).href
    );
    await build({
      root: web,
      configFile: false,
      define: { 'process.env.NODE_ENV': '"production"' },
      resolve: {
        alias: {
          react: path.join(web, 'node_modules/react'),
          '@web/utils/article-date-selection': path.join(
            sourceRoot,
            'apps/web/src/utils/article-date-selection.ts',
          ),
          'react/jsx-runtime': path.join(
            web,
            'node_modules/react/jsx-runtime.js',
          ),
        },
      },
      logLevel: 'error',
      esbuild: { jsx: 'automatic' },
      build: {
        outDir: path.join(temp, 'bundle'),
        emptyOutDir: true,
        rollupOptions: {
          onwarn(warning, warn) {
            if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
          },
        },
        lib: {
          entry,
          name: 'Fixture',
          formats: ['iife'],
          fileName: () => 'fixture.js',
        },
      },
    });
    const postcss = require(require.resolve('postcss', { paths: [web] }));
    const tailwind = require(require.resolve('tailwindcss', { paths: [web] }));
    const css = (
      await postcss([
        tailwind({
          content: [
            path.join(
              sourceRoot,
              'apps/web/src/components/ArticleDateFilter.tsx',
            ),
            path.join(sourceRoot, 'apps/web/src/components/ArticleReader.tsx'),
          ],
          corePlugins: { preflight: true },
        }),
      ]).process('@tailwind base;@tailwind utilities;', { from: undefined })
    ).css;
    const html = path.join(temp, 'fixture.html');
    fs.writeFileSync(
      html,
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><style>' +
        css +
        '</style><script src="bundle/fixture.js"></script>',
    );
    const server = http.createServer((req, res) => {
      if (req.url === '/bundle/fixture.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(fs.readFileSync(path.join(temp, 'bundle/fixture.js')));
      } else if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(fs.readFileSync(html));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
    const child = spawn(
      chrome,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--no-proxy-server',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--remote-debugging-port=0',
        `--user-data-dir=${path.join(temp, 'profile')}`,
        'about:blank',
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let browserError = '';
    child.stderr.on('data', (chunk) => {
      browserError += chunk;
    });
    child.on('error', (error) => {
      browserError += error.message;
    });
    let ws;
    try {
      const portFile = path.join(temp, 'profile/DevToolsActivePort');
      for (let i = 0; i < 100 && !fs.existsSync(portFile); i++)
        await pause(100);
      assert(
        fs.existsSync(portFile),
        `isolated browser started (exit=${child.exitCode}): ${browserError.slice(-1500)}`,
      );
      const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
      const tabs = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      const page = tabs.find(
        (tab) => tab.type === 'page' && tab.url === 'about:blank',
      );
      assert(page, 'isolated blank page is available');
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      let serial = 0;
      const pending = new Map();
      const runtimeErrors = [];
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.method === 'Runtime.exceptionThrown')
          runtimeErrors.push(m.params.exceptionDetails);
        if (m.id) {
          const p = pending.get(m.id);
          if (!p) return;
          pending.delete(m.id);
          m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
        }
      });
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++serial;
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        });
      const evaluate = async (expression) => {
        const result = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        assert(
          !result.exceptionDetails,
          JSON.stringify(result.exceptionDetails),
        );
        return result.result.value;
      };
      const ready = async () => {
        for (let i = 0; i < 100; i++) {
          if (await evaluate('Boolean(window.fixture)')) return;
          await pause(50);
        }
        throw Error(
          'fixture did not render: ' +
            JSON.stringify({
              runtimeErrors,
              page: await evaluate(
                '({url:location.href,html:document.documentElement.outerHTML.slice(0,1000)})',
              ),
            }),
        );
      };
      await send('Runtime.enable');
      await pause(1000);
      const navigation = await send('Page.navigate', { url: fixtureUrl });
      assert(
        !navigation.errorText,
        navigation.errorText +
          ': ' +
          JSON.stringify(
            await evaluate(
              '({url:location.href,html:document.documentElement.outerHTML.slice(0,500)})',
            ),
          ),
      );
      await ready();
      const change = async (value) => {
        await evaluate(
          `(()=>{const el=document.querySelector('select');el.value='${value}';el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
        await pause(80);
        return evaluate('window.fixture');
      };
      assert.equal(
        await evaluate("document.querySelectorAll('optgroup option').length"),
        3,
      );
      let r = await change('today');
      assert.deepEqual(r.dates, { mode: 'day', start: '2026-10-10', end: '' });
      assert.deepEqual(r.selected, []);
      await evaluate("window.testNow='2026-10-10T16:00:00Z'");
      r = await change('last7');
      assert.deepEqual(r.dates, {
        mode: 'range',
        start: '2026-10-05',
        end: '2026-10-11',
      });
      assert.deepEqual(r.filter, {
        mpId: 'a',
        group: 'g',
        search: 'keyword',
        direction: 'asc',
        dateStart: '2026-10-05',
        dateEnd: '2026-10-11',
      });
      assert.equal(
        await evaluate("document.querySelector('select').value"),
        'range',
      );
      assert.deepEqual(
        await evaluate(
          "Array.from(document.querySelectorAll('input[type=date]'),e=>e.value)",
        ),
        ['2026-10-05', '2026-10-11'],
      );
      r = await change('month');
      assert.deepEqual(r.dates, {
        mode: 'range',
        start: '2026-10-01',
        end: '2026-10-11',
      });
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      assert.equal(
        await evaluate('document.documentElement.scrollWidth<=390'),
        true,
      );
      assert.equal(
        await evaluate(
          "Array.from(document.querySelectorAll('select,input,button')).every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=390})",
        ),
        true,
      );
      await evaluate("document.querySelector('button').click()");
      await pause(80);
      r = await evaluate('window.fixture');
      assert.deepEqual(r.dates, { mode: 'range', start: '', end: '' });
      assert.deepEqual(r.filter, {
        mpId: 'a',
        group: 'g',
        search: 'keyword',
        direction: 'asc',
      });
      assert.equal(
        await evaluate("document.querySelector('button').disabled"),
        true,
      );
      await change('day');
      await evaluate(
        "(()=>{const el=document.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'2024-02-29');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()",
      );
      await pause(80);
      r = await evaluate('window.fixture');
      assert.deepEqual(r.filter, {
        mpId: 'a',
        group: 'g',
        search: 'keyword',
        direction: 'asc',
        dateStart: '2024-02-29',
        dateEnd: '2024-02-29',
      });
      assert.deepEqual(runtimeErrors, []);
      // Actual inert DOM helper, including root text and hostile literal input.
      assert.deepEqual(
        await evaluate(`(()=>{
          const mark=window.markArticleText;
          const source='root needle<p title="needle">跨<b>标签</b>😀 .*[x]</p><p>needle</p><script>needle</script><style>.needle{}</style><span hidden>needle</span><span aria-hidden="true">needle</span>';
          const result=mark(document,source,'needle','test');
          const template=document.createElement('template');template.innerHTML=result.html;
          return {count:result.ids.length,inline:mark(document,source,'跨标签','x').ids.length,emoji:mark(document,source,'😀','x').ids.length,literal:mark(document,source,'.*[x]','x').ids.length,limit:mark(document,'<p>'+'a'.repeat(5001)+'</p>','a','x').truncated,attribute:template.content.querySelector('p').getAttribute('title'),scriptMarks:template.content.querySelectorAll('script mark,style mark,[hidden] mark').length};
        })()`),
        {
          count: 2,
          inline: 1,
          emoji: 1,
          literal: 1,
          limit: true,
          attribute: 'needle',
          scriptMarks: 0,
        },
      );
      const click = async (selector) => {
        for (let i = 0; i < 50; i++) {
          if (
            await evaluate(
              `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
            )
          )
            break;
          await pause(50);
        }
        assert(
          await evaluate(
            `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
          ),
          selector +
            ': ' +
            JSON.stringify({
              errors: runtimeErrors,
              body: await evaluate('document.body.innerText.slice(0,600)'),
            }),
        );
        await evaluate(
          `document.querySelector(${JSON.stringify(selector)}).click()`,
        );
        await pause(180);
      };
      const type = async (value) => {
        await evaluate(
          `(()=>{const el=document.querySelector('[aria-label="查找正文关键词"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
        await pause(300);
      };
      const output = () =>
        evaluate("document.querySelector('output').textContent");
      const key = async (key, shiftKey = false) => {
        await evaluate(
          `document.querySelector('[aria-label="查找正文关键词"]').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},shiftKey:${shiftKey},bubbles:true}))`,
        );
        await pause(180);
      };
      await click('#open-reader');
      await click('[aria-expanded="false"]');
      await type('needle');
      assert.equal(await output(), '1 / 3');
      await key('Enter');
      assert.equal(await output(), '2 / 3');
      await key('Enter', true);
      assert.equal(await output(), '1 / 3');
      await click('[aria-label="上一处匹配"]');
      assert.equal(await output(), '3 / 3');
      await click('[aria-label="下一处匹配"]');
      assert.equal(await output(), '1 / 3');
      assert.deepEqual(
        await evaluate(`(async()=>{
        const frame=document.querySelector('iframe');
        const body=await (await fetch(frame.src.split('#')[0])).text();
        const template=document.createElement('template');template.innerHTML=body;
        return {sandbox:frame.getAttribute('sandbox'),opaque:frame.contentDocument===null,image:template.content.querySelector('img').getAttribute('src').startsWith('data:'),link:template.content.querySelector('a').getAttribute('href'),unsafe:Boolean(window.readerUnsafe),narrow:frame.getBoundingClientRect().width<=390};
      })()`),
        {
          sandbox: '',
          opaque: true,
          image: true,
          link: '/saved',
          unsafe: false,
          narrow: true,
        },
      );
      await type('.*[x]');
      assert.equal(await output(), '1 / 1');
      await type('absent');
      assert.equal(await output(), '0 处匹配');
      assert.equal(
        await evaluate(
          'document.querySelector(\'[aria-label="下一处匹配"]\').disabled',
        ),
        true,
      );
      await type('');
      assert.equal(await output(), '输入关键词');
      await key('Escape');
      assert.equal(
        await evaluate(
          'Boolean(document.querySelector(\'[role="dialog"]\')) && !document.querySelector(\'[aria-label="查找正文关键词"]\')',
        ),
        true,
      );
      await click('[aria-expanded="false"]');
      await type('needle');
      await click('#switch-reader');
      assert.equal(
        await evaluate(
          'Boolean(document.querySelector(\'[aria-label="查找正文关键词"]\'))',
        ),
        false,
      );
      await click('[aria-expanded="false"]');
      await type('needle');
      assert.equal(await output(), '0 处匹配');
      await key('Escape');
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await pause(450);
      assert.equal(
        await evaluate('Boolean(document.querySelector(\'[role="dialog"]\'))'),
        false,
      );
      assert.equal(
        await evaluate(
          'window.blobs.created.every(url=>window.blobs.revoked.includes(url))',
        ),
        true,
      );
      assert.deepEqual(runtimeErrors, []);
    } finally {
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
      ws?.close();
      child.kill();
      child.stderr.destroy();
      server.closeAllConnections();
      server.close();
    }
  },
);
