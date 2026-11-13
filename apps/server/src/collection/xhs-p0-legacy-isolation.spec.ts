import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { admitScheduledXhs, scheduledTaskId } from './xhs-scheduled-admission';
import { XhsScheduledRunner } from './xhs-scheduled-runner';
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
