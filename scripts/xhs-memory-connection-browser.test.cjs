'use strict';
if (process.env.WEWE_MEMORY_UI_BROWSER_TEST !== '1') {
  console.log(
    'Skipped: set WEWE_MEMORY_UI_BROWSER_TEST=1 for the isolated synthetic browser test.',
  );
  process.exit(0);
}
// Fresh headless profile, synthetic fields, fake loopback API only.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http'),
  assert = require('node:assert/strict'),
  { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  web = path.join(root, 'apps/web');
const esbuild = require(
  require.resolve('esbuild', {
    paths: [path.dirname(require.resolve('vite', { paths: [web] }))],
  }),
);
const audit = path.resolve(
  process.env.WEWE_MEMORY_UI_EVIDENCE ||
    path.join(os.tmpdir(), 'xhs-memory-ui-' + Date.now()),
);
fs.mkdirSync(audit, { recursive: true });
let child, server, ws;
const requests = [];
let unexpected = 0;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import Component from ${JSON.stringify(path.join(web, 'src/components/XhsMemoryConnection.tsx'))};
 window.leaks=0;window.storageWrites=0;window.readRefresh=0;
 for(const name of ['log','info','warn','error']){const original=console[name];console[name]=(...args)=>{if(JSON.stringify(args).includes('synthetic-session')||JSON.stringify(args).includes('synthetic-a1'))window.leaks++;original(...args);};}
 const nativeStore=Storage.prototype.setItem;Storage.prototype.setItem=function(...args){window.storageWrites++;return nativeStore.apply(this,args);};
 createRoot(document.getElementById('root')).render(React.createElement(Component,{disabled:false,onConnected:async()=>{window.readRefresh++;}}));
 const wait=()=>new Promise(r=>setTimeout(r,30));const button=text=>Array.from(document.querySelectorAll('button')).find(x=>x.textContent.includes(text));
 window.runTest=async()=>{for(let n=0;n<100&&!button('连接本次会话');n++)await wait();button('连接本次会话').click();await wait();let fields=Array.from(document.querySelectorAll('input'));const masked=fields.length===2&&fields.every(x=>x.type==='password');fields[0].value='synthetic-a1';fields[1].value='synthetic-session';button('取消并清空').click();await wait();const cancelled=fields.every(x=>x.value==='');button('连接本次会话').click();await wait();fields=Array.from(document.querySelectorAll('input'));const reopenedEmpty=fields.every(x=>x.value==='');fields[0].value='synthetic-a1';fields[1].value='synthetic-session';const form=document.querySelector('form');form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));const immediateClear=fields.every(x=>x.value==='');for(let n=0;n<200&&!document.body.textContent.includes('原来源暂停记录仍保留');n++)await wait();const result={masked,cancelled,reopenedEmpty,immediateClear,blockedMessage:document.body.textContent.includes('尚不能采集'),readRefresh:window.readRefresh,leaks:window.leaks,storageWrites:window.storageWrites,echo:document.body.textContent.includes('synthetic-session')||document.body.textContent.includes('synthetic-a1')};button('连接本次会话').click();await wait();return result;};`;
  const build = await esbuild.build({
    stdin: { contents: entry, resolveDir: web, loader: 'jsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'synthetic-host',
        setup(b) {
          b.onResolve({ filter: /^@web\// }, (args) =>
            ['@web/utils/auth', '@web/utils/env'].includes(args.path)
              ? { path: args.path, namespace: 'synthetic' }
              : { path: path.join(web, 'src', args.path.slice(5)) + '.ts' },
          );
          b.onLoad({ filter: /.*/, namespace: 'synthetic' }, (args) => ({
            contents: args.path.endsWith('/auth')
              ? "export const getAuthCode=()=> 'synthetic-app-auth';"
              : 'export const privateOnlineMode=false;',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const js = build.outputFiles[0].contents;
  server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;max-width:760px;margin:48px auto;padding:24px}label,input{display:block;margin:10px 0}input{min-width:320px;padding:8px}button{padding:8px 12px;margin:6px}</style><h1>本机会话连接 · 隔离预览</h1><div id="root"></div><script src="/app.js"></script>',
      );
      return;
    }
    if (req.url === '/app.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(js);
      return;
    }
    if (
      req.url === '/trpc/xiaohongshu.connectSession' &&
      req.method === 'POST'
    ) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      assert.deepEqual(input, {
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
        persist: false,
      });
      assert.equal(req.headers.authorization, 'synthetic-app-auth');
      requests.push({ persist: input.persist, keys: Object.keys(input) });
      body = '';
      await pause(100);
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          result: {
            data: {
              connected: true,
              riskCode: 'XHS_SOURCE_AUTHENTICATION_BLOCKED',
            },
          },
        }),
      );
      return;
    }
    if (req.url !== '/favicon.ico') unexpected++;
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const profile = path.join(audit, 'synthetic-browser-profile');
  fs.mkdirSync(profile);
  const chrome =
    process.env.RESPONSIVE_TEST_BROWSER ||
    'C:/Program Files/Google/Chrome/Application/chrome.exe';
  child = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-extensions',
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let n = 0; n < 200 && !fs.existsSync(portFile); n++) await pause(50);
  assert(fs.existsSync(portFile), 'isolated browser did not start');
  const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const targets = await (
    await fetch('http://127.0.0.1:' + port + '/json/list')
  ).json();
  ws = new WebSocket(
    targets.find((x) => x.type === 'page').webSocketDebuggerUrl,
  );
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  let next = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const data = JSON.parse(e.data);
    if (data.id && pending.has(data.id)) {
      const pair = pending.get(data.id);
      pending.delete(data.id);
      data.error
        ? pair.reject(Error(data.error.message))
        : pair.resolve(data.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 740,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: origin });
  const evaluated = await send('Runtime.evaluate', {
    expression:
      '(async()=>{for(let n=0;n<200&&!window.runTest;n++)await new Promise(r=>setTimeout(r,50));return await window.runTest();})()',
    awaitPromise: true,
    returnByValue: true,
  });
  assert(
    !evaluated.exceptionDetails,
    JSON.stringify(evaluated.exceptionDetails),
  );
  const result = evaluated.result.value;
  assert.deepEqual(result, {
    masked: true,
    cancelled: true,
    reopenedEmpty: true,
    immediateClear: true,
    blockedMessage: true,
    readRefresh: 1,
    leaks: 0,
    storageWrites: 0,
    echo: false,
  });
  assert.equal(requests.length, 1);
  assert.equal(unexpected, 0);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(
    path.join(audit, 'memory-session-form.png'),
    Buffer.from(shot.data, 'base64'),
  );
  fs.writeFileSync(
    path.join(audit, 'RESULT.json'),
    JSON.stringify(
      {
        passed: true,
        ...result,
        connectRequests: requests.length,
        sourceRequests: 0,
        productionTouched: false,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      audit,
      connectRequests: 1,
      sourceRequests: 0,
      productionTouched: false,
    }),
  );
  await send('Browser.close').catch(() => {});
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    ws?.close();
    server?.close();
    if (child && child.exitCode === null) {
      await pause(500);
      if (child.exitCode === null) child.kill();
    }
  });
