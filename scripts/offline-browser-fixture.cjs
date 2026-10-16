'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const web = path.resolve('apps/web');
const browser =
  process.env.LAYOUT_TEST_BROWSER ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find(fs.existsSync);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const modulePath = (p) => JSON.stringify(p.replaceAll('\\', '/'));
async function withFixture(source, run, aliases = {}, options = {}) {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'wewe-classification-ui-'),
  );
  const entry = path.join(temp, 'fixture.tsx');
  fs.writeFileSync(entry, source);
  let productionPostcss;
  if (options.productionStyles) {
    const configPath = path.join(web, 'tailwind.config.ts');
    const tailwindEntry = require.resolve('tailwindcss', { paths: [web] });
    const jiti = require(
      require.resolve('jiti', { paths: [path.dirname(tailwindEntry)] }),
    )(__filename);
    const loaded = jiti(configPath);
    const config = loaded.default || loaded;
    const reactEntry = require.resolve('@nextui-org/react', { paths: [web] });
    const theme = path.dirname(
      require.resolve('@nextui-org/theme', {
        paths: [path.dirname(reactEntry)],
      }),
    );
    productionPostcss = {
      plugins: [
        require(require.resolve('tailwindcss', { paths: [web] }))({
          ...config,
          content: [
            ...config.content.map((pattern) => path.resolve(web, pattern)),
            path.join(theme, '**/*.{js,ts,jsx,tsx}'),
          ],
        }),
        require(require.resolve('autoprefixer', { paths: [web] }))(),
      ],
    };
  }
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
    define: { 'process.env.NODE_ENV': '"development"' },
    resolve: {
      alias: {
        react: path.join(web, 'node_modules/react'),
        'react-dom': path.join(web, 'node_modules/react-dom'),
        '@tanstack/react-query': path.join(
          web,
          'node_modules/@tanstack/react-query',
        ),
        ...aliases,
      },
    },
    logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    css: productionPostcss ? { postcss: productionPostcss } : undefined,
    build: {
      outDir: path.join(temp, 'bundle'),
      emptyOutDir: true,
      minify: false,
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
  const server = http.createServer((req, res) => {
    if (options.handleRequest?.(req, res)) return;
    if (req.url === '/fixture.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(fs.readFileSync(path.join(temp, 'bundle/fixture.js')));
    } else if (req.url === '/fixture.css' && options.productionStyles) {
      const cssFile = fs
        .readdirSync(path.join(temp, 'bundle'))
        .find((name) => name.endsWith('.css'));
      res.setHeader('Content-Type', 'text/css');
      res.end(fs.readFileSync(path.join(temp, 'bundle', cssFile)));
    } else if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        `<!doctype html><html><head>${options.productionStyles ? '<link rel="stylesheet" href="/fixture.css">' : ''}</head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      );
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(
    browser,
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
  let stderr = '',
    ws,
    phase = 'startup',
    lastMethod;
  const started = performance.now();
  let exited = false;
  const exit = new Promise((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
    child.once('error', () => {
      // Only a failed spawn has no process to wait for. A later operation
      // error (for example kill failure) is not proof that this child exited.
      if (child.pid === undefined) {
        exited = true;
        resolve();
      }
    });
  });
  const waitForExit = async (milliseconds) => {
    let timer;
    try {
      await Promise.race([
        exit,
        new Promise((resolve) => (timer = setTimeout(resolve, milliseconds))),
      ]);
      return exited;
    } finally {
      clearTimeout(timer);
    }
  };
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.on('error', (error) => {
    stderr += error.message;
  });
  try {
    const portFile = path.join(temp, 'profile/DevToolsActivePort');
    for (let i = 0; i < 100 && !exited && !fs.existsSync(portFile); i++)
      await pause(100);
    assert(
      fs.existsSync(portFile),
      `isolated browser unavailable: ${stderr.slice(-1000)}`,
    );
    phase = 'connect';
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const tabs = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    ws = new WebSocket(
      tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl,
    );
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    let serial = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data);
      if (!m.id) return;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error
        ? p.reject(Error(`CDP ${p.method}: ${m.error.message}`))
        : p.resolve(m.result);
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error(`CDP timeout: ${method}`));
        }, 10000);
        lastMethod = method;
        pending.set(id, { resolve, reject, timer, method });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    phase = 'initial-navigation';
    await send('Page.navigate', {
      url: `http://127.0.0.1:${server.address().port}/`,
    });
    phase = 'fixture-render';
    for (
      let i = 0;
      i < 100 && !(await evaluate('Boolean(window.fixture)'));
      i++
    )
      await pause(50);
    assert(await evaluate('Boolean(window.fixture)'), 'fixture renders');
    phase = 'test';
    await run({ evaluate, send, pause });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'classification-browser-failure',
        phase,
        lastMethod,
        elapsedMs: Math.round(performance.now() - started),
        browserExited: exited,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        stderr,
      }),
    );
    throw error;
  } finally {
    try {
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
      ws?.close();
      if (!(await waitForExit(2000))) {
        child.kill();
        assert(
          await waitForExit(5000),
          'owned fixture browser exit unconfirmed',
        );
      }
    } finally {
      child.stderr.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}
module.exports = { browser, withFixture, web, modulePath };
