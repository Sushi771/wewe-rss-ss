import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

type Report = {
  backup: string;
  sha256: string;
  source?: string;
  integrityCheck?: string;
  reused?: boolean;
  recoveryBoundary?: boolean;
  snapshotMatchesCurrentSource?: boolean;
};
type Boundary = {
  key: string;
  members: string[];
  expires: number;
  running: number;
  closing: boolean;
  pending?: Promise<Report>;
  report?: Report;
  database?: string;
  root?: string;
  sourceIdentity?: string;
  reference?: string;
  referenceBytes?: Buffer;
  referenceIdentity?: string;
  timer?: NodeJS.Timeout;
};
const fileIdentity = (s: { dev: bigint; ino: bigint }) => `${s.dev}/${s.ino}`;

/** A before-round recovery boundary, never a claim that changed DB content equals it. */
export class RefreshRecoveryBoundaries {
  private records = new Map<string, Boundary>();
  private context = new AsyncLocalStorage<{
    boundary: Boundary;
    active: boolean;
  }>();
  constructor(
    private now = Date.now,
    private ageMs = 900000,
    private maximum = 4,
  ) {
    if (
      !Number.isSafeInteger(ageMs) ||
      ageMs < 1000 ||
      ageMs > 900000 ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 4
    )
      throw new Error('Invalid recovery boundary bounds');
  }
  async run<T>(
    key: string,
    members: string[],
    feed: string,
    operation: () => Promise<T>,
  ) {
    const sorted = [...new Set(members)].sort();
    if (
      !key ||
      key.length > 256 ||
      !sorted.length ||
      sorted.length > 1000 ||
      sorted.some((x) => !x || x.length > 128) ||
      !sorted.includes(feed)
    )
      throw new Error('Invalid refresh recovery scope');
    let boundary = this.records.get(key);
    if (boundary && (boundary.closing || boundary.expires <= this.now())) {
      if (boundary.running)
        throw new Error(
          'Expired recovery boundary still has an in-flight context',
        );
      await this.close(key);
      boundary = undefined;
    }
    if (!boundary) {
      if (this.records.size >= this.maximum)
        throw new Error('Refresh recovery boundary capacity requires review');
      boundary = {
        key,
        members: sorted,
        expires: this.now() + this.ageMs,
        running: 0,
        closing: false,
      };
      this.records.set(key, boundary);
      boundary.timer = setTimeout(
        () =>
          void this.close(key).catch(() =>
            console.warn('[REFRESH_RECOVERY_REFERENCE_REVIEW_REQUIRED]'),
          ),
        this.ageMs,
      );
      boundary.timer.unref();
    }
    if (JSON.stringify(boundary.members) !== JSON.stringify(sorted))
      throw new Error('Refresh recovery membership changed');
    const permit = { boundary, active: true };
    boundary.running++;
    try {
      return await this.context.run(permit, operation);
    } finally {
      permit.active = false;
      boundary.running--;
      // A mocked/non-SQLite callback establishes no recovery authorization.
      if (!boundary.report && !boundary.pending) boundary.closing = true;
      if (boundary.closing && boundary.running === 0)
        await this.remove(boundary);
    }
  }
  private async hash(file: string, expected: string) {
    const before = await fs.stat(file, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > 4n * 1024n ** 3n)
      throw new Error('Recovery file size unproved');
    const deadline = this.now() + 10000;
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    const handle = await fs.open(file, 'r');
    try {
      for (;;) {
        if (this.now() > deadline) throw new Error('Recovery hash deadline');
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        digest.update(buffer.subarray(0, bytesRead));
      }
      const after = await fs.stat(file, { bigint: true });
      if (
        [
          before.dev,
          before.ino,
          before.size,
          before.mtimeNs,
          before.ctimeNs,
        ].join('/') !==
          [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(
            '/',
          ) ||
        digest.digest('hex') !== expected
      )
        throw new Error('Recovery file changed or checksum unproved');
    } finally {
      await handle.close();
    }
  }
  async snapshot(
    database: string,
    root: string,
    create: () => Promise<Report>,
  ): Promise<Report> {
    const permit = this.context.getStore();
    if (
      !permit?.active ||
      permit.boundary.closing ||
      permit.boundary.expires <= this.now()
    )
      return create();
    const b = permit.boundary;
    const physical = await fs.realpath(root).catch(() => path.resolve(root));
    const sourceIdentity = fileIdentity(
      await fs.stat(database, { bigint: true }),
    );
    if (
      b.report &&
      (b.database !== database ||
        b.root !== physical ||
        b.sourceIdentity !== sourceIdentity)
    ) {
      b.closing = true;
      throw new Error('Refresh recovery source or root changed');
    }
    if (!b.report && !b.pending) {
      b.pending = (async () => {
        // Bound small live references. Orphan references from interrupted owners
        // remain protected and require review; no recovery DB is ever removed.
        const names = await fs.readdir(physical).catch(() => [] as string[]);
        if (
          names.filter((n) => n.startsWith('refresh-recovery-owner-')).length >=
          16
        )
          throw new Error('Recovery reference capacity requires review');
        const report = await create();
        const actualRoot = await fs.realpath(root);
        const backup = await fs.realpath(report.backup);
        const relative = path.relative(actualRoot, backup);
        if (
          report.source !== database ||
          report.integrityCheck !== 'ok' ||
          !/^[a-f0-9]{64}$/.test(report.sha256) ||
          !relative ||
          relative === '..' ||
          relative.startsWith('..' + path.sep) ||
          path.isAbsolute(relative)
        )
          throw new Error('Verified batch recovery boundary required');
        await this.hash(backup, report.sha256);
        const reference = path.join(
          actualRoot,
          `refresh-recovery-owner-${randomUUID()}.json`,
        );
        const encoded = Buffer.from(
          JSON.stringify({
            format: 'refresh-recovery-boundary-v1',
            batch: createHash('sha256').update(b.key).digest('hex'),
            batchId: b.key,
            backup,
            source: database,
            sha256: report.sha256,
            expiresAtEpoch: Math.floor(b.expires / 1000),
            preserveLiveReceipts: true,
            receiptsDirectory: path.join(
              path.dirname(database),
              '.wechat2rss-subscription-batches',
            ),
            recoveryScope:
              'database-before-round; reconcile live durable receipts before restore',
          }),
        );
        await fs.writeFile(reference, encoded, { flag: 'wx' });
        b.reference = reference;
        b.referenceBytes = encoded;
        b.referenceIdentity = fileIdentity(
          await fs.stat(reference, { bigint: true }),
        );
        b.database = database;
        b.root = actualRoot;
        b.sourceIdentity = sourceIdentity;
        b.report = { ...report, backup };
        return b.report;
      })();
    }
    try {
      const report = b.report || (await b.pending!);
      if (!permit.active || b.closing || b.expires <= this.now())
        throw new Error('Refresh recovery boundary expired before write');
      if (
        b.database !== database ||
        b.root !== physical ||
        b.sourceIdentity !== sourceIdentity
      )
        throw new Error('Refresh recovery source changed');
      // Every shared use proves the recovery FILE. It intentionally does not
      // compare the now-changed live database to the before-round snapshot.
      await this.hash(report.backup, report.sha256);
      if (
        b.closing ||
        b.expires <= this.now() ||
        fileIdentity(await fs.stat(database, { bigint: true })) !==
          b.sourceIdentity
      )
        throw new Error('Refresh recovery boundary expired or source replaced');
      return {
        ...report,
        reused: false,
        recoveryBoundary: true,
        snapshotMatchesCurrentSource: false,
      };
    } catch (error) {
      b.closing = true;
      throw error;
    } finally {
      b.pending = undefined;
    }
  }
  async close(key: string) {
    const b = this.records.get(key);
    if (!b) return;
    b.closing = true;
    if (!b.running) await this.remove(b);
  }
  private async remove(b: Boundary) {
    if (b.timer) clearTimeout(b.timer);
    if (b.reference) {
      try {
        const stat = await fs.lstat(b.reference, { bigint: true });
        if (
          stat.isSymbolicLink() ||
          fileIdentity(stat) !== b.referenceIdentity ||
          !(await fs.readFile(b.reference)).equals(b.referenceBytes!)
        )
          throw new Error('Recovery reference ownership changed');
        await fs.unlink(b.reference); // Only this in-memory owner's small reference JSON.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          console.warn('[REFRESH_RECOVERY_REFERENCE_REVIEW_REQUIRED]');
      }
    }
    if (this.records.get(b.key) === b) this.records.delete(b.key);
  }
}
export const refreshRecovery = new RefreshRecoveryBoundaries();
