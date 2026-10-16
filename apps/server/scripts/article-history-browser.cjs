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
const cdpMethods = new Set([
  'Page.enable',
  'Runtime.enable',
  'Emulation.setScriptExecutionDisabled',
  'Fetch.enable',
  'Page.navigate',
  'Runtime.evaluate',
  'Fetch.continueRequest',
  'Fetch.failRequest',
]);
const traceEvents = new Set([
  'input',
  'server-ready',
  'spawn',
  'port-poll',
  'http-start',
  'http-ready',
  'socket-start',
  'socket-ready',
  'cdp-send',
  'cdp-reply',
  'cdp-timeout',
  'page-start',
  'cleanup-start',
  'child-exit',
  'cleanup-end',
  'stderr-listening',
  'stderr-error',
]);

/** Synthetic CI only. Persist classifications, never raw stderr or CDP data. */
function createBrowserTrace({
  enabled = false,
  directory,
  now = () => performance.now(),
} = {}) {
  const empty = {
    enabled: false,
    record() {},
    stderr() {},
    finish() {},
    child() {
      return {};
    },
  };
  if (!enabled || !directory || !path.isAbsolute(directory)) return empty;
  const start = now();
  let saved = false,
    dropped = 0,
    bytes = 0,
    head = Buffer.alloc(0),
    tail = Buffer.alloc(0),
    listening = false;
  const events = [];
  const record = (event, data = {}) => {
    if (!traceEvents.has(event)) return;
    const row = {
      event,
      milliseconds: Math.max(0, Math.min(180000, Math.round(now() - start))),
    };
    for (const key of [
      'attempt',
      'bytes',
      'pid',
      'exitCode',
      'httpStatus',
      'pageIndex',
      'freeMemoryBytes',
      'cpuUserTicks',
      'cpuSystemTicks',
      'rssPages',
      'threads',
    ])
      if (Number.isSafeInteger(data[key]) && data[key] >= 0)
        row[key] = data[key];
    for (const key of ['exited', 'profileRemoved'])
      if (typeof data[key] === 'boolean') row[key] = data[key];
    if (cdpMethods.has(data.method)) row.method = data.method;
    if (codes.has(data.code)) row.code = data.code;
    if (
      [
        'absent',
        'busy',
        'denied',
        'incomplete',
        'valid',
        'rejected',
        'exhausted',
      ].includes(data.portState)
    )
      row.portState = data.portState;
    if (
      ['R', 'S', 'D', 'Z', 'T', 'W', 'X', 'I', 'P'].includes(data.processState)
    )
      row.processState = data.processState;
    if (
      ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL'].includes(
        data.signal,
      )
    )
      row.signal = data.signal;
    if (events.length === 128) {
      events.splice(32, 1);
      dropped++;
    }
    events.push(row);
  };
  return {
    enabled: true,
    record,
    child(child) {
      const result = {
        exited: !!child && (child.exitCode !== null || !!child.signalCode),
        freeMemoryBytes: Math.floor(os.freemem()),
      };
      if (!child) return result;
      result.pid = child.pid;
      result.exitCode = child.exitCode;
      result.signal = child.signalCode;
      // Only this spawned child's bounded /proc stat, not a process scan.
      if (process.platform === 'linux' && Number.isSafeInteger(child.pid)) {
        try {
          const raw = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
          if (raw.length < 4096) {
            const values = raw
              .slice(raw.lastIndexOf(')') + 2)
              .trim()
              .split(/\s+/);
            Object.assign(result, {
              processState: values[0],
              cpuUserTicks: Number(values[11]),
              cpuSystemTicks: Number(values[12]),
              threads: Number(values[17]),
              rssPages: Number(values[21]),
            });
          }
        } catch {}
      }
      return result;
    },
    stderr(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + value.length);
      if (head.length < 8192)
        head = Buffer.concat([head, value.subarray(0, 8192 - head.length)]);
      tail = Buffer.concat([tail, value.subarray(-8192)]).subarray(-8192);
      if (
        !listening &&
        /DevTools listening on/i.test(head.toString() + tail.toString())
      ) {
        listening = true;
        record('stderr-listening');
      }
    },
    finish(outcome, error) {
      if (saved) return;
      saved = true;
      const text = head.toString() + '\n' + tail.toString();
      const classifications = [
        ['DEVTOOLS_LISTENING', /DevTools listening on/i],
        ['PROFILE_LOCK', /ProcessSingleton|SingletonLock|profile.*in use/i],
        [
          'SANDBOX',
          /No usable sandbox|Running as root without --no-sandbox|sandbox.*failed/i,
        ],
        ['MISSING_LIBRARY', /error while loading shared libraries/i],
        ['DISPLAY', /Missing X server|\$DISPLAY|cannot open display/i],
        [
          'RESOURCE_LIMIT',
          /Resource temporarily unavailable|pthread_create|Cannot allocate memory|Out of memory|No space left on device/i,
        ],
        ['PERMISSION', /Permission denied|Access is denied/i],
        ['BIND', /Address already in use|bind\(\).*failed/i],
        ['DBUS', /dbus|D-Bus/i],
        ['CRASHPAD', /crashpad/i],
        ['GPU', /gpu.*(?:error|failed)|GPU process exited/i],
        ['FATAL', /\bFATAL\b/i],
      ]
        .filter(([, pattern]) => pattern.test(text))
        .map(([name]) => name);
      const summary = {
        format: 'article-history-synthetic-diagnostic-v1',
        outcome: outcome === 'success' ? 'success' : 'failure',
        events,
        droppedEvents: dropped,
        stderr: {
          bytesObserved: bytes,
          sampledBytes: Math.min(bytes, 16384),
          truncated: bytes > 16384,
          classifications,
        },
        ...(error ? { failure: diagnostic(error) } : {}),
      };
      try {
        fs.mkdirSync(directory, { recursive: true });
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return;
        if (fs.readdirSync(directory).length >= 64) return;
        const encoded = JSON.stringify(summary);
        if (Buffer.byteLength(encoded) > 32768) return;
        fs.writeFileSync(
          path.join(directory, `browser-${process.pid}-${Date.now()}.json`),
          encoded,
          { flag: 'wx', mode: 0o600 },
        );
      } catch {} // Diagnostics must never change the validation outcome.
    },
  };
}
let trace;
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
    observe = () => {},
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
        observe({
          attempt: attempts,
          bytes: Buffer.byteLength(raw),
          portState: 'valid',
        });
        return port;
      }
      observe({
        attempt: attempts,
        bytes: Buffer.byteLength(raw),
        portState: 'incomplete',
      });
      resourceCode = undefined; // incomplete file, not a complete invalid port
    } catch (error) {
      observe({
        attempt: attempts,
        code: error.code,
        portState:
          error.code === 'ENOENT'
            ? 'absent'
            : error.code === 'EBUSY'
              ? 'busy'
              : error.code === 'EPERM'
                ? 'denied'
                : 'rejected',
      });
      if (!['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) throw error;
      resourceCode = error.code;
    }
    await abortable(sleep(Math.min(100, Math.max(0, until - now()))), signal);
  }
  observe({ attempt: attempts, code: resourceCode, portState: 'exhausted' });
  throw Object.assign(failure('STARTUP_EXHAUSTED'), { attempts, resourceCode });
}

async function main(signal) {
  const directory = process.env.ARTICLE_HISTORY_DIAGNOSTICS_DIR;
  trace = createBrowserTrace({
    enabled:
      process.env.GITHUB_ACTIONS === 'true' &&
      process.env.ARTICLE_HISTORY_SYNTHETIC_DIAGNOSTICS === '1' &&
      !!process.env.RUNNER_TEMP &&
      !!directory &&
      path.resolve(directory) ===
        path.resolve(process.env.RUNNER_TEMP, 'article-history-diagnostics'),
    directory,
  });
  trace.record('input');
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
    trace.record('server-ready');
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
      {
        windowsHide: true,
        stdio: trace.enabled ? ['ignore', 'ignore', 'pipe'] : 'ignore',
      },
    );
    trace.record('spawn', trace.child(child));
    if (trace.enabled) {
      child.stderr?.on('data', (chunk) => trace.stderr(chunk));
      child.stderr?.on('error', (error) =>
        trace.record('stderr-error', { code: error.code }),
      );
      child.on('exit', () => trace.record('child-exit', trace.child(child)));
    }
    phase = 'startup';
    let spawnError;
    child.on('error', (error) => {
      spawnError = error;
    });
    const active = path.join(profile, 'DevToolsActivePort');
    const port = await waitForDevToolsPort(active, child, {
      spawnError: () => spawnError,
      signal,
      observe: trace.enabled
        ? (value) => trace.record('port-poll', value)
        : undefined,
    });
    phase = 'connect';
    trace.record('http-start', trace.child(child));
    const target = await abortable(
      fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method: 'PUT',
        signal,
      }).then((r) => {
        trace.record('http-ready', { httpStatus: r.status });
        return r.json();
      }),
      signal,
    );
    socket = new WebSocket(target.webSocketDebuggerUrl);
    trace.record('socket-start');
    await abortable(
      new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = reject;
      }),
      signal,
    );
    trace.record('socket-ready');
    let id = 0;
    const command = (method, params = {}) =>
      abortable(
        new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          const key = ++id;
          trace.record('cdp-send', { method });
          const timer = setTimeout(() => {
            pending.delete(key);
            trace.record('cdp-timeout', { method, ...trace.child(child) });
            reject(failure('CDP_TIMEOUT'));
          }, 10000);
          pending.set(key, { resolve, reject, timer, method });
          socket.send(JSON.stringify({ id: key, method, params }));
        }),
        signal,
      );
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (event.id && pending.has(event.id)) {
        const waiter = pending.get(event.id);
        trace.record('cdp-reply', { method: waiter.method });
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
      trace.record('page-start', { pageIndex: pages.indexOf(name) });
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
    trace.record('cleanup-start', trace.child(child));
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
      // Descendants can inherit this pipe. Diagnostics must not keep a
      // completed helper alive after the owned root's cleanup wait.
      if (trace.enabled) child.stderr?.destroy();
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
    trace.record('cleanup-end', { ...trace.child(child), profileRemoved });
  }
}
if (require.main === module) {
  const controller = new AbortController();
  let emergency;
  let reported = false;
  const report = (error) => {
    if (!reported) {
      reported = true;
      trace?.finish('failure', error);
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
    .then(() => {
      if (!controller.signal.aborted) trace?.finish('success');
    })
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
module.exports = { waitForDevToolsPort, diagnostic, createBrowserTrace };
