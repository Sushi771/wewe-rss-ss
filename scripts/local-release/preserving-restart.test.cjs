// Exercises the existing restart orchestration with owned files and simulated
// process/HTTP adapters. It is not a runnable-package or host-observation test.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateSameSchema } = require('./preserving-contract.cjs');
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
for (const failHealth of [false, true]) test('existing restart preserves SQLite and restores active after health failure=' + failHealth, async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-preserve-restart-')));
  const project = path.join(base, 'project'), dir = path.join(project, 'scripts/local-release');
  const database = path.join(project, 'apps/server/data/wewe-rss.db'), pointer = path.join(project, 'active.json');
  fs.mkdirSync(path.dirname(database), { recursive: true }); fs.mkdirSync(dir, { recursive: true });
  execFileSync('python', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table facts(value text)"); c.execute("insert into facts values (?)",("synthetic",)); c.commit(); c.close()', database]);
  const dbHash = hash(database), manifests = new Map();
  for (const id of ['current', 'candidate']) {
    const folder = path.join(project, id); fs.mkdirSync(path.join(folder, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'runtime/node.exe'), 'inert-runtime');
    const m = { format: 1, id, schemaCompatibility: 'current', desktopHelperIncluded: false, files: { 'server/prisma/schema.prisma': 'a'.repeat(64), 'server/prisma/migrations/001/migration.sql': 'b'.repeat(64) }, links: {} };
    manifests.set(folder, m); fs.writeFileSync(path.join(folder, 'release.json'), JSON.stringify(m));
  }
  const previous = path.join(project, 'current'), release = path.join(project, 'candidate');
  validateSameSchema(manifests.get(previous), manifests.get(release));
  fs.writeFileSync(pointer, JSON.stringify({ format: 1, id: 'current' }));
  const events = [], old = { pid: 7, startUtc: '2026-01-01T00:00:00Z', executable: path.join(previous, 'runtime/node.exe'), port: 4000 };
  const active = { pointer, currentId: 'current', candidateId: 'candidate', pointerSha256: hash(pointer), currentManifestSha256: hash(path.join(previous, 'release.json')), candidateManifestSha256: hash(path.join(release, 'release.json')), oldProcess: { pid: old.pid, startUtc: old.startUtc, executableSha256: hash(old.executable) } };
  const lease = { policy: { preservingUpdate: { format: 1, operation: 'restart', active } }, authorizePackage() {}, check() {}, registerOutput() {}, createdOutput() {}, authorizeRecoveryPackage() { events.push('recovery-authorized'); } };
  const children = new Map(); let nextPid = 20;
  const source = fs.readFileSync(path.join(__dirname, 'restart.cjs'), 'utf8');
  let exported;
  const lib = { hostEffects: { fs, processes: { spawn(exe, args) { const child = { pid: nextPid++, exitCode: null, unref() {} }; children.set(child.pid, { exe, args }); events.push(exe.includes('candidate') ? 'candidate-start' : 'old-start'); return child; } } },
    verifyRelease: (p) => manifests.get(p), verifyReleaseAsync: async (p) => manifests.get(p), fileHash: hash,
    cleanEnvironment: (x) => x, inside: (r,p) => p.startsWith(r + path.sep), writeJson: (p,x) => fs.writeFileSync(p, JSON.stringify(x)),
    run(exe, args) { if (args.includes('--backup-root')) { const folder = args[args.indexOf('--backup-root')+1]; fs.mkdirSync(folder,{recursive:true}); const copy=path.join(folder,'snapshot.db'); fs.copyFileSync(database,copy); events.push('backup'); return JSON.stringify({integrityCheck:'ok',backup:copy,sha256:hash(copy)}); } return JSON.stringify({ pending: [], tables: { facts: { rows: 1 } } }); } };
  const scope = { assertWritableSession() {}, session: () => lease, within: async (r, callback) => callback(lease) };
  const switchAdapter = { loadProductionEnvironment() {}, unusedPort: async()=>41001, portOwnersAsync: async()=>[],
    processIdentity(action,pid,port) { if(action==='Port')return []; if(action==='Stop'){events.push('old-stop');return {stopped:true};} if(pid===7)return {...old,commandLine:exported.commandLine(previous,database,4000)}; return {pid,startUtc:'2026-01-01T01:00:00Z',executable:children.get(pid).exe,port}; },
    sameIdentity(actual,expected) { assert.equal(actual.pid,expected.pid); assert.equal(actual.startUtc,expected.startUtc); },
    waitReady: async (port,child)=>{ if(failHealth&&children.get(child.pid).exe.includes('candidate'))throw Error('synthetic-health-failure'); events.push('healthy'); }, stopOwned: async(child)=>{if(child){events.push('candidate-stop');child.exitCode=0;}} };
  const module = { exports: {} };
  const localRequire = (p) => p==='./lib.cjs'?lib:p==='./switch.cjs'?switchAdapter:p==='./release-scope.cjs'?scope:p==='./startup-acceptance.cjs'?{accepted:()=>false,recordAcceptance(){}}:p==='./active-release.cjs'?{writeActiveReleaseAsync:async(p)=>{events.push('active-'+path.basename(p));fs.writeFileSync(pointer,JSON.stringify({format:1,id:path.basename(p)}));}}:p==='./space-budget.cjs'?{productionRoot:()=>path.join(base,'backups')}:p==='./preserving-contract.cjs'?require(p):require(p);
  localRequire.main = undefined;
  try {
    // This harness tests Windows orchestration with simulated OS adapters on
    // either CI host; it does not claim a native Windows process execution.
    const adapterProcess = Object.create(process);
    Object.defineProperty(adapterProcess, 'platform', { value: 'win32' });
    vm.runInThisContext('(function(require,module,exports,__dirname,process){'+source+'\n})')(localRequire,module,module.exports,dir,adapterProcess);
    exported=module.exports;
    const promise=exported.controlledRestart({production:true,rehearsal:false,mode:'restart',release,previous,database,expected:{...old,commandLine:exported.commandLine(previous,database,4000)}});
    if(failHealth) await assert.rejects(promise,/synthetic-health-failure/); else assert.equal((await promise).passed,true);
    assert.equal(hash(database),dbHash);
    assert.equal(JSON.parse(fs.readFileSync(pointer)).id,failHealth?'current':'candidate');
    assert(events.indexOf('backup')<events.indexOf('old-stop'));
    assert(events.filter(x=>x==='backup').length>=2);
    if(failHealth)assert(events.includes('recovery-authorized'));
    assert(fs.existsSync(path.join(previous,'release.json'))); assert(fs.existsSync(path.join(release,'release.json')));
  } finally { fs.rmSync(base,{recursive:true}); }
});
