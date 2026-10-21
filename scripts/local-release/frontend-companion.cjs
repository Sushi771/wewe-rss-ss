'use strict';
// Exact installed read-only source versions, independently inspected. Not a
// Python/path allowlist: live ownership, arguments, and every source pin matter.
const { fileHash } = require('./lib.cjs');
const path = require('node:path'),
  assert = require('node:assert/strict');
const { argv } = require('./windows-release-references.cjs');
const PINS = Object.freeze({
  'sqlite-snapshot-guard.py':
    'bfc3d8bb8ccbe3cbbd3149019c3c614eb4ab9f271c8d679ce0459f49a520ddc1',
  'backup-sqlite.py':
    'ad9805577c1cdd42182fcfcd23936f11d0a1852399c1ad8a467aad2e82ba376d',
  'sqlite-retention-plan.py':
    'c3b8fb2c679109b5cf2de3e5a0144eab7095ea4340f83682d9444031d6e02fd6',
});
const INTERPRETER_SHA256 =
  '467014615a5255aca450ae88100dd2caf887da87657f00e3c2171ec44a685aec';
const same = (a, b) =>
  String(a).replace(/\//g, '\\').toLowerCase() ===
  String(b).replace(/\//g, '\\').toLowerCase();
function time(v) {
  if (typeof v === 'string' && v.startsWith('/Date('))
    return Number(v.match(/-?\d+/)[0]);
  return Date.parse(v);
}
function recognize(item, args, parent, expected, { hashFile = fileHash } = {}) {
  assert.deepEqual(argv(item.CommandLine), args, 'COMPANION_COMMAND_CHANGED');
  assert(
    expected &&
      parent &&
      item.ParentProcessId === expected.pid &&
      parent.ProcessId === expected.pid,
    'COMPANION_PARENT_UNPROVEN',
  );
  assert(
    parent.CreationDate &&
      Number.isFinite(time(parent.CreationDate)) &&
      time(parent.CreationDate) === time(expected.startUtc),
    'COMPANION_PARENT_REUSED',
  );
  assert(
    same(parent.ExecutablePath, expected.executable) &&
      parent.CommandLine === expected.commandLine,
    'COMPANION_PARENT_CHANGED',
  );
  assert(
    Number.isInteger(item.ProcessId) &&
      item.CreationDate &&
      Number.isFinite(time(item.CreationDate)) &&
      time(item.CreationDate) >= time(parent.CreationDate),
    'COMPANION_IDENTITY_UNPROVEN',
  );
  const release = path.win32.dirname(path.win32.dirname(expected.executable)),
    script = path.win32.join(
      release,
      'server/scripts/sqlite-snapshot-guard.py',
    );
  const offset = args[1] === '-u' ? 2 : 1;
  // argv[0] is the original launch token (the installed app uses "python").
  // The OS-observed absolute image plus its exact bytes establish the program;
  // never resolve this token through PATH or trust its name as identity.
  assert(
    /^[a-z]:[\\/]/i.test(item.ExecutablePath || ''),
    'COMPANION_INTERPRETER_PATH_UNPROVEN',
  );
  assert.equal(
    hashFile(item.ExecutablePath),
    INTERPRETER_SHA256,
    'COMPANION_INTERPRETER_CHANGED',
  );
  const interpreter = { path: item.ExecutablePath, sha256: INTERPRETER_SHA256 };
  assert(
    (same(args[0], item.ExecutablePath) ||
      (!!args[0] && !/[\\/:]/.test(args[0]))) &&
      same(args[offset], script),
    'COMPANION_ENTRY_UNPROVEN',
  );
  const values = {};
  for (let i = offset + 1; i < args.length; i += 2) {
    assert(
      [
        '--database',
        '--backup-root',
        '--interval-seconds',
        '--max-age-seconds',
      ].includes(args[i]) &&
        !Object.hasOwn(values, args[i]) &&
        args[i + 1],
      'COMPANION_ARGUMENTS_UNPROVEN',
    );
    values[args[i]] = args[i + 1];
  }
  const match = expected.commandLine.match(/--database ([^ ]+)/);
  assert(
    match && same(values['--database'], match[1]),
    'COMPANION_DATABASE_UNPROVEN',
  );
  assert(
    /^[a-z]:[\\/]/i.test(values['--backup-root'] || ''),
    'COMPANION_BACKUP_PATH_UNPROVEN',
  );
  const interval = Number(values['--interval-seconds'] || 900),
    age = Number(values['--max-age-seconds'] || 900);
  assert(
    Number.isInteger(interval) &&
      Number.isInteger(age) &&
      60 <= interval &&
      interval <= age &&
      age <= 86400,
    'COMPANION_CADENCE_UNPROVEN',
  );
  const files = Object.entries(PINS).map(([name, sha256]) => {
    const file = path.win32.join(release, 'server/scripts', name);
    assert.equal(hashFile(file), sha256, 'COMPANION_SOURCE_CHANGED');
    return { path: file, sha256 };
  });
  return {
    pid: item.ProcessId,
    startUtc: item.CreationDate,
    executable: item.ExecutablePath,
    interpreter,
    commandLine: item.CommandLine,
    parent: { ...expected },
    files,
    role: 'read-only-business-database; writes independent backups/receipts',
    connectionSemantics: 'reviewed mode=ro plus PRAGMA query_only=ON',
  };
}
module.exports = { recognize, PINS, INTERPRETER_SHA256 };
