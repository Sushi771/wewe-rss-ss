// A bounded project/database instance lease. Never infers a remote outcome.
// Stale leases are retained for an exact, trusted stop receipt; PID absence is insufficient.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const hash = (v) => createHash('sha256').update(v).digest('hex');
const leases = globalThis[Symbol.for('wewe.project-writer-leases.v1')] ||= new Map();
if(!globalThis[Symbol.for('wewe.project-writer-exit.v1')]) {
  globalThis[Symbol.for('wewe.project-writer-exit.v1')]=true;
  process.once('exit',()=>{for(const lease of leases.values())try{lease.autoClose();}catch{/* Changed/stale evidence is retained. */}});
}
const fail = () => { throw Error('PROJECT_WRITER_BOUNDARY_UNPROVEN'); };
function identity(file) {
  const s = fs.lstatSync(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || !s.ino) return fail();
  return hash(JSON.stringify([String(s.dev), String(s.ino), String(s.birthtimeNs)]));
}
function binding(database) {
  const real = fs.realpathSync.native(database), id = identity(real);
  const namespace=hash(process.platform==='win32'?real.toLowerCase():real);
  return { database: real, databaseIdentity: id, file: path.join(path.dirname(real), `.project-writer-${namespace}.json`) };
}
function self() {
  const cached=globalThis[Symbol.for('wewe.project-writer-self.v1')];
  if(cached){if(cached.pid!==process.pid)return fail();return cached;}
  if (process.platform === 'linux') { const stat = fs.readFileSync('/proc/self/stat', 'utf8'); const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; return { pid: process.pid, startUtc: 'linux:' + fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + ticks, executableHash: hash(fs.readFileSync(process.execPath)), commandHash: hash(fs.readFileSync('/proc/self/cmdline')) }; }
  if (process.platform !== 'win32') return fail();
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = `$p=[Diagnostics.Process]::GetProcessById(${process.pid});try{$null=$p.Handle;$c=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}' -ErrorAction Stop;@{pid=$p.Id;startUtc=$p.StartTime.ToUniversalTime().ToString('o');commandLine=$c.CommandLine}|ConvertTo-Json -Compress}finally{$p.Dispose()}`;
  const r = JSON.parse(execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 65536 }));
  if (r.pid !== process.pid || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(r.startUtc) || typeof r.commandLine !== 'string' || !r.commandLine) return fail();
  const result=Object.freeze({ pid: r.pid, startUtc: r.startUtc, executableHash: hash(fs.readFileSync(process.execPath)), commandHash: hash(r.commandLine) });
  globalThis[Symbol.for('wewe.project-writer-self.v1')]=result;
  return result;
}
function acquire(database, mode) {
  const b = binding(database), old = leases.get(b.databaseIdentity);
  if (old) { if (mode !== 'writer' || old.record.mode !== mode) return fail(); old.check(); return old; }
  const record = { version: 1, mode, ...self(), databaseIdentity: b.databaseIdentity, nonce: randomUUID(), acquiredAt: Date.now() };
  const raw = JSON.stringify(record); const fd = fs.openSync(b.file, 'wx', 0o600);
  try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const lockIdentity = identity(b.file); let closed = false, retainOnExit = false;
  const check = () => { if (closed || binding(database).databaseIdentity !== b.databaseIdentity || identity(b.file) !== lockIdentity || fs.readFileSync(b.file, 'utf8') !== raw) return fail(); };
  const close = () => { if (closed) return; check(); fs.unlinkSync(b.file); closed = true; leases.delete(b.databaseIdentity); };
  const abandon = () => { check(); closed=true; leases.delete(b.databaseIdentity); };
  const lease = Object.freeze({ record: Object.freeze(record), database: b.database, file: b.file, lockIdentity, check, close, abandon, retainOnExit:()=>{check();retainOnExit=true;},autoClose:()=>{if(!retainOnExit)close();} });
  leases.set(b.databaseIdentity, lease);
  return lease;
}
function acquireWriter(database) { return acquire(database, 'writer'); }
function writerForUrl(url, base = process.cwd()) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return undefined;
  return acquireWriter(path.resolve(base, decodeURIComponent(url.slice(5).split('?')[0])));
}
function retireStoppedWriter(database, checkpoint) {
  const b = binding(database);
  if (!fs.existsSync(b.file)) return;
  const { identity: i, stopReceipt: r, scopeLease: claim } = checkpoint || {};
  if (!i || !r || r.stopped !== true || typeof claim?.check !== 'function' || typeof claim?.assertWritable !== 'function') return fail();
  if (['pid', 'startUtc', 'executable', 'commandLine'].some(k => i[k] !== r[k])) return fail();
  claim.assertWritable(['restart']); claim.check(true);
    const oldIdentity = identity(b.file), raw = fs.readFileSync(b.file, 'utf8'), old = JSON.parse(raw);
    if (old.version !== 1 || old.mode !== 'writer' || old.databaseIdentity !== b.databaseIdentity || old.pid !== i.pid || old.startUtc !== i.startUtc || old.executableHash !== hash(fs.readFileSync(i.executable)) || old.commandHash !== hash(i.commandLine) || typeof old.nonce !== 'string') return fail();
    claim.check(true);
    if (identity(b.file) !== oldIdentity || fs.readFileSync(b.file, 'utf8') !== raw) return fail();
    fs.unlinkSync(b.file);
}
function acquireMaintenance(database, checkpoint) {
  const { identity:i,stopReceipt:r,scopeLease:claim }=checkpoint||{};
  const checkLease=claim?.assertLegacyMaintenanceLease||claim?.assertLegacyMaintenanceQuiescent;
  if (!i || !r || r.stopped!==true || typeof checkLease!=='function' || typeof claim?.assertWritable!=='function' || typeof claim?.check!=='function' || ['pid','startUtc','executable','commandLine'].some(k=>i[k]!==r[k])) return fail();
  claim.assertWritable(['restart']);checkLease.call(claim,i);claim.check(true);
  retireStoppedWriter(database,checkpoint);
  const lease = acquire(database, 'maintenance');
  try { checkLease.call(claim,i); return lease; } catch (error) { lease.close(); throw error; }
}
const api=Object.freeze({ acquireWriter, writerForUrl, acquireMaintenance, retireStoppedWriter, binding });
globalThis[Symbol.for('wewe.project-writer-api.v1')]=api;
module.exports = api;
