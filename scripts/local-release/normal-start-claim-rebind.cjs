'use strict';
// A pure prior-boot comparison plus its pinned, read-only native evidence loader.
// Callers retain all existing lock, full-reference, capacity and install gates.
// This module never starts software, recovers a writer, mutates a claim or stops it.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { family } = require('./preserving-process-family.cjs');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const hash = (v) => sha(JSON.stringify(v));
const equal = (a, b) => assert.deepEqual(a, b, 'PRIOR_BOOT_REBIND_CHANGED');
const hex = (v) => /^[a-f0-9]{64}$/.test(v || '');
function instant(v) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(v || '');
  assert(m, 'PRIOR_BOOT_REBIND_TIME');
  const ms = Date.parse(m[1] + 'Z');
  assert(
    Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === m[1],
    'PRIOR_BOOT_REBIND_TIME',
  );
  return BigInt(ms) * 1000000n + BigInt((m[2] || '').padEnd(9, '0'));
}
// Must remain identical to release-scope's reference digest projection.
function referenceDigest(value) {
  return hash({
    ...value,
    processTopology: undefined,
    consoleProcesses: undefined,
    exitedConsoleProcesses: undefined,
    exitedProcesses: undefined,
  });
}
function processRows(facts) {
  assert(Array.isArray(facts.records) && facts.records.length <= 4096);
  assert(facts.observationComplete === true && facts.complete === false);
  for (const key of ['errors', 'uncertainChildren']) equal(facts[key], []);
  assert(
    !facts.exitedProcesses?.length && !facts.exitedConsoleProcesses?.length,
  );
  return facts.records.filter((r) => r.kind === 'processes');
}
// The direct-install path does not start the old application. Its only admitted
// reference delta is the complete, proven prior-boot family becoming empty.
function validatePriorBootLeaseEligibility({
  policy,
  oldFacts,
  spec,
  lease,
  observations,
  nowUtc,
}) {
  validateSpec(policy, spec);
  equal(spec.kind, 'prior-boot-empty-install-v1');
  assert(['captured', 'reconstructed'].includes(spec.oldFacts.origin));
  equal(referenceDigest(oldFacts), spec.oldReferences);
  assert(hex(spec.oldReferences) && hex(spec.database.identity));
  const a = policy.preservingUpdate.active;
  const rows = family(
    processRows(oldFacts),
    a.oldProcess.pid,
    a.currentId,
    policy,
    true,
  );
  equal(rows[0].startUtc, a.oldProcess.startUtc);
  equal(rows[0].executableSha256, a.oldProcess.executableSha256);
  equal(lease.version, 1);
  equal(lease.mode, 'writer');
  equal(lease.pid, a.oldProcess.pid);
  equal(lease.startUtc, a.oldProcess.startUtc);
  equal(lease.executableHash, a.oldProcess.executableSha256);
  equal(lease.commandHash, spec.commandHash);
  equal(lease.databaseIdentity, spec.database.identity);
  assert(
    typeof lease.nonce === 'string' && /^[a-f0-9-]{36}$/.test(lease.nonce),
  );
  assert(Number.isSafeInteger(lease.acquiredAt));
  const born = instant(lease.startUtc),
    boot = instant(spec.bootUtc),
    now = instant(nowUtc);
  assert(boot > born && BigInt(lease.acquiredAt) * 1000000n >= born);
  for (const row of rows) assert(instant(row.startUtc) < boot);
  assert(Array.isArray(observations) && observations.length === 2);
  let at = boot;
  for (const v of observations) {
    equal(v.complete, true);
    equal(v.bootUtc, spec.bootUtc);
    equal(v.remaining, []);
    equal(v.portOwners, []);
    // A reused numeric PID is not the original instance. The project-wide
    // reference query independently rejects any newly live project writer.
    if (v.owner) assert(instant(v.owner.startUtc) >= boot);
    const next = instant(v.atUtc);
    assert(
      next >= at &&
        next >= BigInt(lease.acquiredAt) * 1000000n &&
        next <= now &&
        now - next < 30000000000n,
    );
    at = next;
  }
  return {
    kind: spec.kind,
    oldReferences: spec.oldReferences,
    oldFactsOrigin: spec.oldFacts.origin,
    bootUtc: spec.bootUtc,
  };
}
function validatePriorBootEmpty(input) {
  validatePriorBootLeaseEligibility(input);
  const { policy, oldFacts, facts, spec } = input;
  equal(processRows(facts), []);
  const normalized = structuredClone(facts);
  if (spec.launcherTransition) {
    const t = spec.launcherTransition;
    assert(hex(t.oldSha256) && hex(t.newSha256));
    const launchers = policy.windowsReferences.launchers.filter(
      (l) => l.pointerPath === t.pointer,
    );
    assert(launchers.length === 1);
    equal(hash(launchers[0].files), t.newSha256);
    for (const r of normalized.records)
      if (r.viaPointer?.path === t.pointer) {
        equal(r.viaPointer.launcherSha256, t.newSha256);
        r.viaPointer.launcherSha256 = t.oldSha256;
      }
  }
  let n = 0;
  const remaining = normalized.records;
  normalized.records = oldFacts.records.map((r) =>
    r.kind === 'processes' ? r : remaining[n++],
  );
  assert(n === remaining.length);
  equal(referenceDigest(normalized), spec.oldReferences);
  return {
    kind: spec.kind,
    oldReferences: spec.oldReferences,
    oldFactsOrigin: spec.oldFacts.origin,
    bootUtc: spec.bootUtc,
  };
}

function validateSpec(policy, spec) {
  assert(['install', 'restart'].includes(policy.preservingUpdate?.operation));
  equal(policy.preservingUpdate.processFamily?.format, 1);
  equal(policy.preservingUpdate.effectScope?.format, 1);
  assert(spec && !Array.isArray(spec));
  equal(
    Object.keys(spec).sort(),
    [
      'kind',
      'helperSha256',
      'oldReferences',
      'oldFacts',
      'database',
      'writer',
      'observer',
      'bootUtc',
      'commandHash',
      'launcherTransition',
      'lockSha256',
      'recoverySha256',
      'restartBinding',
      'identityObserverSha256',
      'tcpListenersSha256',
    ].sort(),
  );
  equal(spec.kind, 'prior-boot-empty-install-v1');
  for (const k of [
    'helperSha256',
    'oldReferences',
    'commandHash',
    'lockSha256',
    'recoverySha256',
    'identityObserverSha256',
    'tcpListenersSha256',
  ])
    assert(hex(spec[k]));
  equal(Object.keys(spec.database).sort(), ['identity', 'path']);
  equal(Object.keys(spec.writer).sort(), ['identity', 'path', 'sha256']);
  equal(Object.keys(spec.oldFacts).sort(), ['origin', 'path', 'sha256']);
  equal(Object.keys(spec.observer).sort(), ['path', 'sha256']);
  equal(Object.keys(spec.launcherTransition).sort(), [
    'newSha256',
    'oldSha256',
    'pointer',
  ]);
  equal(Object.keys(spec.restartBinding).sort(), [
    'newSha256',
    'oldSha256',
    'path',
  ]);
  assert(
    hex(spec.restartBinding.newSha256) &&
      hex(spec.restartBinding.oldSha256) &&
      spec.restartBinding.newSha256 !== spec.restartBinding.oldSha256,
  );
  for (const p of [spec.writer, spec.oldFacts, spec.observer])
    assert(hex(p.sha256) && typeof p.path === 'string');
  assert(
    Array.isArray(spec.writer.identity) &&
      spec.writer.identity.length === 3 &&
      spec.writer.identity.every(
        (x) => typeof x === 'string' && /^\d+$/.test(x),
      ),
  );
  assert(hex(spec.database.identity));
  instant(spec.bootUtc);
}

// Fixed, pinned native observation. No caller-supplied probe, flags, command or
// successful boolean is accepted. All production effects remain with restart.
function readPriorBootEvidence(policy) {
  const fs = require('node:fs'),
    path = require('node:path');
  const spec = policy.preservingUpdate?.priorBootExit;
  validateSpec(policy, spec);
  assert(spec && hex(spec.helperSha256));
  equal(sha(fs.readFileSync(__filename)), spec.helperSha256);
  const pin = (p, max = 1024 * 1024) => {
    assert(p && hex(p.sha256) && path.isAbsolute(p.path));
    equal(fs.realpathSync.native(p.path), p.path);
    const s = fs.lstatSync(p.path, { bigint: true });
    assert(
      s.isFile() &&
        !s.isSymbolicLink() &&
        s.nlink === 1n &&
        s.size <= BigInt(max),
    );
    const raw = fs.readFileSync(p.path);
    equal(sha(raw), p.sha256);
    const t = fs.lstatSync(p.path, { bigint: true });
    equal(
      [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs],
      [t.dev, t.ino, t.size, t.mtimeNs, t.ctimeNs],
    );
    return { raw, identity: [s.dev, s.ino, s.birthtimeNs].map(String) };
  };
  const a = policy.preservingUpdate.active;
  const pointer = pin({ path: a.pointer, sha256: a.pointerSha256 }, 65536);
  equal(JSON.parse(pointer.raw).id, a.currentId);
  const release = path.join(path.dirname(a.pointer), a.currentId);
  const manifest = JSON.parse(
    pin({
      path: path.join(release, 'release.json'),
      sha256: a.currentManifestSha256,
    }).raw,
  );
  const gatePath = path.join(release, 'project-writer-gate.cjs');
  pin({ path: gatePath, sha256: manifest.files['project-writer-gate.cjs'] });
  const gate = require(gatePath),
    db = gate.binding(spec.database.path);
  equal(db.databaseIdentity, spec.database.identity);
  equal(db.file, spec.writer.path);
  const writer = pin(spec.writer, 16384);
  equal(writer.identity, spec.writer.identity);
  const oldFacts = JSON.parse(pin(spec.oldFacts).raw);
  const lease = JSON.parse(writer.raw);
  const observer = pin(spec.observer);
  const probe = () => {
    pin(spec.observer);
    pin(spec.writer, 16384);
    equal(
      gate.binding(spec.database.path).databaseIdentity,
      spec.database.identity,
    );
    const ps = path.join(
      process.env.SystemRoot,
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const env = Object.fromEntries(
      ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC']
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    );
    const fact = JSON.parse(
      require('node:child_process').execFileSync(
        ps,
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          spec.observer.path,
          '-OwnerPid',
          String(lease.pid),
          '-OwnerStartUtc',
          lease.startUtc,
        ],
        {
          env,
          windowsHide: true,
          encoding: 'utf8',
          timeout: 16000,
          maxBuffer: 65536,
        },
      ),
    );
    // Use the existing pinned PowerShell Port observer directly. The generic
    // identityTool path may compile a cache, which a read-only loader must not do.
    const identityObserver = {
      path: path.join(__dirname, 'process-identity.ps1'),
      sha256: spec.identityObserverSha256,
    };
    const tcpListeners = {
      path: path.join(__dirname, 'tcp-listeners.ps1'),
      sha256: spec.tcpListenersSha256,
    };
    pin(identityObserver);
    pin(tcpListeners);
    fact.portOwners = JSON.parse(
      require('node:child_process').execFileSync(
        ps,
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          identityObserver.path,
          '-Action',
          'Port',
          '-Port',
          '4000',
        ],
        {
          env,
          windowsHide: true,
          encoding: 'utf8',
          timeout: 16000,
          maxBuffer: 65536,
        },
      ),
    );
    pin(identityObserver);
    pin(tcpListeners);
    equal(pin(spec.observer).raw, observer.raw);
    equal(pin(spec.writer, 16384).identity, writer.identity);
    equal(
      gate.binding(spec.database.path).databaseIdentity,
      spec.database.identity,
    );
    return fact;
  };
  const observations = [probe(), probe()];
  pin({ path: a.pointer, sha256: a.pointerSha256 }, 65536);
  pin({
    path: path.join(release, 'release.json'),
    sha256: a.currentManifestSha256,
  });
  pin(spec.oldFacts);
  return {
    spec,
    oldFacts,
    lease,
    observations,
    gate,
    probe,
    root: path.dirname(path.dirname(a.pointer)),
  };
}
module.exports = {
  referenceDigest,
  validatePriorBootLeaseEligibility,
  validatePriorBootEmpty,
  readPriorBootEvidence,
};
