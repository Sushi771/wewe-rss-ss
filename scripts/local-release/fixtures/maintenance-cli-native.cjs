// Preload only for the owned synthetic CLI test. Never queries Windows.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const input = process.env.WEWE_OWNED_NATIVE;
assert(input && fs.realpathSync.native(input).includes('wewe-publish-pair-'));
const native = JSON.parse(fs.readFileSync(input));
let calls = 0;
for (const method of [
  'exec',
  'execFile',
  'execSync',
  'spawn',
  'spawnSync',
  'fork',
])
  cp[method] = () => {
    throw Error('OWNED_UNEXPECTED_NATIVE_CALL');
  };
cp.execFileSync = (exe, args, options) => {
  assert.equal(++calls, 1);
  assert.equal(
    exe,
    path.join(
      process.env.SystemRoot,
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
  );
  assert.deepEqual(args, [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    path.join(
      path.dirname(process.argv[1]),
      'windows-release-reference-collector.ps1',
    ),
    '-PolicyFile',
    fs.realpathSync.native(process.argv[2]),
  ]);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 20000);
  const quote = (s) => '"' + s + '"';
  const rows = [
    {
      pid: process.pid,
      parentPid: process.ppid,
      name: 'node.exe',
      executable: process.execPath,
      commandLine: [process.execPath, process.argv[1], process.argv[2]]
        .map(quote)
        .join(' '),
      startUtc: '2026-10-16T01:00:00.000Z',
    },
    {
      pid: 9000003,
      parentPid: process.pid,
      name: 'powershell.exe',
      executable: exe,
      commandLine: [exe, ...args].map(quote).join(' '),
      startUtc: '2026-10-16T01:00:00.001Z',
    },
  ];
  native.processesBefore.push(...structuredClone(rows));
  native.processesAfter.push(...structuredClone(rows));
  return JSON.stringify(native);
};
process.on('exit', () => assert.equal(calls, 1));
