import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import {
  prepareLegacyPendingReview,
  confirmLegacyPendingReview,
} from './xhs-legacy-pending-review';
import { hasTaskDetailUnknown } from './xhs-task-source-fence';
import { PrismaService } from '../prisma/prisma.service';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import * as sqliteBackup from './sqlite-backup';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { bindXhsSourceTotalBudget } from './xhs-source-request-policy';

describe('legacy unbound pending review on isolated SQLite', () => {
  let db: PrismaClient, dir: string;
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    creator = 'synthetic-creator',
    note = 'synthetic-note',
    key = JSON.stringify(['xiaohongshu', 'note', note]);
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-legacy-pending-'));
    db = new PrismaClient({
      datasources: {
        db: {
          url: 'file:' + path.join(dir, 'synthetic.sqlite').replace(/\\/g, '/'),
        },
      },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      for (const sql of splitSqliteStatements(
        await fs.readFile(path.join(migrations, name, 'migration.sql'), 'utf8'),
      ))
        await db.$executeRawUnsafe(sql);
    }
  }, 40000);
  beforeEach(async () => {
    await db.$executeRaw`DELETE FROM xhs_subscription_tasks`;
    await db.$executeRaw`DELETE FROM xhs_request_budgets`;
    await db.xhsNote.deleteMany();
    await db.xhsCreator.deleteMany();
    await db.xhsCreator.create({
      data: {
        id: creator,
        externalAuthorId: 'synthetic-author',
        profileUrl: 'https://example.invalid/author',
        displayName: 'Synthetic',
      },
    });
    await db.xhsNote.create({
      data: {
        id: key,
        creatorId: creator,
        title: 'Synthetic',
        publishTime: 1,
        kind: 'image-text',
        status: 'listed',
      },
    });
    await db.$executeRaw`UPDATE xhs_source_risk SET state='pending',owner=${owner},code=NULL,http_status=NULL,endpoint=NULL,updated_at=100 WHERE id='source'`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,17,0,1000)`;
    const doc = {
      taskId: 'synthetic-task',
      creatorId: creator,
      state: 'partial',
      noteIds: [key],
      sourceFailures: {
        [key]: {
          phase: 'detail',
          code: 'XHS_STORAGE_FAILED',
          guardStage: 'source-admission',
          guardCode: 'P2028',
          dispatched: false,
        },
      },
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('synthetic-task',${creator},'partial',${JSON.stringify(doc)},200)`;
  });
  afterAll(async () => {
    await db.$disconnect();
    await fs.rm(dir, { recursive: true, force: true });
  }, 40000);
  it('preserves unbound owner and budget while atomically fencing the known note', async () => {
    const preview = await db.$transaction((tx) =>
      prepareLegacyPendingReview(tx),
    );
    expect(preview).toMatchObject({
      kind: 'legacy-pending',
      taskId: 'synthetic-task',
      noteKey: key,
    });
    await db.$transaction((tx) =>
      confirmLegacyPendingReview(
        tx,
        {
          digest: preview.digest,
          acknowledgedUnknownScope: true,
          backupSha256: 'a'.repeat(64),
        },
        300,
      ),
    );
    const risk = (
      await db.$queryRaw<
        any[]
      >`SELECT state,owner,code FROM xhs_source_risk WHERE id='source'`
    )[0];
    expect(risk).toEqual({ state: 'clear', owner: null, code: null });
    const saved = JSON.parse(
      (
        await db.$queryRaw<
          any[]
        >`SELECT document FROM xhs_subscription_tasks WHERE id='synthetic-task'`
      )[0].document,
    );
    expect(saved.legacyPendingReviews[0]).toMatchObject({
      ownerBinding: 'unproved',
      riskSnapshot: { owner, state: 'pending' },
      backupSha256: 'a'.repeat(64),
      acknowledgedUnknownScope: true,
    });
    expect(saved.sourceUnknowns[0]).toMatchObject({
      outcome: 'unknown',
      ownerBinding: 'unproved',
      provenance: 'legacy-pending-conservative-exclusion',
    });
    expect(await hasTaskDetailUnknown(db as any, creator, note)).toBe(true);
    expect(
      Number(
        (
          await db.$queryRaw<
            any[]
          >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`
        )[0].used,
      ),
    ).toBe(17);
    await expect(
      db.$transaction((tx) =>
        confirmLegacyPendingReview(
          tx,
          {
            digest: preview.digest,
            acknowledgedUnknownScope: true,
            backupSha256: 'a'.repeat(64),
          },
          301,
        ),
      ),
    ).rejects.toThrow();
  });
  it('allows an unrelated account while retaining the excluded target fence', async () => {
    const preview = await db.$transaction((tx) =>
      prepareLegacyPendingReview(tx),
    );
    await db.$transaction((tx) =>
      confirmLegacyPendingReview(
        tx,
        {
          digest: preview.digest,
          acknowledgedUnknownScope: true,
          backupSha256: 'a'.repeat(64),
        },
        300,
      ),
    );
    await db.xhsCreator.create({
      data: {
        id: 'other-creator',
        externalAuthorId: 'other-author',
        profileUrl: 'https://example.invalid/other',
        displayName: 'Other',
      },
    });
    const task = {
      taskId: 'other-task',
      creatorId: 'other-creator',
      state: 'running',
      noteIds: [],
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('other-task','other-creator','running',${JSON.stringify(task)},400)`;
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: {
        success: true,
        code: 0,
        data: { notes: [], has_more: false, cursor: '' },
      },
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    try {
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      (runtime as any).adapter.restoreDefaultAuthorAccess('other-author');
      await runtime.withTaskScope(
        { taskId: 'other-task', creatorId: 'other-creator' },
        () => runtime.list('other-author', null),
      );
      expect(api).toHaveBeenCalledTimes(1);
      expect(await hasTaskDetailUnknown(db as any, creator, note)).toBe(true);
    } finally {
      runtime.onModuleDestroy();
    }
  });
  it('rolls back all changes when confirmation transaction fails', async () => {
    const preview = await db.$transaction((tx) =>
      prepareLegacyPendingReview(tx),
    );
    await expect(
      db.$transaction(async (tx) => {
        await confirmLegacyPendingReview(
          tx,
          {
            digest: preview.digest,
            acknowledgedUnknownScope: true,
            backupSha256: 'a'.repeat(64),
          },
          300,
        );
        throw Error('synthetic rollback');
      }),
    ).rejects.toThrow('synthetic rollback');
    expect(
      (
        await db.$queryRaw<
          any[]
        >`SELECT state,owner FROM xhs_source_risk WHERE id='source'`
      )[0],
    ).toEqual({ state: 'pending', owner });
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`,
    ).toHaveLength(0);
    expect(await hasTaskDetailUnknown(db as any, creator, note)).toBe(false);
  });
  it('rejects a changed snapshot without modifying the owner or creating a marker', async () => {
    const preview = await db.$transaction((tx) =>
      prepareLegacyPendingReview(tx),
    );
    await db.$executeRaw`UPDATE xhs_request_budgets SET used=18 WHERE id='xhs:source-total'`;
    await expect(
      db.$transaction((tx) =>
        confirmLegacyPendingReview(
          tx,
          {
            digest: preview.digest,
            acknowledgedUnknownScope: true,
            backupSha256: 'a'.repeat(64),
          },
          300,
        ),
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.$queryRaw<
          any[]
        >`SELECT state,owner FROM xhs_source_risk WHERE id='source'`
      )[0],
    ).toEqual({ state: 'pending', owner });
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`,
    ).toHaveLength(0);
  });
  it.each([
    'active-task',
    'owner-bound',
    'unpaired-marker',
    'provider-restriction',
  ] as const)('refuses %s instead of bypassing it', async (mode) => {
    if (mode === 'active-task')
      await db.$executeRaw`UPDATE xhs_subscription_tasks SET state='running' WHERE id='synthetic-task'`;
    if (mode === 'owner-bound') {
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id='synthetic-task'`;
      const task = JSON.parse(rows[0].document);
      task.sourceActive = { owner };
      await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(task)} WHERE id='synthetic-task'`;
    }
    if (mode === 'unpaired-marker')
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:dispatch-pending:unpaired',1,1,0,0)`;
    if (mode === 'provider-restriction') {
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id='synthetic-task'`;
      const task = JSON.parse(rows[0].document);
      task.sourceReceipt = { httpStatus: 461 };
      await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(task)} WHERE id='synthetic-task'`;
    }
    await expect(
      db.$transaction((tx) => prepareLegacyPendingReview(tx)),
    ).rejects.toThrow();
    expect(
      (
        await db.$queryRaw<
          any[]
        >`SELECT state,owner FROM xhs_source_risk WHERE id='source'`
      )[0],
    ).toEqual({ state: 'pending', owner });
  });
  it('creates a verified backup before service confirmation and rejects an active session', async () => {
    const names = [
        'DATABASE_URL',
        'SQLITE_BACKUP_KIND',
        'SQLITE_TEST_BACKUP_ROOT',
      ] as const,
      old = Object.fromEntries(names.map((name) => [name, process.env[name]])),
      api = Symbol.for('wewe.project-writer-api.v1'),
      oldApi = (globalThis as any)[api];
    process.env.DATABASE_URL =
      'file:' + path.join(dir, 'synthetic.sqlite').replace(/\\/g, '/');
    process.env.SQLITE_BACKUP_KIND = 'test';
    process.env.SQLITE_TEST_BACKUP_ROOT = path.join(dir, 'backup');
    (globalThis as any)[api] = { writerForUrl: () => ({ check() {} }) };
    const actual = new PrismaService();
    let active = false,
      restricted = false;
    const subscriptions = { hasLocalSourceWork: () => false },
      runtime = {
        hasActiveSourceSessions: () => active,
        hasBlockingSourceState: () => restricted,
        refreshAfterHistoryHandoff: jest.fn(async () => {}),
      };
    const service = new XhsWholeCreatorService(
      actual,
      subscriptions as any,
      runtime as any,
      {} as any,
    );
    try {
      restricted = true;
      await expect(service.prepareLegacyPendingOwnerReview()).rejects.toThrow();
      restricted = false;
      const preview = await service.prepareLegacyPendingOwnerReview();
      active = true;
      await expect(
        service.confirmLegacyPendingOwnerReview({
          digest: preview.digest,
          acknowledgedUnknownScope: true,
        }),
      ).rejects.toThrow();
      expect(
        (
          await db.$queryRaw<
            any[]
          >`SELECT state FROM xhs_source_risk WHERE id='source'`
        )[0].state,
      ).toBe('pending');
      active = false;
      const failedBackup = jest
        .spyOn(sqliteBackup, 'createVerifiedSqliteBackup')
        .mockRejectedValueOnce(Error('synthetic-backup-failure'));
      try {
        await expect(
          service.confirmLegacyPendingOwnerReview({
            digest: preview.digest,
            acknowledgedUnknownScope: true,
          }),
        ).rejects.toThrow();
        expect(
          (
            await db.$queryRaw<
              any[]
            >`SELECT state,owner FROM xhs_source_risk WHERE id='source'`
          )[0],
        ).toEqual({ state: 'pending', owner });
        expect(
          await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`,
        ).toHaveLength(0);
      } finally {
        failedBackup.mockRestore();
      }
      expect(
        await service.confirmLegacyPendingOwnerReview({
          digest: preview.digest,
          acknowledgedUnknownScope: true,
        }),
      ).toEqual({ state: 'confirmed', excludedCount: 1 });
      const dirs = (
        await fs.readdir(process.env.SQLITE_TEST_BACKUP_ROOT!)
      ).filter((n) => n.startsWith('before-collection-'));
      expect(dirs).toHaveLength(1);
      const backupFile = path.join(
        process.env.SQLITE_TEST_BACKUP_ROOT!,
        dirs[0],
        'wewe-rss.db',
      );
      const backup = new PrismaClient({
        datasources: { db: { url: 'file:' + backupFile.replace(/\\/g, '/') } },
      });
      try {
        expect(
          (
            await backup.$queryRaw<
              any[]
            >`SELECT state,owner FROM xhs_source_risk WHERE id='source'`
          )[0],
        ).toEqual({ state: 'pending', owner });
        expect(
          Number(
            (
              await backup.$queryRaw<
                any[]
              >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`
            )[0].used,
          ),
        ).toBe(17);
      } finally {
        await backup.$disconnect();
      }
      expect(runtime.refreshAfterHistoryHandoff).toHaveBeenCalledTimes(1);
    } finally {
      await actual.$disconnect();
      for (const name of names) {
        if (old[name] === undefined) delete process.env[name];
        else process.env[name] = old[name];
      }
      if (oldApi === undefined) delete (globalThis as any)[api];
      else (globalThis as any)[api] = oldApi;
    }
  }, 120000);
});
