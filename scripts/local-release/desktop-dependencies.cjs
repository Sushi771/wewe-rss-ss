// Desktop-only dependency gate. Never creates containers, reads secrets, or stops services.
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const pinFile = path.join(root, 'private-data/desktop-start/container.json');
const pipe = 'npipe:////./pipe/dockerDesktopLinuxEngine';
const messages = {
  DOCKER_NOT_INSTALLED:
    '未找到已安装的 Docker Desktop。请检查原安装，不要重新安装或迁移数据。',
  DOCKER_NOT_READY:
    'Docker 引擎未能在两分钟内就绪。请打开原 Docker Desktop 检查状态，再点图标。',
  CONTAINER_PIN_MISSING:
    '缺少既有容器身份记录。请由维护者恢复 private-data/desktop-start/container.json。',
  CONTAINER_MISMATCH:
    '既有 Wechat2RSS 容器身份、端口或数据挂载不符，已停止启动。请维护者检查；不要重建容器。',
  CONTAINER_UNAVAILABLE:
    '既有 Wechat2RSS 容器状态异常或无法读取。请检查 Docker Desktop，保留原容器和数据。',
  DEPENDENCY_PORT_BUSY:
    '18080 已被其他服务占用。未停止任何进程，请维护者核对端口。',
  CONTAINER_START_FAILED:
    '无法启动既有 Wechat2RSS 容器。请在 Docker Desktop 检查原实例。',
  DEPENDENCY_NOT_READY:
    'Wechat2RSS 首页在一分钟内未健康就绪。请检查原实例；不要删除 res.db 或更换许可实例。',
  LAUNCH_BUSY:
    '已有桌面启动任务未结束。请稍后再试；若任务已退出，按启动说明处理锁文件。',
  WEWE_START_FAILED:
    'WeWe-RSS 启动或版本/4000 端口核验失败。未停止其他服务，请维护者核对当前发布包及端口。',
  BROWSER_FAILED:
    '服务已就绪，但浏览器未能打开。请手动访问 http://127.0.0.1:4000/dash/tools/article-download。',
};
function failure(code) {
  const e = new Error(messages[code]);
  e.code = code;
  return e;
}
function safeFailure(error) {
  const code = Object.hasOwn(messages, error?.code)
    ? error.code
    : 'WEWE_START_FAILED';
  return { code, message: messages[code] };
}
function command(executable, args, timeout = 5000) {
  return new Promise((resolve, reject) =>
    execFile(
      executable,
      args,
      {
        windowsHide: true,
        timeout,
        maxBuffer: 256 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) =>
        error
          ? reject(failure('CONTAINER_UNAVAILABLE'))
          : resolve(stdout.trim()),
    ),
  );
}
async function discoverDocker() {
  const script = `$ErrorActionPreference='Stop'; $paths=@(); foreach($key in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Docker Desktop','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Docker Desktop')) { $p=Get-ItemProperty $key -ErrorAction SilentlyContinue; if($p.InstallLocation){$paths+=Join-Path $p.InstallLocation 'Docker Desktop.exe'} }; foreach($desktop in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'))) { $link=Join-Path $desktop 'Docker Desktop.lnk'; if(Test-Path -LiteralPath $link){$paths+=(New-Object -ComObject WScript.Shell).CreateShortcut($link).TargetPath} }; $c=Get-Command docker.exe -ErrorAction SilentlyContinue; if($c){$paths+=Join-Path (Split-Path (Split-Path (Split-Path $c.Source))) 'Docker Desktop.exe'}; $paths+=Join-Path $env:ProgramFiles 'Docker\\Docker\\Docker Desktop.exe'; foreach($exe in $paths){$cli=Join-Path (Split-Path $exe) 'resources\\bin\\docker.exe'; if((Test-Path -LiteralPath $exe -PathType Leaf) -and (Test-Path -LiteralPath $cli -PathType Leaf)){@{desktop=$exe;cli=$cli}|ConvertTo-Json -Compress;exit 0}};exit 1`;
  try {
    return JSON.parse(
      await command(
        path.join(
          process.env.SystemRoot,
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        10000,
      ),
    );
  } catch {
    throw failure('DOCKER_NOT_INSTALLED');
  }
}
function readPin() {
  try {
    const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
    if (
      !/^[a-f0-9]{64}$/.test(pin.id) ||
      !/^sha256:[a-f0-9]{64}$/.test(pin.image)
    )
      throw Error();
    return pin;
  } catch {
    throw failure('CONTAINER_PIN_MISSING');
  }
}
function validateContainer(c, pin, projectRoot = root) {
  const bindings = c.ports?.['8080/tcp'];
  const expected = path.resolve(projectRoot, '.wechat2rss-data');
  const mounts = (c.mounts || []).filter(
    (m) => m.Destination === '/wechat2rss',
  );
  if (
    c.id !== pin.id ||
    c.image !== pin.image ||
    c.name !== '/wewe-rss-ss-wechat2rss-1' ||
    c.project !== 'wewe-rss-ss' ||
    c.service !== 'wechat2rss' ||
    !Array.isArray(bindings) ||
    bindings.length !== 1 ||
    bindings[0].HostIp !== '127.0.0.1' ||
    bindings[0].HostPort !== '18080' ||
    mounts.length !== 1 ||
    mounts[0].Type !== 'bind' ||
    mounts[0].RW !== true ||
    path.resolve(mounts[0].Source).toLowerCase() !== expected.toLowerCase()
  )
    throw failure('CONTAINER_MISMATCH');
  if (
    c.state.Paused ||
    c.state.Dead ||
    c.state.Restarting ||
    !['running', 'exited', 'created'].includes(c.state.Status)
  )
    throw failure('CONTAINER_UNAVAILABLE');
  return c;
}
const projection =
  '{"id":{{json .Id}},"image":{{json .Image}},"name":{{json .Name}},"state":{{json .State}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}}}';
function realAdapter(installation) {
  // Ignore DOCKER_HOST/context overrides: this launcher only uses the existing local Linux engine.
  const docker = (args, timeout) =>
    command(installation.cli, ['--host', pipe, ...args], timeout);
  return {
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    engineReady: async (timeout) => {
      try {
        return (
          (await docker(['info', '--format', '{{.OSType}}'], timeout)) ===
          'linux'
        );
      } catch {
        return false;
      }
    },
    launchDesktop: () =>
      new Promise((resolve, reject) => {
        const child = spawn(installation.desktop, [], {
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
        });
        child.once('error', () => reject(failure('DOCKER_NOT_READY')));
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      }),
    desktopRunning: async () => {
      const ps = path.join(
        process.env.SystemRoot,
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      );
      return (
        (
          await command(
            ps,
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              "[bool](Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)",
            ],
            5000,
          )
        ).toLowerCase() === 'true'
      );
    },
    inspect: async (pin) => {
      // A missing/redirected persistent store must not silently become a fresh license instance.
      try {
        const directory = fs.lstatSync(path.join(root, '.wechat2rss-data'));
        const database = fs.lstatSync(
          path.join(root, '.wechat2rss-data/res.db'),
        );
        if (
          !directory.isDirectory() ||
          directory.isSymbolicLink() ||
          !database.isFile() ||
          database.isSymbolicLink() ||
          database.size === 0
        )
          throw Error();
      } catch {
        throw failure('CONTAINER_MISMATCH');
      }
      const ids = (
        await docker([
          'ps',
          '-aq',
          '--filter',
          'label=com.docker.compose.service=wechat2rss',
        ])
      )
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length !== 1 || !pin.id.startsWith(ids[0]))
        throw failure('CONTAINER_MISMATCH');
      return JSON.parse(
        await docker(['inspect', pin.id, '--format', projection]),
      );
    },
    portBusy: async () => {
      const ps = path.join(
        process.env.SystemRoot,
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      );
      const script = `. '${path.join(__dirname, 'tcp-listeners.ps1').replace(/'/g, "''")}'; [bool](@(Get-LocalTcpListener -Port 18080).Count)`;
      return (
        (
          await command(
            ps,
            [
              '-NoProfile',
              '-NonInteractive',
              '-EncodedCommand',
              Buffer.from(script, 'utf16le').toString('base64'),
            ],
            10000,
          )
        ).toLowerCase() === 'true'
      );
    },
    start: async (id) => {
      try {
        await docker(['start', id], 15000);
      } catch {
        throw failure('CONTAINER_START_FAILED');
      }
    },
    healthy: async (timeout) => {
      try {
        const r = await fetch('http://127.0.0.1:18080/', {
          redirect: 'manual',
          signal: AbortSignal.timeout(timeout),
        });
        const good =
          r.status === 200 &&
          /^text\/html\b/i.test(r.headers.get('content-type') || '');
        await r.body?.cancel();
        return good;
      } catch {
        return false;
      }
    },
  };
}
async function waitReady(a, check, limit, code) {
  const end = a.now() + limit;
  while (a.now() < end) {
    if (await check(Math.max(1, Math.min(3000, end - a.now())))) return;
    if (a.now() < end) await a.sleep(Math.min(1000, end - a.now()));
  }
  throw failure(code);
}
async function ensureDependencies(
  a,
  pin,
  { reuseOnly = false, projectRoot = root } = {},
) {
  if (!(await a.engineReady(3000))) {
    if (reuseOnly) throw failure('DOCKER_NOT_READY');
    if (!(await a.desktopRunning())) await a.launchDesktop();
    await waitReady(
      a,
      (timeout) => a.engineReady(timeout),
      120000,
      'DOCKER_NOT_READY',
    );
  }
  let c = validateContainer(await a.inspect(pin), pin, projectRoot);
  let started = false;
  if (!c.state.Running) {
    if (reuseOnly) throw failure('DEPENDENCY_NOT_READY');
    if (await a.portBusy()) throw failure('DEPENDENCY_PORT_BUSY');
    await a.start(pin.id);
    started = true;
  }
  await waitReady(
    a,
    (timeout) => a.healthy(timeout),
    reuseOnly ? 3000 : 60000,
    'DEPENDENCY_NOT_READY',
  );
  c = validateContainer(await a.inspect(pin), pin, projectRoot);
  if (!c.state.Running) throw failure('DEPENDENCY_NOT_READY');
  return { status: started ? 'started' : 'already-running' };
}
// Atomic desktop lock spans dependency startup, existing app startup and browser opening.
// Never reap a lock automatically: a crash is explicit recovery, not a PID reuse race.
async function withLaunchLock(
  file,
  action,
  {
    timeout = 210000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = {},
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const end = now() + timeout;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (now() >= end) throw failure('LAUNCH_BUSY');
      await sleep(Math.min(500, end - now()));
    }
  }
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    );
    return await action();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(file);
  }
}
module.exports = {
  discoverDocker,
  readPin,
  realAdapter,
  ensureDependencies,
  validateContainer,
  withLaunchLock,
  failure,
  safeFailure,
  pinFile,
};
