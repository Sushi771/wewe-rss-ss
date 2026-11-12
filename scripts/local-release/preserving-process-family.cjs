// Pure identity/transition rules. No process discovery, stopping, or writes.
const fs = require('node:fs');
const crypto = require('node:crypto');
const digest = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');
const hash = (value) => digest(JSON.stringify(value));
const fail = () => {
  throw Error('RELEASE_PRESERVING_PROCESS_FAMILY_CHANGED');
};
const clean = (rows) =>
  rows
    .map(({ ownedTransition, ...row }) => row)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const equal = (a, b) => hash(clean(a)) === hash(clean(b));
function instant(value) {
  const parts = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(
    value || '',
  );
  const milliseconds = parts && Date.parse(parts[1] + 'Z');
  if (
    !parts ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 19) !== parts[1]
  )
    fail();
  return (
    BigInt(milliseconds) * 1000000n + BigInt((parts[2] || '').padEnd(9, '0'))
  );
}
function includeConsoles(result, expected, policy) {
  if (!policy.preservingUpdate?.processFamily?.consoleHost) return result;
  const parents = [
    ...(result.records || []),
    ...(result.exitedProcesses || []),
    ...(expected || []),
  ].filter((r) => r.kind === 'processes' && !r.consoleHost);
  for (const [key, target] of [
    ['consoleProcesses', 'records'],
    ['exitedConsoleProcesses', 'exitedProcesses'],
  ]) {
    for (const host of result[key] || []) {
      const parent = parents.find((r) => r.pid === host.parentPid);
      if (!parent) continue;
      if (result.processTopology?.some((r) => r.parentPid === host.pid)) fail();
      (result[target] ||= []).push({
        kind: 'processes',
        packageId: parent.packageId,
        packagePath: parent.packagePath,
        ...host,
        parentInvocationSha256: parent.invocationSha256,
      });
    }
  }
  return result;
}
function family(records, pid, packageId, policy, complete = false) {
  const launchers = policy.windowsReferences.launchers.filter(
    (l) => l.packageId === packageId,
  );
  const roots = launchers.filter((l) => l.parentEntry === undefined);
  if (roots.length !== 1) fail();
  const root = records.filter((r) => r.pid === pid);
  if (
    root.length !== 1 ||
    root[0].packageId !== packageId ||
    root[0].invocationSha256 !== hash(roots[0]) ||
    root[0].parentInvocationSha256 !== null ||
    !Number.isInteger(root[0].parentPid)
  )
    fail();
  const rows = [root[0]],
    seen = new Set([root[0].invocationSha256]);
  const rootStarted = instant(root[0].startUtc);
  for (const row of records.filter((r) => r.pid !== pid && !r.consoleHost)) {
    const l = launchers.find((l) => hash(l) === row.invocationSha256);
    if (
      !l ||
      !l.parentEntry ||
      l.parentEntry !== roots[0].entry ||
      row.packageId !== packageId ||
      row.parentPid !== pid ||
      row.parentInvocationSha256 !== root[0].invocationSha256 ||
      instant(row.startUtc) < rootStarted ||
      seen.has(row.invocationSha256)
    )
      fail();
    seen.add(row.invocationSha256);
    rows.push(row);
  }
  const consoleParents = new Set(),
    ordinary = [...rows];
  for (const row of records.filter((r) => r.consoleHost)) {
    const parent = ordinary.find((r) => r.pid === row.parentPid);
    if (
      !policy.preservingUpdate.processFamily.consoleHost ||
      !parent ||
      row.packageId !== packageId ||
      row.parentInvocationSha256 !== parent.invocationSha256 ||
      instant(row.startUtc) < instant(parent.startUtc) ||
      row.invocationSha256 !==
        hash(policy.preservingUpdate.processFamily.consoleHost) ||
      consoleParents.has(row.parentPid)
    )
      fail();
    consoleParents.add(row.parentPid);
    rows.push(row);
  }
  if (
    new Set(rows.map((r) => r.pid)).size !== rows.length ||
    (complete && ordinary.length !== launchers.length)
  )
    fail();
  return rows;
}
function assertSnapshot(row, snapshot) {
  if (
    !snapshot ||
    row.pid !== snapshot.pid ||
    row.startUtc !== snapshot.startUtc ||
    row.identity !==
      hash([
        snapshot.pid,
        row.parentPid,
        snapshot.startUtc,
        fs.realpathSync.native(snapshot.executable),
        digest(fs.readFileSync(snapshot.executable)),
        snapshot.commandLine,
      ])
  )
    fail();
}
function admit(previous, actual, snapshot, packageId, policy, sealed) {
  const rows = family(actual, snapshot.pid, packageId, policy);
  assertSnapshot(rows[0], snapshot);
  if (
    previous.some((p) => !actual.some((r) => equal([p], [r]))) ||
    (sealed && !equal(previous, actual))
  )
    fail();
  return rows.map((row) => ({ ...row, ownedTransition: true }));
}
function remaining(expected, actual, exited, topology, exiting = []) {
  // Disappearance is allowed only during this explicitly confirmed stop.
  // Surviving identities must be byte-identical, and an exited PID cannot return.
  if (
    [...actual, ...exiting].some(
      (r) => exited.has(r.pid) || !expected.some((p) => equal([p], [r])),
    )
  )
    fail();
  if (
    !Array.isArray(topology) ||
    topology.some(
      (r) => !Number.isInteger(r.pid) || !Number.isInteger(r.parentPid),
    )
  )
    fail();
  const pids = new Set(expected.map((r) => r.pid));
  if (
    topology.some(
      (r) =>
        (pids.has(r.pid) || pids.has(r.parentPid)) &&
        !(r.phase === 0 ? [...actual, ...exiting] : actual).some(
          (p) => p.pid === r.pid,
        ),
    )
  )
    fail();
  for (const p of expected)
    if (!actual.some((r) => r.pid === p.pid)) exited.add(p.pid);
  return actual.length;
}
module.exports = {
  family,
  assertSnapshot,
  admit,
  remaining,
  equal,
  includeConsoles,
};
