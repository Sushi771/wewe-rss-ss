import {projectWriterGate} from './project-writer-boundary';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { legacySnapshot, fromPreservingRestartCheckpoint, Connection, RestartCheckpoint } from './legacy-maintenance-controller';
import type { Identity, Scope } from './legacy-maintenance';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
type LiveCheckpoint = RestartCheckpoint & {database: string; scopeLease: RestartCheckpoint['scopeLease'] & {
  assertLegacyMaintenanceQuiescent(identity: RestartCheckpoint['identity']): {projectIdentity: string; exitedAt: number; claimAcquiredAt: number};
  legacyMaintenanceBoundary?(identity: RestartCheckpoint['identity'],observe:()=>{complete:boolean;active:unknown[]}):{check():{projectIdentity:string;exitedAt:number;claimAcquiredAt:number};observe():{projectIdentity:string;exitedAt:number;claimAcquiredAt:number;observedAt:number}};
};observeProjectWriters?:()=>{complete:boolean;active:unknown[]}};
function open(database: string): Connection {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(database, { timeout: 1000 });
  return { exec: q => db.exec(q), get: (q, ...p) => db.prepare(q).get(...p), run: (q, ...p) => db.prepare(q).run(...p), close: () => db.close() };
}
/** Internal offline callback only. No proof input, process stop, source request or retry. */
export async function recordLegacyProjectMaintenance(checkpoint: LiveCheckpoint, jobId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) throw Error('LEGACY_MAINTENANCE_UNPROVEN');
  const gate=projectWriterGate();
  const boundary=checkpoint.scopeLease.legacyMaintenanceBoundary?.(checkpoint.identity,checkpoint.observeProjectWriters!);
  if(!boundary)throw Error('LEGACY_MAINTENANCE_BOUNDED_OBSERVER_REQUIRED');
  const safeClaim={...checkpoint.scopeLease,check:()=>boundary.check(),assertLegacyMaintenanceLease:()=>boundary.check()};
  const safeCheckpoint={...checkpoint,scopeLease:safeClaim};
  const lease = gate.acquireMaintenance(checkpoint.database, safeCheckpoint);
  try {
    const live = () => { lease.check(); return boundary.check(); };
    const first = live(), b = gate.binding(checkpoint.database);
    const db = open(b.database); let snapshot: ReturnType<typeof legacySnapshot>;
    try { db.exec('BEGIN'); snapshot = legacySnapshot(db, jobId); db.exec('ROLLBACK'); } finally { db.close(); }
    const scope: Scope = { jobId, authorId: snapshot.authorId, noteId: snapshot.noteId, projectIdentity: first.projectIdentity, databaseIdentity: b.databaseIdentity, unknownDigest: snapshot.unknownDigest, budgetDigest: snapshot.budgetDigest };
    const old = checkpoint.identity;
    const expected: Identity = { pid: old.pid, startIdentity: old.startUtc, executableHash: hash(readFileSync(old.executable)), commandHash: hash(old.commandLine) };
    const holder: Identity = { pid: lease.record.pid, startIdentity: lease.record.startUtc, executableHash: lease.record.executableHash, commandHash: lease.record.commandHash };
    let observed:ReturnType<typeof boundary.observe>|undefined;
    const bound = {...safeCheckpoint, scopeLease: {...safeClaim, check: () => live()}};
    return await fromPreservingRestartCheckpoint(scope, bound, {
      databaseIdentity: () => { live(); return gate.binding(checkpoint.database).databaseIdentity; },
      openDatabase: () => { live(); return open(b.database); },
      readLease: () => { const state = live(); return { nonce: lease.record.nonce, identity: lease.lockIdentity, projectIdentity: state.projectIdentity, holder, held: true, coverage: 'project-start-dispatch-v2', acquiredAt: lease.record.acquiredAt, claimAcquiredAt: state.claimAcquiredAt }; },
      observeProjectWriters:()=>{lease.check();observed=boundary.observe();},
      readProjectWriters: () => { live();if(!observed)throw Error('LEGACY_MAINTENANCE_UNPROVEN');return { complete: true, projectIdentity: observed.projectIdentity, expected: [expected], stopped: [{ identity: expected, exitedAt: observed.exitedAt }], active: [],observedAt:observed.observedAt }; },
    });
  } finally { lease.close(); }
}
