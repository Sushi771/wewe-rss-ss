/* Native Node 24 CDP: no package install, no remote content, own browser only. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const phases = new Set([
  'input',
  'startup',
  'connect',
  'cdp',
  'decode',
  'remote-check',
]);
const codes = new Set([
  'ENOENT',
  'EBUSY',
  'EPERM',
  'EACCES',
  'ECONNREFUSED',
  'ECONNRESET',
  'BROWSER_EXITED',
  'STARTUP_EXHAUSTED',
  'INVALID_PORT_FILE',
  'CDP_TIMEOUT',
  'CDP_ERROR',
  'DECODE_FAILED',
  'REMOTE_RESOURCE_BLOCKED',
  'BROWSER_DEADLINE',
]);
let phase = 'input';
function failure(code) {
  return Object.assign(Error(code), { code });
}
function abortable(operation, signal) {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}
function diagnostic(error, currentPhase = phase) {
  const code = codes.has(error?.code)
    ? error.code
    : codes.has(error?.cause?.code)
      ? error.cause.code
      : 'UNCLASSIFIED';
  return {
    format: 'article-history-browser-error-v1',
    phase: phases.has(currentPhase) ? currentPhase : 'input',
    errorType: ['Error', 'TypeError', 'SyntaxError', 'RangeError'].includes(
      error?.name,
    )
      ? error.name
      : 'UnknownError',
    code,
    ...(codes.has(error?.resourceCode)
      ? { resourceCode: error.resourceCode }
      : {}),
    ...(Number.isInteger(error?.attempts)
      ? { attempts: Math.min(120, Math.max(0, error.attempts)) }
      : {}),
    ...(typeof error?.cleanup?.childExited === 'boolean' &&
    typeof error?.cleanup?.profileRemoved === 'boolean'
      ? {
          cleanup: {
            childExited: error.cleanup.childExited,
            profileRemoved: error.cleanup.profileRemoved,
          },
        }
      : {}),
  };
}

// Retry ONLY the owned browser's startup port-file availability, never a
// verification/approval, CDP error, malformed complete port, or decode result.
async function waitForDevToolsPort(
  file,
  child,
  {
    readFile = fs.readFileSync,
    sleep = pause,
    now = () => performance.now(),
    timeoutMs = 12000,
    maxAttempts = 120,
    spawnError = () => null,
    signal,
  } = {},
) {
  const until = now() + Math.min(timeoutMs, 12000);
  let resourceCode;
  let attempts = 0;
  while (attempts < Math.min(maxAttempts, 120) && now() < until) {
    if (signal?.aborted) throw signal.reason;
    if (spawnError()) throw spawnError();
    if (child.exitCode !== null || child.signalCode)
      throw failure('BROWSER_EXITED');
    attempts++;
    try {
      const raw = readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > 1024) throw failure('INVALID_PORT_FILE');
      const lines = raw.split('\n');
      if (
        (lines[0] &&
          (!/^\d{1,5}$/.test(lines[0]) ||
            Number(lines[0]) < 1 ||
            Number(lines[0]) > 65535)) ||
        lines.slice(2).some((line) => line.trim())
      )
        throw failure('INVALID_PORT_FILE');
      // Chrome can expose the file before either line has been fully written.
      if (
        lines.length >= 2 &&
        lines[1].trim() &&
        !'/devtools/browser/'.startsWith(lines[1].trim())
      ) {
        const port = Number(lines[0]);
        if (
          !/^\d{1,5}$/.test(lines[0]) ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535 ||
          !/^\/devtools\/browser\/[a-zA-Z0-9-]{1,128}$/.test(lines[1].trim())
        )
          throw failure('INVALID_PORT_FILE');
        if (child.exitCode !== null || child.signalCode)
          throw failure('BROWSER_EXITED');
        return port;
      }
      resourceCode = undefined; // incomplete file, not a complete invalid port
    } catch (error) {
      if (!['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) throw error;
      resourceCode = error.code;
    }
    await abortable(sleep(Math.min(100, Math.max(0, until - now()))), signal);
  }
  throw Object.assign(failure('STARTUP_EXHAUSTED'), { attempts, resourceCode });
}

async function main(signal) {
  const input = await abortable(
    (async () => {
      let value = '';
      for await (const chunk of process.stdin) value += chunk;
      return value;
    })(),
    signal,
  );
  const { root, pages } = JSON.parse(input);
  if (!Array.isArray(pages) || pages.length > 128) throw Error('page budget');
  const candidates = [
    process.env.ARTICLE_HISTORY_CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const cache = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  if (fs.existsSync(cache))
    for (const item of fs.readdirSync(cache)) {
      if (/^chromium-\d+$/.test(item))
        candidates.push(path.join(cache, item, 'chrome-win/chrome.exe'));
    }
  const executable = candidates.find((p) => p && fs.existsSync(p));
  if (!executable || typeof WebSocket === 'undefined')
    throw Error('Chrome/Edge and Node 24 required');
  let remoteRequests = 0;
  const allowed = new Set(pages);
  let server, profile, child, socket;
  const pending = new Map();
  try {
    server = http.createServer((req, res) => {
      const name = req.url.slice(1);
      if (name === 'favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (
        !allowed.has(name) &&
        !/^assets\/[0-9a-f]{64}\.(png|jpeg|gif|webp)$/.test(name)
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      const file = path.join(root, name);
      const ext = path.extname(file);
      const mime = {
        '.html': 'text/html; charset=utf-8',
        '.png': 'image/png',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      }[ext];
      if (!mime || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Security-Policy':
          "default-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    });
    await abortable(
      new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
      signal,
    );
    const origin = `http://127.0.0.1:${server.address().port}/`;
    profile = fs.mkdtempSync(
      path.join(os.tmpdir(), 'article-history-browser-'),
    );
    child = spawn(
      executable,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--proxy-server=http://127.0.0.1:9',
        '--proxy-bypass-list=127.0.0.1',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    phase = 'startup';
    let spawnError;
    child.on('error', (error) => {
      spawnError = error;
    });
    const active = path.join(profile, 'DevToolsActivePort');
    const port = await waitForDevToolsPort(active, child, {
      spawnError: () => spawnError,
      signal,
    });
    phase = 'connect';
    const target = await abortable(
      fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method: 'PUT',
        signal,
      }).then((r) => r.json()),
      signal,
    );
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await abortable(
      new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = reject;
      }),
      signal,
    );
    let id = 0;
    const command = (method, params = {}) =>
      abortable(
        new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          const key = ++id;
          const timer = setTimeout(() => {
            pending.delete(key);
            reject(failure('CDP_TIMEOUT'));
          }, 10000);
          pending.set(key, { resolve, reject, timer });
          socket.send(JSON.stringify({ id: key, method, params }));
        }),
        signal,
      );
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (event.id && pending.has(event.id)) {
        const waiter = pending.get(event.id);
        pending.delete(event.id);
        clearTimeout(waiter.timer);
        if (event.error) waiter.reject(failure('CDP_ERROR'));
        else waiter.resolve(event.result);
      }
      if (event.method === 'Fetch.requestPaused') {
        const { requestId, request } = event.params;
        const name = request.url.startsWith(origin)
          ? request.url.slice(origin.length)
          : null;
        const permitted =
          name !== null &&
          (name === 'favicon.ico' ||
            allowed.has(name) ||
            /^assets\/[0-9a-f]{64}\.(png|jpeg|gif|webp)$/.test(name));
        if (!permitted) remoteRequests++;
        command(
          permitted ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          permitted
            ? { requestId }
            : { requestId, errorReason: 'BlockedByClient' },
        ).catch(() => {});
      }
    };
    phase = 'cdp';
    await command('Page.enable');
    await command('Runtime.enable');
    await command('Emulation.setScriptExecutionDisabled', { value: true });
    await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    let images = 0;
    let imageInputs = 0;
    for (const name of pages) {
      phase = 'decode';
      await command('Page.navigate', { url: origin + name });
      let status;
      for (let i = 0; i < 100; i++) {
        const result = await command('Runtime.evaluate', {
          returnByValue: true,
          awaitPromise: true,
          expression: `(async()=>JSON.stringify({url:location.href,ready:document.readyState,title:document.title,images:Array.from(document.images,x=>({done:x.complete,ok:x.naturalWidth>0&&x.naturalHeight>0})),imageInputs:await Promise.all(Array.from(document.querySelectorAll('input[type="image" i]'),async x=>{const p=new Image();p.src=x.src;try{await p.decode()}catch{}return {done:p.complete,ok:p.naturalWidth>0&&p.naturalHeight>0}}))}))()`,
        });
        status = JSON.parse(result.result.value || '{}');
        if (
          status.url === origin + name &&
          status.ready === 'complete' &&
          status.images.every((x) => x.done) &&
          status.imageInputs.every((x) => x.done)
        )
          break;
        await abortable(pause(50), signal);
      }
      if (
        status.url !== origin + name ||
        status.ready !== 'complete' ||
        !status.title ||
        status.images.some((x) => !x.done || !x.ok) ||
        status.imageInputs.some((x) => !x.done || !x.ok)
      )
        throw failure('DECODE_FAILED');
      images += status.images.length;
      imageInputs += status.imageInputs.length;
    }
    phase = 'remote-check';
    if (remoteRequests) throw failure('REMOTE_RESOURCE_BLOCKED');
    process.stdout.write(
      JSON.stringify({
        pages: pages.length,
        images,
        imageInputs,
        decoded: true,
        remoteRequests,
      }),
    );
  } finally {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(signal?.reason || failure('CDP_ERROR'));
    }
    pending.clear();
    try {
      if (socket) socket.close();
    } catch {}
    // Only this helper's child/profile are owned here; never inspect/stop services.
    if (child) {
      try {
        child.kill();
      } catch {}
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) resolve();
        else {
          const exited = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', exited);
            resolve();
          }, 3000);
          child.once('exit', exited);
        }
      });
    }
    try {
      server?.closeAllConnections();
    } catch {}
    try {
      server?.close();
    } catch {}
    // Browser may release Windows handles late. A small private temp profile may
    // remain; never make a broad or cross-shell recursive cleanup attempt.
    let profileRemoved = !profile;
    try {
      if (profile) {
        let timer;
        try {
          profileRemoved = await Promise.race([
            fs.promises
              .rm(profile, {
                recursive: true,
                force: true,
                maxRetries: 2,
                retryDelay: 100,
              })
              .then(
                () => true,
                () => false,
              ),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(false), 2000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch {}
    if (signal?.aborted)
      signal.reason.cleanup = {
        childExited: !child || child.exitCode !== null || !!child.signalCode,
        profileRemoved,
      };
  }
}
if (require.main === module) {
  const controller = new AbortController();
  let emergency;
  let reported = false;
  const report = (error) => {
    if (!reported) {
      reported = true;
      process.stderr.write(JSON.stringify(diagnostic(error)));
    }
  };
  const deadline = setTimeout(() => {
    // Cancel owned waits so main enters finally, even if a CDP fetch ignores
    // AbortSignal. Reserve a separate, bounded cleanup grace before hard exit.
    controller.abort(failure('BROWSER_DEADLINE'));
    process.stdin.destroy?.();
    emergency = setTimeout(() => {
      report(controller.signal.reason);
      process.exit(1);
    }, 6000);
  }, 170000);
  main(controller.signal)
    .catch((error) => {
      report(error);
      process.exitCode = 1;
    })
    .finally(() => {
      clearTimeout(deadline);
      clearTimeout(emergency);
      // A cancelled injected/native operation can keep an external handle
      // alive. Exit only after finally attempted this helper's bounded cleanup.
      if (controller.signal.aborted) {
        report(controller.signal.reason);
        process.exit(1);
      }
    });
}
module.exports = { waitForDevToolsPort, diagnostic };
