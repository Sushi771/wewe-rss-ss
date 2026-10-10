'use strict';
// Actual component + installed Framer Motion in isolated, headless Chromium.
// Synthetic classification callbacks only; no application or upstream requests.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const web = path.join(root, 'apps/web');
const chrome =
  process.env.LAYOUT_TEST_BROWSER ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(fs.existsSync);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test(
  'real offline pointer/touch group drag, cancellation, keyboard menu, failure and persisted reload',
  { skip: !chrome, timeout: 120000 },
  async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-group-drag-'));
    const entry = path.join(temp, 'fixture.tsx');
    const modulePath = (p) => JSON.stringify(p.replaceAll('\\', '/'));
    fs.writeFileSync(
      entry,
      `
import React, {useState} from ${modulePath(path.join(web, 'node_modules/react/index.js'))};
import {createRoot} from ${modulePath(path.join(web, 'node_modules/react-dom/client.js'))};
import {NextUIProvider} from ${modulePath(path.join(web, 'node_modules/@nextui-org/react/dist/index.mjs'))};
import ManagementFolders from ${modulePath(path.join(web, 'src/components/ManagementFolders.tsx'))};
function App(){
 const [folders,setFolders]=useState(JSON.parse(localStorage.getItem('folders')||'null')||Array.from({length:30},(_,i)=>({id:'g'+i,name:i<2?'重名文件夹':'长名称空分组'+i})));
 const [busy,setBusy]=useState(false); const [filter,setFilter]=useState('all');
 window.fixture={folders,filter,calls:window.fixture?.calls||[], fail:window.fixture?.fail||false};
 return <div className="feed-sidebar" style={{width:300,height:350,overflow:'auto',position:'relative'}}><ManagementFolders folders={folders} filter={filter} selectedIds={[]} dragType="application/x-wewe-wechat" disabled={busy} onFilter={setFilter} onBusyChange={setBusy} onMove={async()=>{}} onSave={async()=>{}} onRemove={async()=>{}} onReorder={async(ids,expectedIds)=>{window.fixture.calls.push({ids,expectedIds});if(window.fixture.fail)throw Error('Synthetic save failed');const next=ids.map(id=>folders.find(f=>f.id===id));localStorage.setItem('folders',JSON.stringify(next));setFolders(next);}}/></div>
}
createRoot(document.getElementById('root')).render(<NextUIProvider><App/></NextUIProvider>);
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
    const html = path.join(temp, 'fixture.html');
    fs.writeFileSync(
      html,
      `<!doctype html><html><body><div id="root"></div><style>.folder-navigation-row{display:flex;align-items:center;height:36px}.folder-filter{flex:1;text-align:left}.folder-navigation{padding:8px}.folder-navigation-header{display:flex;justify-content:space-between}.min-w-0{min-width:0}.flex-1{flex:1}.flex{display:flex}.items-center{align-items:center}button{min-height:28px}</style><script src="bundle/fixture.js"></script></body></html>`,
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
      const point = async (id) =>
        evaluate(
          `(()=>{const r=document.querySelector('[data-sort-folder="${id}"] button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
      const drag = async (
        id,
        target,
        { touch = false, cancel = false, outside = false } = {},
      ) => {
        const a = await point(id),
          b = outside ? { x: 600, y: 400 } : await point(target);
        if (touch)
          await send('Emulation.setTouchEmulationEnabled', { enabled: true });
        const input = async (type, p) =>
          touch
            ? send('Input.dispatchTouchEvent', {
                type,
                touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y }],
              })
            : send('Input.dispatchMouseEvent', {
                type,
                x: p.x,
                y: p.y,
                button: 'left',
                buttons: type === 'mouseReleased' ? 0 : 1,
                clickCount: type === 'mousePressed' ? 1 : 0,
              });
        await input(touch ? 'touchStart' : 'mousePressed', a);
        for (let i = 1; i <= 8; i++) {
          await input(touch ? 'touchMove' : 'mouseMoved', {
            x: a.x + ((b.x - a.x) * i) / 8,
            y: a.y + ((b.y - a.y) * i) / 8,
          });
          await pause(20);
        }
        if (cancel)
          await evaluate(
            `document.querySelector('[data-sort-folder="${id}"] button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
          );
        await input(touch ? 'touchEnd' : 'mouseReleased', b);
        await pause(400);
      };
      await drag('g0', 'g1');
      assert.deepEqual(
        await evaluate('window.fixture.folders.slice(0,2).map(f=>f.id)'),
        ['g1', 'g0'],
      );
      assert.equal(await evaluate('window.fixture.calls.length'), 1);
      await send('Page.reload');
      await pause(100);
      await ready();
      assert.deepEqual(
        await evaluate('window.fixture.folders.slice(0,2).map(f=>f.id)'),
        ['g1', 'g0'],
      );
      await drag('g1', 'g0', { outside: true });
      assert.equal(await evaluate('window.fixture.calls.length'), 0);
      await drag('g1', 'g0', { cancel: true });
      assert.equal(await evaluate('window.fixture.calls.length'), 0);
      await evaluate('window.fixture.fail=true');
      await drag('g1', 'g0');
      assert.deepEqual(
        await evaluate('window.fixture.folders.slice(0,2).map(f=>f.id)'),
        ['g1', 'g0'],
      );
      assert.match(
        await evaluate('document.body.innerText'),
        /Synthetic save failed/,
      );
      await evaluate('window.fixture.fail=false');
      await drag('g1', 'g0', { touch: true });
      assert.deepEqual(
        await evaluate('window.fixture.folders.slice(0,2).map(f=>f.id)'),
        ['g0', 'g1'],
      );
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
      // Open the actual NextUI menu, then select down using its keyboard handling.
      await evaluate(
        `Array.from(document.querySelector('[data-sort-folder="g0"]').querySelectorAll('button')).at(-1).click()`,
      );
      await pause(200);
      await evaluate(
        `Array.from(document.querySelectorAll('[role="menuitem"]')).find(n=>n.textContent.includes('下移')).focus()`,
      );
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await pause(300);
      assert.deepEqual(
        await evaluate('window.fixture.folders.slice(0,2).map(f=>f.id)'),
        ['g1', 'g0'],
      );
      await evaluate(`document.querySelector('.feed-sidebar').scrollTop=800`);
      assert(
        await evaluate(
          `(()=>{const n=document.querySelector('.feed-sidebar');return n.scrollTop>0&&n.scrollHeight>n.clientHeight})()`,
        ),
      );
      assert.equal(
        await evaluate(
          `document.querySelectorAll('[data-sort-folder]').length`,
        ),
        30,
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
