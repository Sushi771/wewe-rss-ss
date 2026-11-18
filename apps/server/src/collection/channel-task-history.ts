import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { assertDatabaseWritesAllowed } from '../startup-audit';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { sqliteWrites } from './sqlite-write-coordinator';
import { readBatchHistoryReceipt } from './xhs-legacy-source-fence';
import {
  assertChannel,
  ChannelState,
  CollectionChannel,
  commitChannelState,
  configuredTaskDatabase,
  historyDigest,
  HistoryRef,
  readChannelState,
  withChannelLease,
} from './channel-task-control';

type RecordEntry = HistoryRef & { document: string; protection: boolean };
type Action = 'archive' | 'pause' | 'resume';
type Backup = {
  source: string;
  backup: string;
  sha256: string;
  integrityCheck: string;
  recoveryOrigin?: { format?: string; kind?: string };
};
const folders = [
  ['wechat-batch', '.wechat2rss-subscription-batches'],
  ['wechat-task', '.wechat2rss-subscription-tasks'],
  ['single-download', '.wechat2rss-single-downloads'],
  ['add-receipt', '.wechat2rss-add'],
  ['refresh-response', '.wechat2rss-refresh-responses'],
] as const;
const tables = [
  ['xhs-task', 'xhs_subscription_tasks', 'id'],
  ['xhs-batch', 'xhs_refresh_batches', 'id'],
  ['xhs-whole', 'xhs_whole_creator_jobs', 'id'],
  ['xhs-job', 'xhs_refresh_jobs', 'owner'],
] as const;
function validAction(action: unknown): asserts action is Action {
  if (action !== 'archive' && action !== 'pause' && action !== 'resume')
    throw Error('CHANNEL_ACTION_INVALID');
}
async function bounded(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 ** 2)
    throw Error('CHANNEL_HISTORY_INVALID');
  return fs.readFile(file, 'utf8');
}
/** Local inventory only. Original records and source fences are never edited. */
export class ChannelTaskHistory {
  constructor(
    private readonly db: Pick<PrismaClient, '$queryRaw' | '$queryRawUnsafe'>,
    private readonly database: () => string = configuredTaskDatabase,
    private readonly backup?: () => Promise<unknown>,
    private readonly writeAllowed: () => void = assertDatabaseWritesAllowed,
  ) {}
  async inventory(channel: CollectionChannel): Promise<RecordEntry[]> {
    assertChannel(channel);
    const result: RecordEntry[] = [];
    if (channel === 'wechat') {
      const root = path.dirname(await fs.realpath(this.database()));
      for (const [kind, name] of folders) {
        const folder = path.join(root, name);
        try {
          const stat = await fs.lstat(folder);
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            (await fs.realpath(folder)) !== folder
          )
            throw Error('CHANNEL_HISTORY_INVALID');
          const names = (await fs.readdir(folder))
            .filter((n) => n.endsWith('.json'))
            .sort();
          if (names.length > 4000) throw Error('CHANNEL_HISTORY_LIMIT');
          for (const filename of names) {
            const id = filename.slice(0, -5);
            if (!/^[A-Za-z0-9:_-]{1,180}$/.test(id))
              throw Error('CHANNEL_HISTORY_INVALID');
            const document = await bounded(path.join(folder, filename));
            const value = JSON.parse(document);
            result.push({
              kind,
              id,
              document,
              digest: historyDigest(document),
              protection:
                /unknown|attempted|submitting|running|waiting|queued|pending|blocked|reserved/.test(
                  String(value.state),
                ) ||
                (Array.isArray(value.items) &&
                  value.items.some(
                    (i: any) => i.submissionUnknown || i.accepted,
                  )),
            });
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
      const mediaFile = path.join(
        root,
        '.wechat2rss-automatic-media',
        'queue.json',
      );
      try {
        const value = JSON.parse(await bounded(mediaFile));
        if (!Array.isArray(value.articles) || value.articles.length > 10000)
          throw Error('CHANNEL_HISTORY_INVALID');
        for (const article of value.articles) {
          if (
            typeof article.id !== 'string' ||
            !/^[A-Za-z0-9:_-]{1,180}$/.test(article.id)
          )
            throw Error('CHANNEL_HISTORY_INVALID');
          const document = JSON.stringify(article);
          result.push({
            kind: 'automatic-media',
            id: article.id,
            document,
            digest: historyDigest(document),
            protection: true,
          });
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    } else {
      for (const [kind, table, key] of tables) {
        const exists = await this.db.$queryRawUnsafe<any[]>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          table,
        );
        if (!exists.length) continue;
        // All identifiers are fixed source constants; values never construct SQL.
        const rows = await this.db.$queryRawUnsafe<any[]>(
          `SELECT * FROM ${table} ORDER BY ${key}`,
        );
        if (rows.length > 10000) throw Error('CHANNEL_HISTORY_LIMIT');
        for (const row of rows) {
          const id = row[key];
          if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,180}$/.test(id))
            throw Error('CHANNEL_HISTORY_INVALID');
          const document = JSON.stringify(row, (_, v) =>
            typeof v === 'bigint' ? String(v) : v,
          );
          result.push({
            kind,
            id,
            document,
            digest: historyDigest(document),
            protection: [
              'unknown',
              'started',
              'running',
              'reserved',
              'queued',
              'blocked',
            ].includes(row.state),
          });
        }
      }
    }
    return result.sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
    );
  }
  private async observedSingleListBatch(id: string) {
    try {
      const items = await this.db.$queryRaw<
        Array<{
          creator_id: string;
          operation_id: string | null;
          state: string;
          outcome: string | null;
        }>
      >`SELECT creator_id,operation_id,state,outcome FROM xhs_refresh_batch_items WHERE batch_id=${id} LIMIT 2`;
      if (items.length !== 1) return;
      const [item] = items;
      if (
        item.state !== 'reserved' ||
        !item.operation_id ||
        item.outcome !== null
      )
        return;
      const receipt = await readBatchHistoryReceipt(
        this.db,
        id,
        item.creator_id,
        item.operation_id,
      );
      if (receipt) return { id, item, receipt };
    } catch {
      // Older schemas and malformed evidence keep the existing resume fence.
    }
  }
  private async plan(channel: CollectionChannel, action: Action) {
    const state = await readChannelState(channel, this.database());
    const records = await this.inventory(channel);
    const refs = records.map(({ kind, id, digest }) => ({ kind, id, digest }));
    const visible = refs.filter(
      (r) => !state.archived.some((a) => a.kind === r.kind && a.id === r.id),
    );
    const observedBatchDigests: string[] = [];
    if (channel === 'xiaohongshu' && action === 'resume') {
      for (const record of records) {
        if (record.kind !== 'xhs-batch' || !record.protection) continue;
        const proof = await this.observedSingleListBatch(record.id);
        if (!proof) continue;
        // Allow the ordinary batch entry to mirror its terminal receipt after
        // resume. The source fence still blocks until that mirror is committed.
        record.protection = false;
        observedBatchDigests.push(historyDigest(proof));
      }
    }
    const retainedEvidence: Array<{ table: string; rows: unknown[] }> = [];
    let retainedUnknownCount = 0;
    for (const table of channel === 'wechat'
      ? ['refresh_submission_claims', 'Wechat2RssSourceGate']
      : [
          'xhs_unbound_owner_requests',
          'xhs_limited_recovery',
          'xhs_source_risk',
          'xhs_request_budgets',
        ]) {
      const exists = await this.db.$queryRawUnsafe<any[]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        table,
      );
      if (!exists.length) continue;
      const rows = await this.db.$queryRawUnsafe<Array<{ state?: string }>>(
        `SELECT * FROM ${table}`,
      );
      if (rows.length > 100000) throw Error('CHANNEL_HISTORY_LIMIT');
      retainedUnknownCount += rows.filter((r) =>
        ['unknown', 'started', 'attempted'].includes(r.state || ''),
      ).length;
      retainedEvidence.push({ table, rows });
    }
    return {
      state,
      records,
      visible,
      retainedEvidence,
      retainedUnknownCount,
      digest: historyDigest({
        channel,
        action,
        state,
        refs,
        retainedEvidence,
        ...(observedBatchDigests.length ? { observedBatchDigests } : {}),
      }),
    };
  }
  async preview(channel: CollectionChannel, action: Action) {
    assertChannel(channel);
    validAction(action);
    return withChannelLease(
      channel,
      async () => {
        const plan = await this.plan(channel, action);
        return {
          channel,
          action,
          digest: plan.digest,
          revision: plan.state.revision,
          paused: plan.state.paused,
          visibleCount: plan.visible.length,
          archiveCount: plan.state.archived.length,
          protectionCount: plan.records.filter((r) => r.protection).length,
          retainedUnknownCount: plan.retainedUnknownCount,
          records: plan.visible,
          decision: 'archive-and-isolate-retain-originals' as const,
          sourceRequests: 0 as const,
        };
      },
      this.database(),
    );
  }
  async status(channel: CollectionChannel) {
    assertChannel(channel);
    const state = await readChannelState(channel, this.database());
    return {
      channel,
      paused: state.paused,
      revision: state.revision,
      archivedCount: state.archived.length,
      globalRecoveryHeld: process.env.WECHAT2RSS_RECOVERY_HOLD === '1',
    };
  }
  async confirm(input: {
    channel: CollectionChannel;
    action: Action;
    digest: string;
    acknowledged: true;
  }) {
    assertChannel(input.channel);
    validAction(input.action);
    if (input.acknowledged !== true || !/^[a-f0-9]{64}$/.test(input.digest))
      throw Error('CHANNEL_CONFIRM_INVALID');
    this.writeAllowed();
    return withChannelLease(
      input.channel,
      async () => {
        let plan = await this.plan(input.channel, input.action);
        if (plan.state.receipts.some((r) => r.digest === input.digest))
          return {
            alreadyApplied: true,
            ...(await this.status(input.channel)),
          };
        if (plan.digest !== input.digest)
          throw Error('CHANNEL_PREVIEW_CHANGED');
        if (
          input.action === 'resume' &&
          input.channel === 'wechat' &&
          process.env.WEWE_MANAGED_RUNTIME_MODE === 'manual-xhs-v1'
        )
          throw Error('CHANNEL_MANAGED_WECHAT_PAUSED');
        if (
          input.action === 'resume' &&
          process.env.WECHAT2RSS_RECOVERY_HOLD === '1'
        )
          throw Error('CHANNEL_GLOBAL_RECOVERY_HELD');
        if (
          input.action === 'resume' &&
          plan.records.some(
            (r) =>
              r.protection &&
              plan.visible.some((v) => v.kind === r.kind && v.id === r.id),
          )
        )
          throw Error('CHANNEL_ACTIVE_HISTORY_REVIEW_REQUIRED');
        let backupSha256 = '';
        let sourceVersion = '';
        const fingerprint = async () =>
          JSON.stringify(
            await Promise.all(
              [
                this.database(),
                this.database() + '-wal',
                this.database() + '-journal',
              ].map(async (file) => {
                try {
                  const s = await fs.stat(file, { bigint: true });
                  if (!s.isFile() || !s.ino)
                    throw Error('CHANNEL_DATABASE_CHANGED');
                  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(
                    String,
                  );
                } catch (e) {
                  if (
                    (e as NodeJS.ErrnoException).code === 'ENOENT' &&
                    file !== this.database()
                  )
                    return null;
                  throw e;
                }
              }),
            ),
          );
        await sqliteWrites.protectedWrite(
          async () => {
            this.writeAllowed();
            sourceVersion = await fingerprint();
            const report = (await (this.backup
              ? this.backup()
              : createVerifiedSqliteBackup())) as Backup;
            if (
              !report ||
              typeof report.source !== 'string' ||
              typeof report.backup !== 'string' ||
              (await fs.realpath(report.source)) !==
                (await fs.realpath(this.database())) ||
              (await fs.realpath(report.backup)) ===
                (await fs.realpath(this.database())) ||
              !/^[a-f0-9]{64}$/.test(report.sha256 || '') ||
              report.integrityCheck !== 'ok' ||
              report.recoveryOrigin?.format !== 'sqlite-recovery-origin-v1' ||
              report.recoveryOrigin.kind !== 'protected'
            )
              throw Error('CHANNEL_BACKUP_REQUIRED');
            const bytes = await fs.readFile(report.backup);
            if (
              createHash('sha256').update(bytes).digest('hex') !== report.sha256
            )
              throw Error('CHANNEL_BACKUP_REQUIRED');
            backupSha256 = report.sha256;
            // Retain exact file-backed tasks and channel state alongside this verified
            // recovery point. No task/source evidence is removed or rewritten.
            const snapshot = JSON.stringify(
              {
                version: 1,
                channel: input.channel,
                digest: input.digest,
                state: plan.state,
                records: plan.records,
                retainedEvidence: plan.retainedEvidence,
              },
              (_, v) => (typeof v === 'bigint' ? String(v) : v),
            );
            const sidecar = path.join(
              path.dirname(await fs.realpath(report.backup)),
              `channel-history-${input.channel}-${input.digest}.json`,
            );
            try {
              const handle = await fs.open(sidecar, 'wx', 0o600);
              try {
                await handle.writeFile(snapshot);
                await handle.sync();
              } finally {
                await handle.close();
              }
            } catch (e) {
              if (
                (e as NodeJS.ErrnoException).code !== 'EEXIST' ||
                (await bounded(sidecar)) !== snapshot
              )
                throw e;
            }
          },
          async () => {
            this.writeAllowed();
            if ((await fingerprint()) !== sourceVersion)
              throw Error('CHANNEL_DATABASE_CHANGED');
            const current = await this.plan(input.channel, input.action);
            if (current.digest !== input.digest)
              throw Error('CHANNEL_PREVIEW_CHANGED');
            plan = current;
            const next: ChannelState = {
              ...plan.state,
              revision: plan.state.revision + 1,
              // Clearing history also stops this channel. Resume is a separate review.
              paused: input.action !== 'resume',
              archived:
                input.action === 'archive'
                  ? [...plan.state.archived, ...plan.visible]
                  : plan.state.archived,
              receipts: [
                ...plan.state.receipts,
                { digest: input.digest, backupSha256, at: Date.now() },
              ],
            };
            if (next.archived.length > 20000 || next.receipts.length > 1000)
              throw Error('CHANNEL_HISTORY_LIMIT');
            await commitChannelState(input.channel, next, this.database());
          },
        );
        return { alreadyApplied: false, ...(await this.status(input.channel)) };
      },
      this.database(),
    );
  }
}
