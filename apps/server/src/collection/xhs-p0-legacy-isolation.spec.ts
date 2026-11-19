import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { admitScheduledXhs, scheduledTaskId } from './xhs-scheduled-admission';
import {
  XhsScheduledRunner,
  XHS_SCHEDULE_UNSENT,
} from './xhs-scheduled-runner';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { applyFixtureMigrations } from '../../test/redbook-isolated/fixture-migrations';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
jest.setTimeout(60000);

it.each([
  'valid',
  'missing-state',
  'malformed',
  'same-target-corrupt',
  'batch',
] as const)(
  'preserves old rows and handles synthetic legacy %s safely',
  async (mode) => {
    const root = await fs.mkdtemp(
        path.join(tmpdir(), 'redbook-legacy-fixture-'),
      ),
      file = path.join(root, 'fixture.sqlite');
    const db = new PrismaClient({
      datasources: { db: { url: 'file:' + file.replace(/\\/g, '/') } },
    });
    const rows = async (sql: string, ...params: unknown[]) =>
      db.$queryRawUnsafe<any[]>(sql, ...params);
    const snapshot = async (t: string) =>
      JSON.stringify(
        await rows(`SELECT * FROM ${t} ORDER BY id`),
        (_key, value) => (typeof value === 'bigint' ? Number(value) : value),
      );
    try {
      await applyFixtureMigrations('file:' + file.replace(/\\/g, '/'));
      for (const sql of splitSqliteStatements(
        "INSERT INTO feeds(id,mp_name,mp_cover,mp_intro,update_time) VALUES('old-feed','old name','cover','intro',123); INSERT INTO articles(id,mp_id,title,pic_url,publish_time,content_html) VALUES('old-article','old-feed','old title','pic',456,'old body'); INSERT INTO xhs_creators(id,profile_url,display_name,external_author_id,enabled) VALUES('old-creator','https://example.invalid/old','old creator','old-author',1),('new-creator','https://example.invalid/new','new creator','new-author',1); INSERT INTO xhs_notes(id,creator_id,title,publish_time,status,content_html) VALUES('old-note','old-creator','old note',789,'complete','old note body');",
      ))
        await db.$executeRawUnsafe(sql);
      const id =
          mode === 'batch'
            ? 'batch:synthetic'
            : mode === 'same-target-corrupt'
              ? scheduledTaskId('2026-10-31/09:15', 'new-creator', 'basic')
              : 'legacy-old',
        creator =
          mode === 'batch'
            ? '__batch__'
            : mode === 'same-target-corrupt'
              ? 'new-creator'
              : 'old-creator',
        state = mode === 'batch' ? 'batch_completed' : 'completed';
      const document =
        mode === 'malformed' || mode === 'same-target-corrupt'
          ? '{broken'
          : mode === 'batch'
            ? JSON.stringify({ batchId: 'synthetic', state: 'completed' })
            : JSON.stringify({
                taskId: id,
                creatorId: creator,
                ...(mode === 'missing-state' ? {} : { state }),
              });
      await db.$executeRawUnsafe(
        'INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(?,?,?,?,1)',
        id,
        creator,
        state,
        document,
      );
      const before = await Promise.all(
        ['feeds', 'articles', 'xhs_creators', 'xhs_notes'].map(snapshot),
      );
      const round = '2026-10-31/09:15',
        creatorId = 'new-creator',
        taskId = scheduledTaskId(round, creatorId, 'basic');
      const task = { taskId, creatorId, state: 'queued', noteIds: [] };
      const admission = db.$transaction((tx) =>
        admitScheduledXhs(tx as any, {
          round,
          creatorId,
          phase: 'basic',
          task,
          now: 1700000000000,
        }),
      );
      if (mode === 'same-target-corrupt') {
        const result = await admission;
        expect(result).toMatchObject({
          kind: 'blocked',
          reason: 'XHS_SCHEDULE_SOURCE_BLOCKED',
        });
        expect(
          (
            await rows(
              'SELECT document FROM xhs_subscription_tasks WHERE id=?',
              taskId,
            )
          )[0].document,
        ).toBe('{broken');
        const taskReader = jest.fn(() => {
          throw Error('CORRUPT_TASK_MUST_NOT_BE_READ');
        });
        const service: any = new XhsSubscriptionService(db as any, {} as any);
        service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
        const visible = await service.scheduleCreatorPhase({
          round,
          creatorId,
          phase: 'basic',
        });
        expect(visible).toMatchObject({
          taskId,
          state: 'blocked',
          code: 'XHS_SCHEDULE_SOURCE_BLOCKED',
          message: '本地任务记录无法核验，本轮已停止，请先检查任务状态。',
        });
        await expect(service.task({ taskId })).rejects.toMatchObject({
          code: 'CONFLICT',
          message: '本地任务记录损坏，更新已停止；请先检查本地任务状态。',
        });
        const runner = new XhsScheduledRunner(
          { xhsCreator: { findMany: async () => [{ id: creatorId }] } },
          {
            scheduleCreatorPhase: service.scheduleCreatorPhase.bind(service),
            task: taskReader,
          },
        );
        await expect(runner.run(round)).rejects.toThrow(
          'XHS_SCHEDULE_SOURCE_BLOCKED',
        );
        expect(taskReader).not.toHaveBeenCalled();
      } else if (mode === 'malformed') {
        const result = await admission;
        expect(result).toMatchObject({
          kind: 'blocked',
          reason: 'XHS_SCHEDULE_SOURCE_BLOCKED',
        });
        const receipt = (
          await rows(
            'SELECT state,document FROM xhs_subscription_tasks WHERE id=?',
            taskId,
          )
        )[0];
        expect(receipt.state).toBe('blocked');
        expect(JSON.parse(receipt.document)).toMatchObject({
          state: 'blocked',
          code: 'XHS_SCHEDULE_SOURCE_BLOCKED',
        });
        expect(receipt.document).not.toContain('{broken');
      } else {
        const result = await admission;
        expect(result.kind).toBe(
          mode === 'valid' || mode === 'batch' ? 'created' : 'blocked',
        );
        if (mode === 'missing-state')
          expect(result.reason).toBe('XHS_SCHEDULE_SOURCE_BLOCKED');
      }
      const after = await Promise.all(
        ['feeds', 'articles', 'xhs_creators', 'xhs_notes'].map(snapshot),
      );
      expect(after).toEqual(before);
      expect(
        (
          await rows(
            'SELECT document FROM xhs_subscription_tasks WHERE id=?',
            id,
          )
        )[0].document,
      ).toBe(document);
    } finally {
      await db.$disconnect();
    }
  },
);

it('a stuck creator-local task cannot delay another managed subscription or bypass a shared owner', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'redbook-creator-lane-'));
  const url = 'file:' + path.join(root, 'fixture.sqlite').replace(/\\/g, '/');
  const db = new PrismaClient({ datasources: { db: { url } } });
  const env = jest.replaceProperty(process, 'env', {
    ...process.env,
    WEWE_MANAGED_RUNTIME_MODE: 'scheduled-dual-v1',
    WECHAT2RSS_RECOVERY_HOLD: '0',
  });
  try {
    await applyFixtureMigrations(url);
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_creators(id,profile_url,display_name,external_author_id,enabled) VALUES('a','https://example.invalid/a','a','author-a',1),('b','https://example.invalid/b','b','author-b',1)",
    );
    const service: any = new XhsSubscriptionService(db as any, {} as any);
    service.write = (_bytes: number, fn: any) => db.$transaction(fn);
    // The manual lane never resolves. Its local archive has no source owner.
    service.lane = new Promise<void>(() => {});
    service.pending.set('archive-a', {
      creatorId: 'a',
      taskId: 'archive-a',
      state: 'partial',
    });
    let complete: () => void;
    const settled = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const run = jest
      .spyOn(service, 'run')
      .mockImplementation(async (task: any) => {
        await db.$executeRaw`UPDATE xhs_subscription_tasks SET state='completed',document=${JSON.stringify({ ...task, state: 'completed' })} WHERE id=${task.taskId}`;
        service.pending.delete(task.taskId);
        complete();
      });
    const runner = new XhsScheduledRunner(
      { xhsCreator: { findMany: async () => [{ id: 'a' }, { id: 'b' }] } },
      service,
      undefined,
      undefined,
      true,
    );
    const round = '2026-10-31/09:15';
    await expect(runner.run(round)).rejects.toThrow(
      'XHS_SCHEDULE_TASK_PENDING',
    );
    await settled;
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ creatorId: 'b' });
    await expect(runner.run(round)).rejects.toThrow(
      'XHS_SCHEDULE_TASK_PENDING',
    );
    expect(run).toHaveBeenCalledTimes(1);

    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='pending',owner='fixture-live-owner' WHERE id='source'",
    );
    await expect(runner.run('2026-10-31/14:00')).rejects.toThrow(
      'XHS_SCHEDULE_TASK_PENDING',
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      await db.$queryRawUnsafe('SELECT state,owner FROM xhs_source_risk'),
    ).toEqual([{ state: 'pending', owner: 'fixture-live-owner' }]);
  } finally {
    env.restore();
    await db.$disconnect();
  }
});

function latch() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

async function isolatedManagedCreators(
  work: (
    db: PrismaClient,
    service: XhsSubscriptionService,
    runner: XhsScheduledRunner,
  ) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'redbook-managed-local-'));
  const url = 'file:' + path.join(root, 'fixture.sqlite').replace(/\\/g, '/');
  const db = new PrismaClient({ datasources: { db: { url } } });
  const env = jest.replaceProperty(process, 'env', {
    ...process.env,
    WEWE_MANAGED_RUNTIME_MODE: 'scheduled-dual-v1',
    WECHAT2RSS_RECOVERY_HOLD: '0',
  });
  try {
    await applyFixtureMigrations(url);
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_creators(id,profile_url,display_name,external_author_id,enabled) VALUES('a','https://example.invalid/a','a','author-a',1),('b','https://example.invalid/b','b','author-b',1)",
    );
    const service = new XhsSubscriptionService(db as any, {} as any);
    (service as any).write = (_bytes: number, fn: any) => db.$transaction(fn);
    const runner = new XhsScheduledRunner(
      { xhsCreator: { findMany: async () => [{ id: 'a' }, { id: 'b' }] } },
      service,
      undefined,
      undefined,
      true,
    );
    await work(db, service, runner);
  } finally {
    env.restore();
    await db.$disconnect();
  }
}

const basicRound = '2026-10-31/09:15';
const scheduleA = {
  round: basicRound,
  creatorId: 'a',
  phase: 'basic' as const,
};
const basicA = scheduledTaskId(basicRound, 'a', 'basic');
const basicB = scheduledTaskId(basicRound, 'b', 'basic');

it.each(['existing', 'restart'] as const)(
  'keeps a live queue serialized and settles only an initial unowned queue (%s)',
  async (mode) =>
    isolatedManagedCreators(async (db, service, runner) => {
      const local = service as any;
      const stop = latch(),
        stopped = latch(),
        next = latch(),
        inserted = latch(),
        registered = latch();
      const write = local.write.bind(local);
      local.write = async (bytes: number, work: any) => {
        const result = await write(bytes, work);
        if (result?.kind === 'created' && result.taskId === basicA) {
          inserted.release();
          await registered.ready;
        }
        return result;
      };
      const run = jest
        .spyOn(local, 'run')
        .mockImplementation(async (t: any) => {
          if (t.creatorId === 'a') {
            await stop.ready;
            // Synthetic worker loses local ownership before entering runTask.
            local.pending.delete(t.taskId);
            stopped.release();
            return;
          }
          await db.$executeRaw`UPDATE xhs_subscription_tasks SET state='completed',document=${JSON.stringify({ ...t, state: 'completed' })} WHERE id=${t.taskId}`;
          local.pending.delete(t.taskId);
          next.release();
        });

      try {
        const first = service.scheduleCreatorPhase(scheduleA);
        await inserted.ready;
        // The durable initial row exists before pending.set. It still has an
        // admission owner and cannot be cancelled by a concurrent observation.
        await expect(runner.run(basicRound)).rejects.toThrow(
          'XHS_SCHEDULE_TASK_PENDING',
        );
        expect(run).not.toHaveBeenCalled();
        registered.release();
        await first;
        await expect(runner.run(basicRound)).rejects.toThrow(
          'XHS_SCHEDULE_TASK_PENDING',
        );
        await expect(service.task({ taskId: basicA })).resolves.toMatchObject({
          state: 'queued',
          settling: true,
        });
        await expect(service.task({ taskId: basicB })).rejects.toThrow(
          'XHS_TASK_NOT_FOUND',
        );

        stop.release();
        await stopped.ready;
        if (mode === 'restart') await service.onModuleInit();
        else {
          const [record] = await db.$queryRaw<
            Array<{ document: string }>
          >`SELECT document FROM xhs_subscription_tasks WHERE id=${basicA}`;
          const withAttempt = JSON.stringify({
            ...JSON.parse(record.document),
            scheduledContext: {
              authorId: 'author-a',
              state: 'started',
              used: 1,
            },
          });
          await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${withAttempt} WHERE id=${basicA}`;
          await expect(runner.run(basicRound)).rejects.toThrow(
            'XHS_SCHEDULE_TASK_PENDING',
          );
          expect(run).toHaveBeenCalledTimes(1);
          const [unchanged] = await db.$queryRaw<
            Array<{ document: string }>
          >`SELECT document FROM xhs_subscription_tasks WHERE id=${basicA}`;
          expect(unchanged.document).toBe(withAttempt);
          await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${record.document} WHERE id=${basicA}`;
        }
        await db.$executeRawUnsafe(
          "UPDATE xhs_source_risk SET state='pending',owner='shared-fixture' WHERE id='source'",
        );
        await expect(runner.run(basicRound)).rejects.toThrow(
          'XHS_SCHEDULE_TASK_PENDING',
        );
        await expect(service.task({ taskId: basicA })).resolves.toMatchObject({
          state: 'cancelled',
          code: XHS_SCHEDULE_UNSENT,
          settling: false,
          resumable: false,
        });
        await expect(service.resumeTask({ taskId: basicA })).rejects.toThrow(
          'XHS_TASK_NOT_RESUMABLE',
        );
        expect(run).toHaveBeenCalledTimes(1);
        expect(
          await db.$queryRawUnsafe('SELECT state,owner FROM xhs_source_risk'),
        ).toEqual([{ state: 'pending', owner: 'shared-fixture' }]);

        await db.$executeRawUnsafe(
          "UPDATE xhs_source_risk SET state='clear',owner=NULL WHERE id='source'",
        );
        await runner.run(basicRound).catch((error) => {
          expect(error.message).toBe('XHS_SCHEDULE_TASK_PENDING');
        });
        await next.ready;
        await expect(runner.run(basicRound)).resolves.toEqual({
          outcome: 'settled-incomplete',
        });
        expect(run.mock.calls.map(([task]) => (task as any).creatorId)).toEqual(
          ['a', 'b'],
        );
      } finally {
        registered.release();
        stop.release();
      }
    }),
);

it('lets the next creator proceed only after a cancelled local worker actually exits', async () =>
  isolatedManagedCreators(async (db, service, runner) => {
    const local = service as any;
    const savedRunning = latch(),
      releaseLocal = latch(),
      stopped = latch(),
      next = latch();
    const persist = local.persist.bind(local);
    jest.spyOn(local, 'persist').mockImplementation(async (task: any) => {
      const hold = task.taskId === basicA && task.state === 'running';
      await persist(task);
      if (hold) {
        savedRunning.release();
        await releaseLocal.ready;
      }
    });
    const runTask = local.runTask.bind(local);
    const sourceBoundary = jest.spyOn(local, 'prepareScheduledContext');
    const run = jest
      .spyOn(local, 'runTask')
      .mockImplementation(async (t: any) => {
        if (t.creatorId === 'a') {
          try {
            await runTask(t);
          } finally {
            stopped.release();
          }
          return;
        }
        await db.$executeRaw`UPDATE xhs_subscription_tasks SET state='completed',document=${JSON.stringify({ ...t, state: 'completed' })} WHERE id=${t.taskId}`;
        local.pending.delete(t.taskId);
        next.release();
      });

    try {
      await service.scheduleCreatorPhase(scheduleA);
      await savedRunning.ready;
      await expect(runner.run(basicRound)).rejects.toThrow(
        'XHS_SCHEDULE_TASK_PENDING',
      );
      await expect(
        service.cancelTask({ taskId: basicA }),
      ).resolves.toMatchObject({
        state: 'cancelled',
        settling: true,
      });
      await expect(runner.run(basicRound)).rejects.toThrow(
        'XHS_SCHEDULE_TASK_PENDING',
      );
      expect(run).toHaveBeenCalledTimes(1);
      releaseLocal.release();
      await stopped.ready;
      await expect(service.task({ taskId: basicA })).resolves.toMatchObject({
        state: 'cancelled',
        code: XHS_SCHEDULE_UNSENT,
        settling: false,
      });
      expect(sourceBoundary).not.toHaveBeenCalled();

      await runner.run(basicRound).catch((error) => {
        expect(error.message).toBe('XHS_SCHEDULE_TASK_PENDING');
      });
      await next.ready;
      await expect(runner.run(basicRound)).resolves.toEqual({
        outcome: 'settled-incomplete',
      });
      expect(run.mock.calls.map(([task]) => (task as any).creatorId)).toEqual([
        'a',
        'b',
      ]);
    } finally {
      releaseLocal.release();
    }
  }));
