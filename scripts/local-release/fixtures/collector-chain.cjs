const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.argv[2] === 'driver') {
  process.stdout.write(
    execFileSync(process.execPath, [__filename, 'probe', String(process.pid)], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 ** 2,
    }),
  );
} else if (process.argv[2] === 'probe') {
  const executable = path.join(
    process.env.SystemRoot,
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    path.join(__dirname, 'collector-chain.ps1'),
    '-ProbePid',
    String(process.pid),
    '-ControllerPid',
    process.argv[3],
  ];
  const native = JSON.parse(
    execFileSync(executable, args, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 4 * 1024 ** 2,
    }).replace(/^\uFEFF/, ''),
  );
  const self = {
    pid: process.pid,
    executable: process.execPath,
    argv: [process.execPath, ...process.argv.slice(1)],
    collectorExecutable: executable,
    collectorArgv: [executable, ...args],
    consoleExecutable: path.join(
      process.env.SystemRoot,
      'System32/conhost.exe',
    ),
    consoleArgv: [
      '\\??\\' + path.join(process.env.SystemRoot, 'System32/conhost.exe'),
      '0x4',
    ],
  };
  const accepted = require('../windows-release-references.cjs').collectorChain(
    new Map(native.before.map((r) => [r.pid, r])),
    new Map(native.after.map((r) => [r.pid, r])),
    process.ppid,
    self,
  );
  process.stdout.write(JSON.stringify({ accepted, native, self }) + '\n');
} else throw Error('OWNED_FIXTURE_MODE');
