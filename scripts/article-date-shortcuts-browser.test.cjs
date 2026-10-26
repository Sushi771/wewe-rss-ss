'use strict';
// Actual date component and installed React/Tailwind in isolated, headless Chromium.
// Synthetic page state only; no application, database or upstream requests.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { waitForBrowser } = require('./browser-readiness.cjs');
const root = process.env.DATE_SHORTCUTS_REPO || path.resolve(__dirname, '..');
const sourceRoot = process.env.DATE_SHORTCUTS_SOURCE || root;
const web = path.join(root, 'apps/web');
const chrome =
  process.env.LAYOUT_TEST_BROWSER ||
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
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test(
  'real offline calendar pointer/touch selection, Shanghai shortcuts, Escape, narrow layout',
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
import {NextUIProvider} from ${modulePath(require.resolve('@nextui-org/react', { paths: [web] }).replace(/index\.js$/, 'index.mjs'))};
const OriginalDate=Date;
window.testNow='2026-10-10T15:59:59Z';
window.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:[window.testNow]));}};
window.restoreRealDate=()=>window.Date=OriginalDate;
function App(){
 const [dates,setDates]=useState({mode:'day',start:'',end:''});
 const [selected,setSelected]=useState(['old']);
 const other={mpId:'a',group:'g',search:'keyword',direction:'asc'};
 window.fixture={dates,selected,filter:{...other,...dateSelectionFilter(dates)}};
 return <NextUIProvider><ArticleDateFilter value={dates} onChange={next=>{setDates(next);setSelected([])}}/>
<div style={{height:1400}}>Offline scroll fixture</div></NextUIProvider>;
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
      envFile: false,
      define: { 'process.env.NODE_ENV': '"production"' },
      resolve: {
        alias: {
          '@web': path.join(sourceRoot, 'apps/web/src'),
          react: path.join(web, 'node_modules/react'),
          '@web/utils/article-date-selection': path.join(
            sourceRoot,
            'apps/web/src/utils/article-date-selection.ts',
          ),
          '@nextui-org/react': require
            .resolve('@nextui-org/react', { paths: [web] })
            .replace(/index\.js$/, 'index.mjs'),
          '@internationalized/date': require.resolve(
            '@internationalized/date',
            { paths: [require.resolve('@nextui-org/react', { paths: [web] })] },
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
            path.join(
              path.dirname(
                require.resolve('@nextui-org/theme', {
                  paths: [
                    require.resolve('@nextui-org/react', { paths: [web] }),
                  ],
                }),
              ),
              '**/*.{js,mjs}',
            ),
          ],
          corePlugins: { preflight: true },
          plugins: [
            require(
              require.resolve('@nextui-org/theme', {
                paths: [require.resolve('@nextui-org/react', { paths: [web] })],
              }),
            ).nextui(),
          ],
        }),
      ]).process('@tailwind base;@tailwind components;@tailwind utilities;', {
        from: undefined,
      })
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
    let browserVersion = 'not-probed-on-Windows';
    let sharedMemoryAvailableBytes = null;
    if (process.platform === 'linux') {
      try {
        browserVersion = execFileSync(chrome, ['--version'], {
          encoding: 'utf8',
          timeout: 3000,
        }).trim();
      } catch {
        browserVersion = 'version-probe-failed';
      }
      try {
        const disk = fs.statfsSync('/dev/shm');
        sharedMemoryAvailableBytes = disk.bavail * disk.bsize;
      } catch {
        /* Diagnose as unknown rather than changing browser flags. */
      }
    }
    console.info(
      JSON.stringify({
        event: 'isolated-browser-start',
        platform: process.platform,
        nodeVersion: process.version,
        browser: path.basename(chrome),
        browserVersion,
        freeMemoryBytes: os.freemem(),
        sharedMemoryAvailableBytes,
      }),
    );
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
      browserError = (browserError + chunk).slice(-8192);
    });
    child.on('error', (error) => {
      browserError += error.message;
    });
    let ws;
    try {
      const startupReady = await waitForBrowser({
        child,
        profile: path.join(temp, 'profile'),
        stderr: () => browserError,
      });
      console.info(
        JSON.stringify({
          event: 'isolated-browser-ready',
          ...startupReady.diagnostics,
        }),
      );
      const page = startupReady.page;
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
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(Error('DevTools timeout: ' + method));
          }, 10000);
          pending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
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
      await evaluate(
        "document.querySelector('.content-date-filter').open=true",
      );
      const calendarClick = async (selector, touch = false) => {
        const p = await evaluate(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
        );
        if (touch) {
          await send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [p],
          });
          await send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
          });
        } else {
          await send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            button: 'left',
            clickCount: 1,
            ...p,
          });
          await send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button: 'left',
            clickCount: 1,
            ...p,
          });
        }
        await pause(350);
      };
      const escape = async () => {
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
        await pause(350);
      };
      const change = async (value) => {
        await evaluate(
          `(()=>{const el=document.querySelector('select');el.value='${value}';el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
        await pause(100);
        return evaluate('window.fixture');
      };
      const open = (end = false, touch = false) =>
        calendarClick(
          `button[aria-label^="${end ? '结束日期' : '原文发布日期'}"]`,
          touch,
        );
      const day = (label, touch = false) =>
        calendarClick(`[role="button"][aria-label="${label}"]`, touch);
      assert.equal(
        await evaluate("document.querySelectorAll('input[type=date]').length"),
        0,
      );
      let r = await change('today');
      assert.equal(r.dates.start, '2026-10-10');
      await evaluate("window.testNow='2026-10-10T16:00:00Z'");
      r = await change('last7');
      assert.deepEqual(r.dates, {
        mode: 'range',
        start: '2026-10-05',
        end: '2026-10-11',
        shortcut: 'last7',
      });
      r = await change('month');
      assert.deepEqual(r.dates, {
        mode: 'range',
        start: '2026-10-01',
        end: '2026-10-11',
        shortcut: 'month',
      });
      await change('day');
      await evaluate('window.restoreRealDate()');
      await open();
      assert.match(await evaluate('document.body.innerText'), /2026年10月/);
      assert.match(
        await evaluate('document.body.innerText'),
        /一\s+二\s+三\s+四\s+五\s+六\s+日/,
      );
      // Use actual pointer hit testing; never fill a date or inject its change event.
      await calendarClick('button[data-slot="prev-button"]');
      assert.match(await evaluate('document.body.innerText'), /2026年9月/);
      await calendarClick('button[data-slot="next-button"]');
      assert.match(await evaluate('document.body.innerText'), /2026年10月/);
      const labels = await evaluate(
        'Array.from(document.querySelectorAll("[role=button][aria-label]"),e=>e.getAttribute("aria-label"))',
      );
      const first = labels.find(
        (v) => v.includes('2026') && v.includes('10月') && v.includes('15'),
      );
      assert(first, JSON.stringify(labels));
      await day(first);
      r = await evaluate('window.fixture');
      assert.equal(r.dates.start, '2026-10-15');
      assert.equal(r.dates.shortcut, undefined);
      assert.equal(r.filter.dateEnd, '2026-10-15');
      assert.deepEqual(r.selected, []);
      await open();
      await escape();
      assert.equal(
        await evaluate('document.querySelectorAll("[role=dialog]").length'),
        0,
      );
      assert.equal(await evaluate('window.fixture.dates.start'), '2026-10-15');
      assert.equal(await evaluate('location.href'), fixtureUrl);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await change('range');
      const clearSelector = 'button:not([aria-label])';
      await calendarClick(clearSelector, true);
      assert.deepEqual(await evaluate('window.fixture.dates'), {
        mode: 'range',
        start: '',
        end: '',
      });
      await calendarClick('button[aria-label^="开始日期"]', true);
      await calendarClick('button[data-slot="prev-button"]', true);
      const september = await evaluate(
        'Array.from(document.querySelectorAll("[role=button][aria-label]"),e=>e.getAttribute("aria-label")).find(v=>v.includes("2026")&&v.includes("9月")&&v.includes("30"))',
      );
      await day(september, true);
      assert.deepEqual(await evaluate('window.fixture.dates'), {
        mode: 'range',
        start: '2026-09-30',
        end: '',
      });
      assert.equal(await evaluate('window.fixture.filter.dateEnd'), undefined);
      await open(true, true);
      assert.match(await evaluate('document.body.innerText'), /2026年9月/);
      await calendarClick('button[data-slot="next-button"]', true);
      const october = await evaluate(
        'Array.from(document.querySelectorAll("[role=button][aria-label]"),e=>e.getAttribute("aria-label")).find(v=>v.includes("2026")&&v.includes("10月")&&v.includes("2日"))',
      );
      await day(october, true);
      assert.deepEqual(await evaluate('window.fixture.dates'), {
        mode: 'range',
        start: '2026-09-30',
        end: '2026-10-02',
      });
      await open(true, true);
      const geometry = await evaluate(
        `(()=>{const e=document.querySelector('[role=dialog]'),r=e.getBoundingClientRect();const cell=e.querySelector('[role=button][aria-label]');const c=cell.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,hit:e.contains(document.elementFromPoint(c.x+c.width/2,c.y+c.height/2)),width:document.documentElement.scrollWidth};})()`,
      );
      assert(
        geometry.left >= 0 &&
          geometry.right <= 390 &&
          geometry.top >= 0 &&
          geometry.bottom <= 844,
        JSON.stringify(geometry),
      );
      assert(geometry.hit, 'calendar cells remain above page content');
      assert(geometry.width <= 390, 'no horizontal overflow');
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(
        path.join(temp, 'calendar-390.png'),
        Buffer.from(shot.data, 'base64'),
      );
      await escape();
      await evaluate('window.scrollTo(0,700)');
      await pause(100);
      assert(
        await evaluate('window.scrollY>0'),
        'page scroll works after dismissal',
      );
      await evaluate('window.scrollTo(0,0)');
      await calendarClick(clearSelector, true);
      assert.deepEqual(await evaluate('window.fixture.dates'), {
        mode: 'range',
        start: '',
        end: '',
      });
      assert.deepEqual(runtimeErrors, []);
      console.log(
        'private calendar screenshot:',
        path.join(temp, 'calendar-390.png'),
      );
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
