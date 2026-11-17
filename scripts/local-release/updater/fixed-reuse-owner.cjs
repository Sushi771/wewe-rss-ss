'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { fixedProfile } = require('./fixed-driver-profile.cjs');
const { identity } = require('./install-binding/restore-identity-binding.cjs');
const prewrite = require('./install-binding/role-aware/switch-prewrite.cjs');
const bindings = new WeakMap(), continuations = new WeakMap(), handles = new WeakMap();
const fail = code => { throw Error(code); };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stamp = file => { const s = fs.lstatSync(file, { bigint: true }); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n) fail('REUSE_BACKUP_NOT_PLAIN'); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':'); };

function reuseBinding(token, options) {
  const value = bindings.get(token);
  if (!value || value.scopeLease !== options.scopeLease || value.data.roles !== options.roles || value.data.profile.database !== options.database || value.data.profile.backupDataRoot !== options.dataRoot) fail('OPAQUE_REUSE_OWNER_BINDING_REQUIRED');
  return value;
}

async function openBackend(data, ctx, native, record, resumed) {
  const p = data.profile, script = path.join(__dirname, 'reuse-owner-backend.py');
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC'].includes(key.toUpperCase())));
  Object.assign(environment, { PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' });
  record({ stage: 'reuse-helper-launch-intent', transactionId: ctx.transactionId, profileSha256: data.fixed.sha256 });
  const child = cp.spawn(p.python, ['-B', script, data.fixed.path, data.fixed.sha256], { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  child.on('error', () => {});
  record({ stage: 'reuse-helper-created-pid-unverified', pid: child.pid || null, transactionId: ctx.transactionId });
  const nonce = crypto.randomBytes(32).toString('hex');
  let pending, sequence = 0, exited = false, exitCode;
  child.stdin.on('error', error => pending?.reject(error));
  const exit = new Promise(resolve => child.once('exit', code => { exited = true; exitCode = code; pending?.reject(Error('REUSE_OWNER_EXITED')); resolve(code); }));
  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', line => {
    const waiter = pending; pending = undefined;
    if (!waiter) return;
    if (line.length > 16384) return waiter.reject(Error('REUSE_OWNER_RESPONSE_TOO_LARGE'));
    try { const result = JSON.parse(line); if (result.error) throw Error(result.error); waiter.resolve(result); } catch (error) { waiter.reject(error); }
  });
  function receive(send) {
    if (pending || exited || !child.pid) fail('REUSE_OWNER_CHANNEL_UNAVAILABLE');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (pending?.timer === timer) pending = undefined; reject(Error('REUSE_OWNER_TIMEOUT')); }, 60000);
      pending = { timer, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      send();
    });
  }
  let observed;
  try {
  const ready = await receive(() => child.stdin.write(JSON.stringify({ operation: resumed ? 'resume' : 'admit', transactionId: ctx.transactionId, nonce }) + '\n'));
  if (ready.ready !== true || ready.transactionId !== ctx.transactionId || ready.reused !== true || ready.mode !== (resumed ? 'resume' : 'admit')) fail('REUSE_OWNER_ADMISSION_UNPROVEN');
  // Snapshot requires ownership of the HTTP listener; this read-only Python
  // helper is not a listener. Capture its actual native tree identity, then
  // independently confirm the same birth/executable/command through OwnedSnapshot.
  const tree = await native.processIdentity('Tree', child.pid, p.port || 4000);
  if (tree?.complete !== true || !Array.isArray(tree.active)) fail('REUSE_HELPER_NATIVE_IDENTITY_CHANGED');
  const captured = tree.active.find(item => item.pid === child.pid);
  if (!captured || typeof captured.startUtc !== 'string' || typeof captured.commandLine !== 'string') fail('REUSE_HELPER_NATIVE_IDENTITY_CHANGED');
  observed = await native.processIdentity('OwnedSnapshot', child.pid, p.port || 4000, captured);
  if (observed?.pid !== child.pid || observed.executable?.toLowerCase() !== p.python.toLowerCase()) fail('REUSE_HELPER_NATIVE_IDENTITY_CHANGED');
  record({ stage: 'reuse-helper-registered', identity: observed, transactionId: ctx.transactionId, profileSha256: data.fixed.sha256 });
  } catch (error) {
    // Closing our private input lets the pinned worker release its OS lock.
    // Do not infer exit from a failed native identity check or kill another PID.
    child.stdin.end();
    try {
      await Promise.race([exit, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('REUSE_HELPER_EXIT_UNKNOWN')), 5000); timer.unref(); })]);
      record({ stage: 'reuse-helper-startup-failed-exit-confirmed', pid: child.pid, transactionId: ctx.transactionId });
    } catch (closeError) { throw new AggregateError([error, closeError], 'REUSE_HELPER_STARTUP_AND_EXIT_UNCERTAIN'); }
    throw error;
  }
  const live = () => { if (exited || child.exitCode !== null || child.signalCode) fail('REUSE_OWNER_LEASE_LOST'); };
  async function request(operation) {
    live();
    const number = ++sequence;
    const response = await receive(() => child.stdin.write(JSON.stringify({ operation, transactionId: ctx.transactionId, nonce, sequence: number }) + '\n'));
    if (response.sequence !== number || response.ok !== true) fail('REUSE_OWNER_CHANNEL_BINDING_CHANGED');
    return response;
  }
  return {
    live,
    check: () => request('check'),
    same: async () => (await request('same')).same === true,
    async close() {
      await request('close'); child.stdin.end();
      const code = await Promise.race([exit, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('REUSE_HELPER_EXIT_UNKNOWN')), 5000); timer.unref(); })]);
      if (code !== 0 || exitCode !== 0) fail('REUSE_HELPER_EXIT_UNPROVEN');
      record({ stage: 'reuse-helper-exited', identity: observed, transactionId: ctx.transactionId });
    },
    async abandon() {
      if (!exited) child.stdin.end();
      await Promise.race([exit, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('REUSE_HELPER_EXIT_UNKNOWN')), 5000); timer.unref(); })]);
      record({ stage: 'reuse-helper-exited-after-held-failure', identity: observed, transactionId: ctx.transactionId });
    },
  };
}

function createFixedReuseOwner({ profileToken, scopeLease, writerGate, checkpoint, native, record = () => {}, continuation }) {
  const data = fixedProfile(profileToken), p = data.profile;
  const carried = continuation && continuations.get(continuation);
  if (continuation && (!carried || carried.scopeLease !== scopeLease || carried.profileToken !== profileToken || carried.consumed)) fail('OPAQUE_REUSE_CONTINUATION_REQUIRED');
  let admitted = carried?.admitted, backend, closed = false, transactionId = admitted?.transactionId, restored = false;
  const token = Object.freeze({});
  const gate = {
    data, scopeLease,
    check(ctx) {
      if (!backend || closed || !admitted || ctx.transactionId !== transactionId || ctx.backup?.path !== p.backup.path || ctx.backup?.sha256 !== p.backup.sha256 || ctx.backup?.reused !== true || ctx.backup?.reuseProof !== 'all-schema-and-typed-rows-pinned-snapshot-v1') fail('REUSE_ADMISSION_NOT_ESTABLISHED');
      backend.live();
      if (stamp(p.backup.path) !== admitted.stamp || hash(p.backup.path) !== p.backup.sha256) fail('REUSED_BACKUP_CHANGED');
      return p.backup.path;
    },
  };
  bindings.set(token, gate);
  const base = require('./legacy-maintenance-adapter.cjs').createLegacyMaintenance({ database: p.database, dataRoot: p.backupDataRoot, roles: data.roles, scopeLease, writerGate, checkpoint, observe: () => scopeLease.observeProjectWriters(), reuseBinding: token });
  const own = ctx => { if (closed) fail('REUSE_OWNER_CLOSED'); base.claim.assertMaintenanceOwnership(ctx); if (transactionId && transactionId !== ctx.transactionId) fail('REUSE_TRANSACTION_CHANGED'); };
  const backupValue = () => ({ path: p.backup.path, sha256: p.backup.sha256, bytes: fs.statSync(p.backup.path).size, reused: true, reuseProof: 'all-schema-and-typed-rows-pinned-snapshot-v1' });
  const owner = {
    ...base,
    async acquire(ctx) {
      if (backend || closed) fail('REUSE_OWNER_ALREADY_ACQUIRED');
      base.acquire(); own(ctx); transactionId = ctx.transactionId;
      backend = await openBackend(data, ctx, native, record, !!carried);
      if (carried) { carried.consumed = true; continuations.delete(continuation); base.claim.assertDatabaseRestoreAuthorized({ ...ctx, backup: backupValue() }); }
      return true;
    },
    async admit(ctx) {
      own(ctx); await backend.check();
      if (!admitted) admitted = { transactionId, stamp: stamp(p.backup.path), context: structuredClone(ctx) };
      const value = backupValue();
      base.claim.assertDatabaseRestoreAuthorized({ ...ctx, backup: value });
      record({ stage: 'exact-existing-protected-backup-admitted', transactionId, path: value.path, sha256: value.sha256, reused: true });
      return value;
    },
    async assertProof(ctx) { own(ctx); base.claim.assertDatabaseRestoreAuthorized(ctx); await backend.check(); return true; },
    async restoreAlreadyEqual(ctx) {
      await owner.assertProof(ctx);
      if (!(await backend.same())) fail('UNEXPECTED_DATABASE_CHANGE_RESTORE_HELD');
      prewrite.inspectSwitchDatabase({ database: p.database, roles: data.roles, stage: 'before-migration', operationId: ctx.transactionId });
      const oldIdentity = identity(p.database);
      const permit = base.claim.authorizeDatabaseReplacement({ transactionId, database: p.database, oldIdentity, backupSha256: p.backup.sha256 });
      await backend.check();
      const proof = base.claim.rebindDatabaseIdentity(permit, { transactionId, database: p.database, oldIdentity, newIdentity: identity(p.database), backupSha256: p.backup.sha256 });
      if (base.verifyStopReceipt(proof, ctx) !== true) fail('REUSE_RESTORE_REBIND_UNPROVEN');
      restored = true;
      record({ stage: 'restore-verified-already-equal-and-opaque-rebound', transactionId, backupSha256: p.backup.sha256 });
      return { databaseRestored: true, method: 'verified-already-equal', identityRebound: true };
    },
    async close() {
      if (!backend || closed) fail('REUSE_OWNER_CLOSE_UNCERTAIN');
      await backend.check(); base.close(); await backend.close(); closed = true;
      const handle = Object.freeze({});
      continuations.set(handle, { scopeLease, profileToken, admitted, native, record, consumed: false, restored });
      return handle;
    },
    async closeFailed() {
      if (closed) return;
      try { base.close(); } finally { if (backend) await backend.abandon(); closed = true; }
    },
  };
  handles.set(owner, { data, scopeLease, get admitted() { return admitted; }, get restored() { return restored; }, get closed() { return closed; }, check: ctx => owner.assertProof(ctx) });
  return owner;
}

async function withAuthorizedReusedPointer(handle, input, verifyCandidateReadOnly, commit) {
  const live = handles.get(handle), continuation = continuations.get(handle);
  const state = live || (continuation && { data: fixedProfile(continuation.profileToken), scopeLease: continuation.scopeLease, admitted: continuation.admitted, closed: true, restored: continuation.restored });
  if (!state || !state.admitted) fail('OPAQUE_REUSE_POINTER_HANDLE_REQUIRED');
  const { profile: p } = state.data, tx = state.admitted.transactionId;
  state.scopeLease.check(true);
  if (input.transactionId !== tx || input.destination !== path.join(p.releasesRoot, 'active.json') || path.dirname(input.temporary) !== p.releasesRoot || input.journalFile !== p.journalFile) fail('REUSE_POINTER_BINDING_CHANGED');
  const j = JSON.parse(fs.readFileSync(p.journalFile, 'utf8'));
  const forward = input.id === p.candidate.id;
  if (j.transactionId !== tx || j.stage !== (forward ? 'activating' : 'recovering') || j.package.sha256 !== p.candidate.sha256 || j.old.sha256 !== p.current.sha256 || j.backup?.sha256 !== p.backup.sha256 || j.backup?.reused !== true) fail('REUSE_POINTER_JOURNAL_CHANGED');
  if (hash(p.backup.path) !== p.backup.sha256 || stamp(p.backup.path) !== state.admitted.stamp) fail('REUSED_BACKUP_CHANGED');
  if (typeof commit !== 'function') fail('ORIGINAL_POINTER_COMMIT_REQUIRED');
  let publicationLease;
  try {
    if (forward) {
      if (!continuation || continuation.consumed || typeof verifyCandidateReadOnly !== 'function') fail('READ_ONLY_CANDIDATE_PROOF_REQUIRED');
      publicationLease = await openBackend(state.data, state.admitted.context, continuation.native, continuation.record, true);
      if (await verifyCandidateReadOnly() !== true || !(await publicationLease.same())) fail('READ_ONLY_CANDIDATE_PROOF_REQUIRED');
    } else {
      if (input.id !== p.current.id || !live || !live.restored || live.closed) fail('OPAQUE_REUSE_RESTORE_REQUIRED');
      await live.check({ ...state.admitted.context, backup: j.backup });
    }
    state.scopeLease.authorizePointerCommit(input.temporary, input.destination, input.id, !forward);
    state.scopeLease.check(true);
    const result = await commit();
    state.scopeLease.check(true);
    if (publicationLease) await publicationLease.check();
    return result;
  } finally { if (publicationLease) await publicationLease.close(); }
}
module.exports = { createFixedReuseOwner, withAuthorizedReusedPointer, reuseBinding };
