import { PrismaClient } from '@prisma/client';
import { XhsSubscriptionRuntime } from '../../src/collection/xhs-subscription-runtime';
import { XhsSourceRiskStore } from '../../src/collection/xhs-source-risk-store';
import { bindXhsSourceTotalBudget } from '../../src/collection/xhs-source-request-policy';
import { XhsSubscriptionService } from '../../src/collection/xhs-subscription.service';
import { XhsScheduledRunner } from '../../src/collection/xhs-scheduled-runner';
import { scheduledTaskId } from '../../src/collection/xhs-scheduled-admission';
import { writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Executed only by the fixture-owning process harness; never contacts a server.
const fixtureRequested = Boolean(
  process.env.XHS_FIXTURE_DB || process.env.XHS_FIXTURE_MODE,
);
(fixtureRequested ? it : it.skip)(
  'runs a real scheduled worker against an isolated synthetic source',
  async () => {
    const file = process.env.XHS_FIXTURE_DB,
      mode = process.env.XHS_FIXTURE_MODE;
    if (
      !file ||
      !mode ||
      ![
        'crash-read',
        'crash-transaction',
        'inspect',
        'crash-commit',
        'inspect-complete',
        'inspect-continue',
      ].includes(mode)
    )
      throw Error('FIXTURE_REQUIRED');
    const root = process.env.XHS_FIXTURE_ROOT;
    if (!root) throw Error('FIXTURE_REQUIRED');
    const resolvedRoot = realpathSync(root);
    const relative = path.relative(realpathSync(tmpdir()), resolvedRoot);
    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      !path.basename(resolvedRoot).startsWith('redbook-process-fixture-') ||
      path.dirname(realpathSync(file)) !== resolvedRoot
    )
      throw Error('FIXTURE_PATH_INVALID');
    global.fetch = async () => {
      throw Error('NETWORK_FORBIDDEN');
    };
    const db = new PrismaClient({
      datasources: { db: { url: 'file:' + file.replace(/\\/g, '/') } },
    });
    let sent = 0;
    const api = async (request: any): Promise<any> => {
      sent++;
      if (mode === 'crash-read') process.exit(73);
      if (mode === 'inspect' || mode === 'inspect-complete')
        throw Error('SYNTHETIC_REPLAY_FORBIDDEN');
      const note = JSON.parse(request.body).source_note_id;
      if (mode === 'inspect-continue') {
        if (note !== 'b-good') throw Error('FIRST_ACCOUNT_REPLAY_FORBIDDEN');
        const first = await db.$queryRaw<
          Array<{ state: string }>
        >`SELECT state FROM xhs_subscription_tasks WHERE creator_id='a' AND id=${scheduledTaskId('2026-10-31/09:15', 'a', 'basic')}`;
        expect(first[0]?.state).toBe('completed');
      }
      return {
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: {
            items: [
              {
                id: note,
                note_card: {
                  note_id: note,
                  user: {
                    user_id: note === 'b-good' ? 'author-b' : 'author-a',
                  },
                  type: 'normal',
                  time: 1760000000000,
                  title: 'Synthetic',
                  desc: 'Synthetic body',
                  image_list: [],
                  interact_info: {
                    liked_count: '0',
                    collected_count: '0',
                    share_count: '0',
                    comment_count: '0',
                  },
                },
              },
            ],
          },
        },
      };
    };
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    try {
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      for (const [author, notes] of [
        ['author-a', ['a-bad', 'a-good']],
        ['author-b', ['b-good']],
      ] as const) {
        (runtime as any).adapter.restoreDefaultAuthorAccess(author);
        for (const note of notes)
          (runtime as any).adapter.tokens.set(JSON.stringify([author, note]), {
            token: 'synthetic-token',
            source: 'pc_user',
            expiresAt: Date.now() + 60000,
          });
      }
      (runtime as any).resolve = async (url: string) => ({
        inputKind: 'profile',
        author: { id: url.split('/').pop() },
      });
      (runtime as any).list = async (author: string) => ({
        authorId: author,
        nextCursor: null,
        notes: (author === 'author-a' ? ['a-bad', 'a-good'] : ['b-good']).map(
          (noteId) => ({
            authorId: author,
            noteId,
            title: 'Synthetic',
            publishedAt: 0,
            kind: 'image-text',
          }),
        ),
      });
      const service: any = new XhsSubscriptionService(db as any, runtime);
      service.write = async (_bytes: number, fn: any) => {
        const value = await db.$transaction(async (tx) => {
          const result = await fn(tx);
          if (mode === 'crash-transaction') {
            const rows = await tx.$queryRaw<
              Array<{ n: bigint | number }>
            >`SELECT count(*) n FROM xhs_notes WHERE creator_id='a'`;
            if (Number(rows[0].n) > 0) {
              writeFileSync(
                file + '.kill-ready',
                'synthetic transaction is open',
                { flag: 'wx' },
              );
              process.kill(process.pid, 'SIGKILL');
            }
          }
          return result;
        });
        if (mode === 'crash-commit') {
          const rows = await db.$queryRaw<
            Array<{ state: string }>
          >`SELECT state FROM xhs_subscription_tasks WHERE creator_id='a' AND state='completed'`;
          if (rows.length) process.exit(74);
        }
        return value;
      };
      const runner = new XhsScheduledRunner(db as any, {
        scheduleCreatorPhase: service.scheduleCreatorPhase.bind(service),
        task: service.task.bind(service),
      });
      const round = '2026-10-31/09:15';
      if (mode === 'inspect-continue') {
        await service.onModuleInit();
        for (let i = 0; i < 12; i++) {
          try {
            await runner.run(round);
          } catch {}
          await service.lane;
        }
        const task = await service.task({
          taskId: scheduledTaskId(round, 'b', 'basic'),
        });
        expect(task.state).toBe('completed');
        expect(sent).toBe(1);
        expect(
          await db.xhsNote.findMany({ where: { creatorId: 'b' } }),
        ).toHaveLength(1);
      } else if (mode === 'inspect-complete') {
        await service.onModuleInit();
        const admitted = await service.scheduleCreatorPhase({
          round,
          creatorId: 'a',
          phase: 'basic',
        });
        expect(admitted.taskId).toBe(scheduledTaskId(round, 'a', 'basic'));
        const task = await service.task({ taskId: admitted.taskId });
        expect(task.state).toBe('completed');
        expect(sent).toBe(0);
        const notes = await db.xhsNote.findMany({
          where: { creatorId: 'a' },
          orderBy: { id: 'asc' },
        });
        expect(notes).toHaveLength(2);
        expect(
          notes.every(
            (n) =>
              n.contentHtml?.includes('Synthetic body') && n.publishTime > 0,
          ),
        ).toBe(true);
        const receipt = await db.$queryRaw<
          Array<{ document: string }>
        >`SELECT document FROM xhs_subscription_tasks WHERE id=${admitted.taskId}`;
        const document = JSON.parse(receipt[0].document);
        expect(document.completed).toBe(2);
        expect(document.failed).toBe(0);
        for (const note of notes)
          expect(document.items[note.id]).toBe('completed');
      } else if (mode === 'inspect') {
        await service.onModuleInit();
        for (let i = 0; i < 2; i++) {
          try {
            await runner.run(round);
          } catch {}
          await service.lane;
        }
        expect(sent).toBe(0);
        const first = await service.task({
          taskId: scheduledTaskId(round, 'a', 'basic'),
        });
        expect(first.state).toBe('blocked');
        await expect(
          service.task({ taskId: scheduledTaskId(round, 'b', 'basic') }),
        ).rejects.toThrow();
      } else {
        for (let i = 0; i < 8; i++) {
          try {
            await runner.run(round);
          } catch {}
          await service.lane;
        }
        throw Error('SYNTHETIC_CRASH_NOT_REACHED');
      }
      await service.onModuleDestroy();
    } finally {
      runtime.onModuleDestroy();
      await db.$disconnect();
    }
  },
);
