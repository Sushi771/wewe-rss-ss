import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  startTaskSource,
  settleTaskSource,
  taskSourceFingerprint,
  taskUnknownMarker,
  verifiedUnknownMarkers,
  terminalStartedDetail,
  TaskSourceScope,
} from './xhs-task-source-fence';

describe('task-scoped source uncertainty (synthetic SQLite)', () => {
  let db: PrismaClient, dir: string;
  const owner = '00000000-0000-4000-8000-000000000001',
    cursorHash = 'a'.repeat(64);
  const make = (
    id: string,
    creator: string,
    target: string,
  ): TaskSourceScope => ({
    taskId: id,
    creatorId: creator,
    phase: 'list',
    target,
    cursorHash,
    fingerprint: taskSourceFingerprint(creator, 'list', target, cursorHash),
    owner,
  });
  const a = make('task-a', 'creator-a', 'author-a'),
    b = make('task-b', 'creator-b', 'author-b');
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'xhs-task-fence-'));
    db = new PrismaClient({
      datasources: {
        db: {
          url: 'file:' + path.join(dir, 'test.sqlite').replace(/\\/g, '/'),
        },
      },
    });
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_subscription_tasks(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_creators(id TEXT PRIMARY KEY,external_author_id TEXT,enabled INTEGER)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_source_risk(id TEXT PRIMARY KEY,state TEXT,owner TEXT,code TEXT,http_status INTEGER,endpoint TEXT,updated_at INTEGER)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_request_budgets(id TEXT PRIMARY KEY,request_limit INTEGER,used INTEGER,next_at INTEGER,interval_ms INTEGER)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_notes(id TEXT PRIMARY KEY,creator_id TEXT)',
    );
  }, 40000);
  beforeEach(async () => {
    for (const table of [
      'xhs_subscription_tasks',
      'xhs_creators',
      'xhs_source_risk',
      'xhs_request_budgets',
      'xhs_notes',
    ])
      await db.$executeRawUnsafe('DELETE FROM ' + table);
    for (const s of [a, b]) {
      await db.$executeRaw`INSERT INTO xhs_creators VALUES(${s.creatorId},${s.target},1)`;
      const doc = JSON.stringify({
        taskId: s.taskId,
        creatorId: s.creatorId,
        state: 'running',
        noteIds: [],
      });
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks VALUES(${s.taskId},${s.creatorId},'running',${doc})`;
    }
    await db.$executeRaw`INSERT INTO xhs_source_risk VALUES('source','pending',${owner},NULL,NULL,NULL,0)`;
  });
  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }, 40000);
  it('retains unknown and blocks unrelated requests from bypassing its marker', async () => {
    await db.$transaction((tx) => startTaskSource(tx, a));
    await db.$transaction((tx) => settleTaskSource(tx, a, 'unknown'));
    const risk = await db.$queryRaw<
      any[]
    >`SELECT state,owner FROM xhs_source_risk`;
    expect(risk[0]).toMatchObject({ state: 'clear', owner: null });
    const rows = await db.$queryRaw<
      any[]
    >`SELECT document FROM xhs_subscription_tasks WHERE id=${a.taskId}`;
    const doc = JSON.parse(rows[0].document);
    expect(doc.sourceUnknowns).toMatchObject([
      {
        marker: taskUnknownMarker(a),
        fingerprint: a.fingerprint,
        outcome: 'unknown',
      },
    ]);
    expect(rows[0].document).not.toContain('author-a');
    await db.$executeRaw`UPDATE xhs_source_risk SET state='pending',owner=${owner}`;
    expect(await verifiedUnknownMarkers(db as any, b)).toEqual([]);
    expect(await verifiedUnknownMarkers(db as any, a)).toEqual([]);
    await expect(
      db.$transaction((tx) => startTaskSource(tx, a)),
    ).rejects.toThrow();
    await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${taskUnknownMarker(a)}`;
    await expect(
      db.$transaction((tx) => startTaskSource(tx, a)),
    ).rejects.toThrow();
  });
  it('rolls back the evidence and shared owner together on failed settlement', async () => {
    await db.$transaction((tx) => startTaskSource(tx, a));
    await expect(
      db.$transaction(async (tx) => {
        await settleTaskSource(tx, a, 'unknown');
        throw Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const rows = await db.$queryRaw<
      any[]
    >`SELECT document FROM xhs_subscription_tasks WHERE id=${a.taskId}`;
    expect(JSON.parse(rows[0].document).sourceActive.outcome).toBe('started');
    expect(await db.$queryRaw`SELECT id FROM xhs_request_budgets`).toHaveLength(
      0,
    );
    expect(
      (await db.$queryRaw<any[]>`SELECT state FROM xhs_source_risk`)[0].state,
    ).toBe('pending');
  });
  it('rejects an unbound author and a wrong owner without changing evidence', async () => {
    const wrong = make(a.taskId, a.creatorId, 'other-author');
    await expect(
      db.$transaction((tx) => startTaskSource(tx, wrong)),
    ).rejects.toThrow();
    await db.$transaction((tx) => startTaskSource(tx, a));
    await expect(
      db.$transaction((tx) =>
        settleTaskSource(
          tx,
          { ...a, owner: '00000000-0000-4000-8000-000000000002' },
          'unknown',
        ),
      ),
    ).rejects.toThrow();
  });
  it('keeps the active guard and shared pause if cancellation wins before settlement', async () => {
    await db.$transaction((tx) => startTaskSource(tx, a));
    await db.$executeRaw`UPDATE xhs_subscription_tasks SET state='cancelled' WHERE id=${a.taskId}`;
    await expect(
      db.$transaction((tx) => settleTaskSource(tx, a, 'unknown')),
    ).rejects.toThrow();
    const rows = await db.$queryRaw<
      any[]
    >`SELECT document FROM xhs_subscription_tasks WHERE id=${a.taskId}`;
    expect(JSON.parse(rows[0].document).sourceActive.outcome).toBe('started');
    expect(
      (await db.$queryRaw<any[]>`SELECT state FROM xhs_source_risk`)[0].state,
    ).toBe('pending');
  });
  it('settles the same unknown at most once across two SQLite connections', async () => {
    await db.$transaction((tx) => startTaskSource(tx, a));
    const other = new PrismaClient({
      datasources: {
        db: {
          url: 'file:' + path.join(dir, 'test.sqlite').replace(/\\/g, '/'),
        },
      },
    });
    try {
      const results = await Promise.allSettled([
        db.$transaction((tx) => settleTaskSource(tx, a, 'unknown')),
        other.$transaction((tx) => settleTaskSource(tx, a, 'unknown')),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id=${a.taskId}`;
      expect(JSON.parse(rows[0].document).sourceUnknowns).toHaveLength(1);
      expect(
        await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id=${taskUnknownMarker(a)}`,
      ).toHaveLength(1);
    } finally {
      await other.$disconnect();
    }
  }, 20000);
  it('does not bypass an unknown marker without its matching task receipt', async () => {
    const marker = taskUnknownMarker(a);
    await db.$executeRaw`INSERT INTO xhs_request_budgets VALUES(${marker},1,1,0,0)`;
    expect(await verifiedUnknownMarkers(db as any, b)).toEqual([]);
  });
  it('does not bypass a marker when the persisted request identity is altered', async () => {
    await db.$transaction((tx) => startTaskSource(tx, a));
    await db.$transaction((tx) => settleTaskSource(tx, a, 'unknown'));
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_subscription_tasks WHERE id=${a.taskId}`;
    const doc = JSON.parse(rows[0].document);
    doc.sourceUnknowns[0].targetHash = 'b'.repeat(64);
    await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(doc)} WHERE id=${a.taskId}`;
    await db.$executeRaw`UPDATE xhs_source_risk SET state='pending',owner=${owner}`;
    expect(await verifiedUnknownMarkers(db as any, b)).toEqual([]);
  });
  it('binds detail uncertainty to the selected note, across replacement tasks', async () => {
    const note = JSON.stringify(['xiaohongshu', 'note', 'note-a']),
      other = JSON.stringify(['xiaohongshu', 'note', 'note-b']);
    await db.$executeRaw`INSERT INTO xhs_notes VALUES(${note},${a.creatorId}),(${other},${a.creatorId})`;
    const doc = JSON.stringify({
      taskId: a.taskId,
      creatorId: a.creatorId,
      state: 'running',
      noteIds: [note, other],
    });
    await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${doc} WHERE id=${a.taskId}`;
    const detail = (id: string, target: string): TaskSourceScope => ({
      taskId: id,
      creatorId: a.creatorId,
      phase: 'detail',
      target,
      cursorHash,
      fingerprint: taskSourceFingerprint(
        a.creatorId,
        'detail',
        target,
        cursorHash,
      ),
      owner,
    });
    const first = detail(a.taskId, 'note-a');
    await db.$transaction((tx) => startTaskSource(tx, first));
    await db.$transaction((tx) => settleTaskSource(tx, first, 'unknown'));
    const replacement = JSON.stringify({
      taskId: 'replacement',
      creatorId: a.creatorId,
      state: 'running',
      noteIds: [note, other],
    });
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks VALUES('replacement',${a.creatorId},'running',${replacement})`;
    await db.$executeRaw`UPDATE xhs_source_risk SET state='pending',owner=${owner}`;
    expect(
      await verifiedUnknownMarkers(db as any, detail('replacement', 'note-b')),
    ).toEqual([]);
    expect(
      await verifiedUnknownMarkers(db as any, detail('replacement', 'note-a')),
    ).toEqual([]);
    await expect(
      db.$transaction((tx) =>
        startTaskSource(tx, detail('replacement', 'note-a')),
      ),
    ).rejects.toThrow();
    await expect(
      db.$transaction((tx) =>
        startTaskSource(tx, detail('replacement', 'not-selected')),
      ),
    ).rejects.toThrow();
  });
  it('only identifies a bound terminal started detail when the shared owner is clear', async () => {
    const note = JSON.stringify(['xiaohongshu', 'note', 'note-a']);
    await db.$executeRaw`INSERT INTO xhs_notes VALUES(${note},${a.creatorId})`;
    const doc = JSON.stringify({
      taskId: a.taskId,
      creatorId: a.creatorId,
      state: 'running',
      noteIds: [note],
    });
    await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${doc} WHERE id=${a.taskId}`;
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the existing Jest CommonJS module identity and load order for this fixture.
    const emptyHash = require('node:crypto')
      .createHash('sha256')
      .update('')
      .digest('hex');
    const scope: TaskSourceScope = {
      taskId: a.taskId,
      creatorId: a.creatorId,
      phase: 'detail',
      target: 'note-a',
      cursorHash: emptyHash,
      fingerprint: taskSourceFingerprint(
        a.creatorId,
        'detail',
        'note-a',
        emptyHash,
      ),
      owner,
    };
    await db.$transaction((tx) => startTaskSource(tx, scope));
    const record = JSON.parse(
      (
        await db.$queryRaw<
          any[]
        >`SELECT document FROM xhs_subscription_tasks WHERE id=${a.taskId}`
      )[0].document,
    );
    record.state = 'blocked';
    await db.$executeRaw`UPDATE xhs_subscription_tasks SET state='blocked',document=${JSON.stringify(record)} WHERE id=${a.taskId}`;
    expect(
      await terminalStartedDetail(db as any, a.creatorId, 'note-a'),
    ).toBeNull(); // current owner still active
    await db.$executeRaw`UPDATE xhs_source_risk SET state='clear',owner=NULL`;
    expect(await terminalStartedDetail(db as any, a.creatorId, 'note-a')).toBe(
      a.taskId,
    );
    record.sourceActive.targetHash = 'b'.repeat(64);
    await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(record)} WHERE id=${a.taskId}`;
    expect(
      await terminalStartedDetail(db as any, a.creatorId, 'note-a'),
    ).toBeNull();
  });
});
