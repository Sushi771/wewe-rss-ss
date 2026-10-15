import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveSqliteBackupRoot } from './sqlite-backup-root';
import { createInterface } from 'node:readline';
import { sqliteWrites } from './sqlite-write-coordinator';
import { activeVerifiedBackupReferences } from './sqlite-backup-reuse';

export interface FastInsertSnapshotLease {
  token: string;
  generation: string;
  snapshotGeneration: string;
  databasePath: string;
  databaseIdentity: [string, string];
  schemaVersion: number;
  schemaSha256: string;
  snapshotSha256: string;
  validUntilMs: number;
  backupStartedAtMs: number;
  backupSucceededAtMs: number;
  coverageAtMs: number;
  elapsedSinceBackupSuccessMs: number;
  conservativeRecoveryWindowMs: number;
}

export interface FastInsertSnapshotHealth {
  verified: boolean;
  fresh: boolean;
  reason?: string;
  lease?: FastInsertSnapshotLease;
}

/** Three legacy display fields are metadata; only lease authorizes a write. */
export type InsertOnlySnapshot = {
  source: string;
  sha256: string;
  verifiedAtMs: number;
  lease: FastInsertSnapshotLease;
};

type RawTransaction = {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
};

const fallback = (reason: string): FastInsertSnapshotHealth => ({
  verified: false,
  fresh: false,
  reason,
});

/** Private stdio to one OS-locked owner; no persisted receipt grants a lease. */
export class SqliteSnapshotGuard {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    {
      resolve: (value: FastInsertSnapshotHealth) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private id = 0;
  private reason = 'snapshot-owner-not-started';
  private periodicFailed = false;
  private starting?: Promise<void>;
  private generation?: string;
  private databasePath?: string;
  private historyRuntimePath?: string;
  private nodeIdentity?: [string, string];
  private readonly issued = new Map<string, FastInsertSnapshotLease>();

  start(): Promise<void> {
    if (!this.starting) this.starting = this.launch();
    return this.starting;
  }

  private async launch() {
    if (process.env.SQLITE_PERIODIC_SNAPSHOT_ENABLED !== '1') {
      this.reason = 'periodic-snapshot-disabled';
      return;
    }
    try {
      const url = process.env.DATABASE_URL || '';
      if (!url.startsWith('file:')) throw new Error();
      const raw = decodeURIComponent(url.slice(5).split('?')[0]);
      if (!raw || /[\0\r\n]/.test(raw)) throw new Error();
      let root: string | undefined;
      for (const candidate of [
        process.cwd(),
        path.resolve(process.cwd(), 'apps', 'server'),
      ]) {
        try {
          await access(path.join(candidate, 'prisma', 'schema.prisma'));
          await access(
            path.join(candidate, 'scripts', 'sqlite-snapshot-guard.py'),
          );
          root = candidate;
          break;
        } catch {
          // Try the other supported working directory.
        }
      }
      if (!root) throw new Error();
      const database = await realpath(
        path.isAbsolute(raw) ? raw : path.resolve(root, 'prisma', raw),
      );
      const file = await stat(database, { bigint: true });
      if (!file.ino) throw new Error();
      this.databasePath = database;
      this.nodeIdentity = [file.dev.toString(), file.ino.toString()];
      const python =
        process.env.SQLITE_BACKUP_PYTHON?.trim() ||
        (process.platform === 'win32' ? 'python' : 'python3');
      if (/[\0\r\n]/.test(python)) throw new Error();
      const interval = process.env.SQLITE_SNAPSHOT_INTERVAL_SECONDS || '900';
      const maxAge = process.env.SQLITE_SNAPSHOT_MAX_AGE_SECONDS || '900';
      if (
        !/^\d+$/.test(interval) ||
        !/^\d+$/.test(maxAge) ||
        Number(interval) < 60 ||
        Number(interval) > Number(maxAge) ||
        Number(maxAge) > 86400
      )
        throw new Error();
      this.reason = 'startup-backup-required';
      this.historyRuntimePath = path.join(
        root,
        'scripts',
        'article-history-runtime.cjs',
      );
      const child = spawn(
        python,
        [
          path.join(root, 'scripts', 'sqlite-snapshot-guard.py'),
          '--database',
          database,
          '--backup-root',
          resolveSqliteBackupRoot(database),
          '--interval-seconds',
          interval,
          '--max-age-seconds',
          maxAge,
        ],
        {
          windowsHide: true,
          shell: false,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      this.child = child;
      // Python stderr may contain private paths: drain without forwarding it.
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        try {
          const limit =
            process.env.SQLITE_ARTICLE_HISTORY_REVIEW_ENABLED === '1'
              ? 256 * 1024
              : 8192;
          if (Buffer.byteLength(line) > limit) throw new Error();
          const message = JSON.parse(line);
          if (message.event === 'periodic-snapshot-status') {
            if (typeof message.ok !== 'boolean') throw new Error();
            if (!message.ok && !this.periodicFailed)
              console.warn('[SQLITE_PERIODIC_SNAPSHOT_FAILED]');
            if (message.ok && this.periodicFailed)
              console.info('[SQLITE_PERIODIC_SNAPSHOT_RECOVERED]');
            this.periodicFailed = !message.ok;
            return;
          }
          const { id, result } = message;
          const pending = this.pending.get(id);
          if (!pending) return;
          if (
            !result ||
            typeof result.verified !== 'boolean' ||
            typeof result.fresh !== 'boolean'
          )
            throw new Error();
          if (result.lease) {
            const lease = result.lease as FastInsertSnapshotLease;
            if (
              !/^[a-f0-9]{32}$/.test(lease.token) ||
              !/^[a-f0-9]{32}$/.test(lease.generation) ||
              !/^[a-f0-9]{32}$/.test(lease.snapshotGeneration) ||
              !/^[a-f0-9]{64}$/.test(lease.schemaSha256) ||
              !/^[a-f0-9]{64}$/.test(lease.snapshotSha256) ||
              lease.databasePath !== database ||
              !Number.isSafeInteger(lease.schemaVersion) ||
              !Number.isFinite(lease.validUntilMs) ||
              lease.validUntilMs <= Date.now() ||
              (this.generation && this.generation !== lease.generation)
            )
              throw new Error();
            // Python and libuv encode Windows volume IDs differently. Each
            // runtime pins identity independently; never compare truncated IDs.
            // The owner validates its persistent source handle/file identity;
            // this capability binds the Node transaction to its launch identity.
            lease.databaseIdentity = Object.freeze([
              ...this.nodeIdentity!,
            ]) as unknown as [string, string];
            this.generation = lease.generation;
            for (const [token, existing] of this.issued)
              if (existing.validUntilMs <= Date.now())
                this.issued.delete(token);
            this.issued.set(lease.token, Object.freeze(lease));
          }
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.resolve(result);
        } catch {
          this.stop('snapshot-owner-protocol-failed');
        }
      });
      child.on('error', () => this.stop('snapshot-owner-unavailable'));
      child.stdin.on('error', () => this.stop('snapshot-owner-unavailable'));
      child.once('close', () => {
        lines.close();
        if (this.child === child) this.stop('snapshot-owner-exited');
      });
    } catch {
      this.stop('snapshot-owner-unavailable');
    }
  }

  stop(reason = 'snapshot-owner-stopped') {
    if (
      [
        'snapshot-owner-unavailable',
        'snapshot-owner-protocol-failed',
        'snapshot-owner-exited',
      ].includes(reason) &&
      !this.periodicFailed
    ) {
      this.periodicFailed = true;
      console.warn('[SQLITE_PERIODIC_SNAPSHOT_FAILED]');
    }
    this.reason = reason;
    const child = this.child;
    this.child = undefined;
    child?.stdin.end();
    child?.kill();
    this.issued.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(fallback(reason));
    }
    this.pending.clear();
  }

  /** Explicit internal maintenance API. No timer, route or delete operation. */
  async historyReview(
    operation:
      | 'history-review'
      | 'history-validate-approval'
      | 'history-pin'
      | 'history-unpin',
    payload: Record<string, unknown>,
  ) {
    if (
      process.env.SQLITE_ARTICLE_HISTORY_REVIEW_ENABLED !== '1' ||
      process.env.SQLITE_ARTICLE_HISTORY_MAINTENANCE_WINDOW !== '1' ||
      !this.historyRuntimePath ||
      !this.child
    )
      throw new Error('Article history maintenance disabled');
    // Loaded only after opt-in; never accepts caller-supplied recovery proofs.
    const runtime = require(this.historyRuntimePath);
    return runtime.withRuntimeReferences(
      {
        coordinator: sqliteWrites,
        activeBackupReferences: activeVerifiedBackupReferences,
        request: (op: string, args: Record<string, unknown>) =>
          runtime.exchange(this.child, op, args),
      },
      operation,
      payload,
    );
  }

  private request(operation: string, token?: string) {
    const child = this.child;
    if (!child || !child.stdin.writable)
      return Promise.resolve(fallback(this.reason));
    // No queue growth or stacked backup when the owner is busy with a snapshot.
    if (this.pending.size >= 16)
      return Promise.resolve(fallback('snapshot-owner-busy'));
    const id = ++this.id;
    return new Promise<FastInsertSnapshotHealth>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(fallback('snapshot-owner-busy-or-timeout'));
      }, 2000);
      this.pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ id, operation, token }) + '\n');
    });
  }

  /** Read only; never creates a backup or extends its own TTL. */
  async query() {
    if (!this.child || !this.databasePath || !this.nodeIdentity)
      return fallback(this.reason);
    try {
      const file = await stat(this.databasePath, { bigint: true });
      if (
        (await realpath(this.databasePath)) !== this.databasePath ||
        file.dev.toString() !== this.nodeIdentity[0] ||
        file.ino.toString() !== this.nodeIdentity[1]
      )
        throw new Error();
    } catch {
      this.stop('snapshot-database-identity-changed');
      return fallback(this.reason);
    }
    return this.request('query');
  }

  /** Must run INSIDE the insertion transaction, both before and after writes.
   * Failure must rollback the transaction then retry with the old full backup.
   * Caller must serialize DB replacement/migrations with the transaction.
   */
  async assertLease(
    transaction: RawTransaction,
    lease: FastInsertSnapshotLease,
  ) {
    if (
      this.issued.get(lease.token) !== lease ||
      lease.generation !== this.generation ||
      Date.now() >= lease.validUntilMs
    )
      throw new Error('SQLite snapshot lease invalid; full backup required');
    const files = await transaction.$queryRawUnsafe<
      Array<{ name: string; file: string }>
    >('PRAGMA database_list');
    const main = files.find((file) => file.name === 'main');
    if (!main || (await realpath(main.file)) !== lease.databasePath)
      throw new Error('SQLite database changed; full backup required');
    const file = await stat(lease.databasePath, { bigint: true });
    if (
      file.dev.toString() !== lease.databaseIdentity[0] ||
      file.ino.toString() !== lease.databaseIdentity[1]
    )
      throw new Error('SQLite database replaced; full backup required');
    const versions = await transaction.$queryRawUnsafe<
      Array<{ schema_version: number | bigint }>
    >('PRAGMA schema_version');
    const schema = await transaction.$queryRawUnsafe<
      Array<{
        type: string;
        name: string;
        tbl_name: string;
        sql: string | null;
      }>
    >('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name');
    const hash = createHash('sha256')
      .update(
        JSON.stringify(
          schema.map((row) => [row.type, row.name, row.tbl_name, row.sql]),
        ),
      )
      .digest('hex');
    const health = await this.request('validate', lease.token);
    if (
      Number(versions[0]?.schema_version) !== lease.schemaVersion ||
      hash !== lease.schemaSha256 ||
      !health.verified ||
      !health.fresh ||
      Date.now() >= lease.validUntilMs
    )
      throw new Error('SQLite snapshot lease expired; full backup required');
  }

  async markDirty(lease: FastInsertSnapshotLease) {
    // A missed signal is caught through persistent-connection data_version.
    // Do not start a full snapshot for each insert batch.
    if (this.issued.get(lease.token) !== lease) return;
    await this.request('dirty', lease.token);
    this.issued.delete(lease.token);
  }
}

const owner = new SqliteSnapshotGuard();
export const startSqliteSnapshotGuard = () => owner.start();
export const stopSqliteSnapshotGuard = () => owner.stop();
export const queryFastInsertSnapshotGuard = () => owner.query();
export const assertFastInsertSnapshotLease = (
  transaction: RawTransaction,
  lease: FastInsertSnapshotLease,
) => owner.assertLease(transaction, lease);
export const markFastInsertSnapshotDirty = (lease: FastInsertSnapshotLease) =>
  owner.markDirty(lease);

export const reviewArticleHistory = (sources: string[]) =>
  owner.historyReview('history-review', { sources });
export const validateArticleHistoryApproval = (
  plan: unknown,
  approval: unknown,
) => owner.historyReview('history-validate-approval', { plan, approval });
export const pinArticleHistoryReference = (token: string, path: string) =>
  owner.historyReview('history-pin', { token, path });
export const unpinArticleHistoryReference = (token: string) =>
  owner.historyReview('history-unpin', { token });

export async function recentVerifiedSqliteSnapshot(): Promise<InsertOnlySnapshot | null> {
  const health = await owner.query();
  if (!health.verified || !health.fresh || !health.lease) return null;
  const lease = health.lease;
  return {
    source: lease.databasePath,
    sha256: lease.snapshotSha256,
    verifiedAtMs: lease.backupSucceededAtMs,
    lease,
  };
}

export async function assertInsertOnlySnapshotPermit(
  transaction: RawTransaction,
  snapshot: InsertOnlySnapshot,
) {
  if (
    !snapshot.lease ||
    snapshot.source !== snapshot.lease.databasePath ||
    snapshot.sha256 !== snapshot.lease.snapshotSha256 ||
    snapshot.verifiedAtMs !== snapshot.lease.backupSucceededAtMs
  )
    throw new Error('SQLite snapshot permit invalid; full backup required');
  await owner.assertLease(transaction, snapshot.lease);
}

export const notifySqliteSnapshotDirty = (snapshot: InsertOnlySnapshot) =>
  owner.markDirty(snapshot.lease);
