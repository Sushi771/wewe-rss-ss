'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const {
  recognize,
  PINS,
  INTERPRETER_SHA256,
} = require('./frontend-companion.cjs');
function fixture() {
  const expected = {
    pid: 10,
    startUtc: '2026-10-21T00:00:00Z',
    executable: 'C:\\app\\old\\runtime\\node.exe',
    commandLine: 'node runtime.cjs start --database C:\\app\\data.db',
    port: 4000,
  };
  const parent = {
    ProcessId: 10,
    CreationDate: expected.startUtc,
    ExecutablePath: expected.executable,
    CommandLine: expected.commandLine,
  };
  const item = {
    ProcessId: 11,
    ParentProcessId: 10,
    CreationDate: '2026-10-21T00:01:00Z',
    ExecutablePath: 'C:\\python\\python.exe',
    CommandLine: 'exact original command',
  };
  const args = [
    item.ExecutablePath,
    '-u',
    'C:\\app\\old\\server\\scripts\\sqlite-snapshot-guard.py',
    '--database',
    'C:\\app\\data.db',
    '--backup-root',
    'C:\\app\\backups',
  ];
  item.CommandLine = args.join(' ');
  return {
    expected,
    parent,
    item,
    args,
    options: {
      hashFile: (file) =>
        file === item.ExecutablePath
          ? INTERPRETER_SHA256
          : PINS[path.win32.basename(file)],
    },
  };
}
test('only exact reviewed sources, full ownership and database arguments prove a read-only companion', () => {
  const f = fixture(),
    r = recognize(f.item, f.args, f.parent, f.expected, f.options);
  assert.equal(r.pid, 11);
  assert.equal(r.files.length, 3);
  assert.equal(r.parent.pid, 10);
  assert(r.connectionSemantics.includes('mode=ro'));
});
test('observed installed snapshot launch shape uses relative python, no -u and Windows CIM creation dates', () => {
  const f = fixture();
  f.args = [
    'python',
    f.args[2],
    '--database',
    'C:\\app\\data.db',
    '--backup-root',
    'C:\\app\\backups',
    '--interval-seconds',
    '900',
    '--max-age-seconds',
    '900',
  ];
  f.item.CommandLine = f.args.join(' ');
  f.parent.CreationDate = '/Date(' + Date.parse(f.expected.startUtc) + ')/';
  f.item.CreationDate = '/Date(' + Date.parse('2026-10-21T00:01:00Z') + ')/';
  const result = recognize(f.item, f.args, f.parent, f.expected, f.options);
  assert.deepEqual(result.interpreter, {
    path: f.item.ExecutablePath,
    sha256: INTERPRETER_SHA256,
  });
  assert.equal(result.commandLine, f.item.CommandLine);
  assert.equal(result.startUtc, f.item.CreationDate);
});
test('relative launch token never substitutes for an unknown executable or different executable bytes', () => {
  for (const kind of [
    'missing',
    'relative',
    'unc',
    'hash',
    'absolute-token-mismatch',
  ]) {
    const f = fixture();
    f.args[0] = 'python';
    if (kind === 'missing') delete f.item.ExecutablePath;
    if (kind === 'relative') f.item.ExecutablePath = 'python.exe';
    if (kind === 'unc') f.item.ExecutablePath = '\\\\server\\python.exe';
    if (kind === 'hash')
      f.options.hashFile = (file) =>
        file === f.item.ExecutablePath
          ? '0'.repeat(64)
          : PINS[path.win32.basename(file)];
    if (kind === 'absolute-token-mismatch') f.args[0] = 'C:\\wrong\\python.exe';
    f.item.CommandLine = f.args.join(' ');
    assert.throws(
      () => recognize(f.item, f.args, f.parent, f.expected, f.options),
      kind,
    );
  }
});
for (const field of ['ParentProcessId', 'CreationDate', 'ProcessId'])
  test('missing companion identity ' + field + ' is refused', () => {
    const f = fixture();
    delete f.item[field];
    assert.throws(() =>
      recognize(f.item, f.args, f.parent, f.expected, f.options),
    );
  });
test('changed parent creation/command and modified dependency are never accepted by name', () => {
  for (const change of ['creation', 'command', 'hash', 'path', 'database']) {
    const f = fixture();
    if (change === 'creation') f.parent.CreationDate = '2025-01-01';
    if (change === 'command') f.parent.CommandLine += ' other';
    if (change === 'hash') f.options.hashFile = () => '0'.repeat(64);
    if (change === 'path') f.args[2] = 'C:\\unknown\\sqlite-snapshot-guard.py';
    if (change === 'database') f.args[4] = 'C:\\other.db';
    assert.throws(
      () => recognize(f.item, f.args, f.parent, f.expected, f.options),
      change,
    );
  }
});
