import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', moduleResolution: 'node' },
});
const {
  admitScheduledXhs,
  scheduledTaskId,
} = require('./xhs-scheduled-admission.ts');
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    "CREATE TABLE xhs_subscription_tasks(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT,updated_at INTEGER);CREATE TABLE xhs_creators(id TEXT PRIMARY KEY,enabled INTEGER,external_author_id TEXT);CREATE TABLE xhs_source_risk(id TEXT PRIMARY KEY,state TEXT);CREATE TABLE xhs_request_budgets(id TEXT PRIMARY KEY,used INTEGER DEFAULT 1,request_limit INTEGER DEFAULT 1);CREATE TABLE xhs_whole_creator_jobs(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT);INSERT INTO xhs_creators VALUES('a',1,'author');INSERT INTO xhs_source_risk VALUES('source','clear');",
  );
  const sql = (s) => s.join('?');
  const tx = {
    $queryRaw: async (s, ...v) => db.prepare(sql(s)).all(...v),
    $executeRaw: async (s, ...v) =>
      Number(db.prepare(sql(s)).run(...v).changes),
  };
  return { db, tx };
}
const round = '2026-10-31/09:15',
  input = (phase = 'basic') => ({
    round,
    creatorId: 'a',
    phase,
    now: 1000,
    task: {
      taskId: scheduledTaskId(round, 'a', phase),
      creatorId: 'a',
      state: 'queued',
      failed: 0,
    },
  });
async function commit(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const v = await fn();
    db.exec('COMMIT');
    return v;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
test('durable binding prevents replay after acknowledgement loss and restart', async () => {
  const { db, tx } = fixture();
  const one = await commit(db, () => admitScheduledXhs(tx, input()));
  assert.equal(one.kind, 'created');
  const again = await commit(db, () => admitScheduledXhs(tx, input()));
  assert.equal(again.kind, 'existing');
  assert.equal(
    db.prepare('select count(*) n from xhs_subscription_tasks').get().n,
    1,
  );
});
test('historic unknown creates blocked record without queued work', async () => {
  const { db, tx } = fixture();
  db.exec("UPDATE xhs_source_risk SET state='blocked'");
  const r = await commit(db, () => admitScheduledXhs(tx, input()));
  assert.equal(r.kind, 'blocked');
  assert.equal(r.reason, 'XHS_SCHEDULE_SOURCE_BLOCKED');
  assert.equal(
    db
      .prepare(
        "select count(*) n from xhs_subscription_tasks where state='queued'",
      )
      .get().n,
    0,
  );
});
test('active task defers without consuming the round', async () => {
  const { db, tx } = fixture();
  db.exec(
    "INSERT INTO xhs_subscription_tasks VALUES('manual','a','running','{\"state\":\"running\"}',1)",
  );
  const r = await commit(db, () => admitScheduledXhs(tx, input()));
  assert.equal(r.kind, 'deferred');
  db.exec(
    "UPDATE xhs_subscription_tasks SET state='completed',document='{\"state\":\"completed\"}' WHERE id='manual'",
  );
  assert.equal(
    (await commit(db, () => admitScheduledXhs(tx, input()))).kind,
    'created',
  );
});
test('another in-flight source request defers without consuming the round', async () => {
  const { db, tx } = fixture();
  db.exec("UPDATE xhs_source_risk SET state='pending'");
  assert.equal(
    (await commit(db, () => admitScheduledXhs(tx, input()))).kind,
    'deferred',
  );
  assert.equal(
    db.prepare('select count(*) n from xhs_subscription_tasks').get().n,
    0,
  );
  db.exec("UPDATE xhs_source_risk SET state='clear'");
  assert.equal(
    (await commit(db, () => admitScheduledXhs(tx, input()))).kind,
    'created',
  );
});
test('media requires completed basic stage and no overlapping work', async () => {
  const { db, tx } = fixture();
  const r = await commit(db, () => admitScheduledXhs(tx, input('media')));
  assert.equal(r.reason, 'XHS_SCHEDULE_BASIC_INCOMPLETE');
  const second = fixture();
  const b = await commit(second.db, () =>
    admitScheduledXhs(second.tx, input()),
  );
  second.db
    .prepare(
      "update xhs_subscription_tasks set state='completed',document=? where id=?",
    )
    .run(
      JSON.stringify({
        ...input().task,
        state: 'completed',
        noteIds: ['n'],
        schedule: { round, phase: 'basic' },
      }),
      b.taskId,
    );
  const m = await commit(second.db, () =>
    admitScheduledXhs(second.tx, {
      ...input('media'),
      task: { ...input('media').task, noteIds: ['n'] },
    }),
  );
  assert.equal(m.kind, 'created');
});
test('repeated transactional admission cannot create duplicate round task', async () => {
  const { db, tx } = fixture();
  db.exec('BEGIN IMMEDIATE');
  const a = await admitScheduledXhs(tx, input());
  await assert.rejects(
    admitScheduledXhs(tx, {
      ...input(),
      task: { ...input().task, taskId: 'wrong' },
    }),
    /INVALID/,
  );
  db.exec('COMMIT');
  const b = await commit(db, () => admitScheduledXhs(tx, input()));
  assert.equal(a.kind, 'created');
  assert.equal(b.kind, 'existing');
  assert.equal(
    db.prepare('select count(*) n from xhs_subscription_tasks').get().n,
    1,
  );
});
test('pending dispatch fence blocks even when risk row appears clear', async () => {
  const { db, tx } = fixture();
  db.exec(
    "insert into xhs_request_budgets(id) values('xhs:dispatch-pending:synthetic')",
  );
  const r = await commit(db, () => admitScheduledXhs(tx, input()));
  assert.equal(r.reason, 'XHS_SCHEDULE_SOURCE_BLOCKED');
});
test('disabled creator records blocked rather than queued', async () => {
  const { db, tx } = fixture();
  db.exec('update xhs_creators set enabled=0');
  const r = await commit(db, () => admitScheduledXhs(tx, input()));
  assert.equal(r.reason, 'XHS_SCHEDULE_CREATOR_DISABLED');
});
test('two SQLite connections serialize concurrent round admission', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'xhs-schedule-'));
  const first = new DatabaseSync(join(dir, 'fixture.db'));
  first.exec(
    "CREATE TABLE xhs_subscription_tasks(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT,updated_at INTEGER);CREATE TABLE xhs_creators(id TEXT PRIMARY KEY,enabled INTEGER,external_author_id TEXT);CREATE TABLE xhs_source_risk(id TEXT PRIMARY KEY,state TEXT);CREATE TABLE xhs_request_budgets(id TEXT PRIMARY KEY,used INTEGER DEFAULT 1,request_limit INTEGER DEFAULT 1);CREATE TABLE xhs_whole_creator_jobs(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT);INSERT INTO xhs_creators VALUES('a',1,'author');INSERT INTO xhs_source_risk VALUES('source','clear');",
  );
  const second = new DatabaseSync(join(dir, 'fixture.db'));
  second.exec('PRAGMA busy_timeout=0');
  const wrap = (db) => ({
    $queryRaw: async (s, ...v) => db.prepare(s.join('?')).all(...v),
    $executeRaw: async (s, ...v) =>
      Number(db.prepare(s.join('?')).run(...v).changes),
  });
  first.exec('BEGIN IMMEDIATE');
  assert.throws(() => second.exec('BEGIN IMMEDIATE'), /locked|busy/i);
  assert.equal((await admitScheduledXhs(wrap(first), input())).kind, 'created');
  first.exec('COMMIT');
  second.exec('BEGIN IMMEDIATE');
  assert.equal(
    (await admitScheduledXhs(wrap(second), input())).kind,
    'existing',
  );
  second.exec('COMMIT');
  assert.equal(
    second.prepare('select count(*) n from xhs_subscription_tasks').get().n,
    1,
  );
  first.close();
  second.close();
});
test('deterministic task id satisfies existing UUID API validation', () => {
  const a = scheduledTaskId(round, 'a', 'basic');
  assert.match(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(a, scheduledTaskId(round, 'a', 'media'));
  assert.notEqual(a, scheduledTaskId(round, 'b', 'basic'));
});

test('unbound scheduled media records blocked and never queues dispatch', async () => {
  const { db, tx } = fixture();
  const r = await commit(db, () =>
    admitScheduledXhs(tx, {
      ...input('media'),
      preBlocked: 'XHS_SCHEDULE_MEDIA_BINDING_REQUIRED',
    }),
  );
  assert.equal(r.reason, 'XHS_SCHEDULE_MEDIA_BINDING_REQUIRED');
  assert.equal(
    db
      .prepare(
        "select count(*) n from xhs_subscription_tasks where state='queued'",
      )
      .get().n,
    0,
  );
});

test('1001 notes bind into durable batches; restart observes both without reenqueuing', async () => {
  const { db, tx } = fixture(),
    ids = Array.from({ length: 1001 }, (_, i) => `note-${i}`),
    basic = input();
  const created = await commit(db, () => admitScheduledXhs(tx, basic));
  db.prepare(
    "update xhs_subscription_tasks set state='completed',document=? where id=?",
  ).run(
    JSON.stringify({
      ...basic.task,
      state: 'completed',
      failed: 0,
      noteIds: ids,
      schedule: { round, phase: 'basic' },
    }),
    created.taskId,
  );
  const batchInput = (batch) => ({
    round,
    creatorId: 'a',
    phase: 'media',
    batch,
    now: 1001,
    task: {
      taskId: scheduledTaskId(round, 'a', 'media', batch),
      creatorId: 'a',
      state: 'queued',
      failed: 0,
      noteIds: ids.slice(batch * 1000, (batch + 1) * 1000),
    },
  });
  const first = batchInput(0);
  assert.equal(first.task.noteIds.length, 1000);
  assert.equal(
    (await commit(db, () => admitScheduledXhs(tx, first))).kind,
    'created',
  );
  assert.equal(
    (await commit(db, () => admitScheduledXhs(tx, first))).kind,
    'existing',
  );
  db.prepare(
    "update xhs_subscription_tasks set state='completed',document=? where id=?",
  ).run(
    JSON.stringify({
      ...first.task,
      state: 'completed',
      schedule: { round, phase: 'media', batch: 0 },
    }),
    first.task.taskId,
  );
  const second = batchInput(1);
  assert.equal(second.task.noteIds.length, 1);
  assert.equal(second.task.noteIds[0], 'note-1000');
  assert.equal(
    (await commit(db, () => admitScheduledXhs(tx, second))).kind,
    'created',
  );
  assert.equal(
    (await commit(db, () => admitScheduledXhs(tx, second))).kind,
    'existing',
  );
  assert.equal(
    db
      .prepare(
        "select count(*) n from xhs_subscription_tasks where creator_id='a'",
      )
      .get().n,
    3,
  );
  await assert.rejects(
    commit(db, () =>
      admitScheduledXhs(tx, {
        ...second,
        task: { ...second.task, noteIds: ['wrong'] },
      }),
    ),
    /BINDING_MISMATCH/,
  );
});
test('later batch cannot leapfrog an incomplete prior batch', async () => {
  const { db, tx } = fixture(),
    ids = Array.from({ length: 1001 }, (_, i) => `note-${i}`),
    b = input();
  await commit(db, () => admitScheduledXhs(tx, b));
  db.prepare(
    "update xhs_subscription_tasks set state='completed',document=? where id=?",
  ).run(
    JSON.stringify({
      ...b.task,
      state: 'completed',
      failed: 0,
      noteIds: ids,
      schedule: { round, phase: 'basic' },
    }),
    b.task.taskId,
  );
  const batch = 1,
    task = {
      taskId: scheduledTaskId(round, 'a', 'media', batch),
      creatorId: 'a',
      state: 'queued',
      failed: 0,
      noteIds: [ids[1000]],
    };
  assert.equal(
    (
      await commit(db, () =>
        admitScheduledXhs(tx, {
          round,
          creatorId: 'a',
          phase: 'media',
          batch,
          task,
          now: 1001,
        }),
      )
    ).reason,
    'XHS_SCHEDULE_PREVIOUS_BATCH_INCOMPLETE',
  );
});

test('known partial predecessor permits next batch while unknown blocks it', async () => {
  for (const [code, expected] of [
    ['XHS_MEDIA_NEEDS_DETAIL_REFRESH', 'created'],
    ['XHS_MEDIA_OUTCOME_UNKNOWN', 'blocked'],
  ]) {
    const { db, tx } = fixture(),
      ids = Array.from({ length: 1001 }, (_, i) => `note-${i}`),
      b = input();
    await commit(db, () => admitScheduledXhs(tx, b));
    db.prepare(
      "update xhs_subscription_tasks set state='completed',document=? where id=?",
    ).run(
      JSON.stringify({
        ...b.task,
        state: 'completed',
        failed: 0,
        noteIds: ids,
        schedule: { round, phase: 'basic' },
      }),
      b.task.taskId,
    );
    const first = {
      taskId: scheduledTaskId(round, 'a', 'media'),
      creatorId: 'a',
      state: 'partial',
      failed: 0,
      remaining: 0,
      code,
      noteIds: ids.slice(0, 1000),
      schedule: { round, phase: 'media', batch: 0 },
    };
    db.prepare('insert into xhs_subscription_tasks values(?,?,?,?,?)').run(
      first.taskId,
      'a',
      'partial',
      JSON.stringify(first),
      1,
    );
    const second = {
      taskId: scheduledTaskId(round, 'a', 'media', 1),
      creatorId: 'a',
      state: 'queued',
      failed: 0,
      noteIds: [ids[1000]],
    };
    assert.equal(
      (
        await commit(db, () =>
          admitScheduledXhs(tx, {
            round,
            creatorId: 'a',
            phase: 'media',
            batch: 1,
            task: second,
            now: 1001,
          }),
        )
      ).kind,
      expected,
    );
  }
});

test('item-local partial media accepts only successfully completed notes', async () => {
  for (const code of ['XHS_DETAIL_PARSE_FAILED', 'XHS_DETAIL_OUTCOME_UNKNOWN'])
    for (const [ids, expected] of [
      [['good'], code === 'XHS_DETAIL_PARSE_FAILED' ? 'created' : 'blocked'],
      [['bad'], 'blocked'],
      [['good', 'bad'], 'blocked'],
    ]) {
      const { db, tx } = fixture(),
        b = await commit(db, () => admitScheduledXhs(tx, input()));
      const basic = {
        ...input().task,
        state: 'partial',
        code,
        failed: 1,
        remaining: 0,
        noteIds: ['bad', 'good'],
        items: { bad: 'failed', good: 'completed' },
        schedule: { round, phase: 'basic' },
      };
      db.prepare(
        "update xhs_subscription_tasks set state='partial',document=? where id=?",
      ).run(JSON.stringify(basic), b.taskId);
      const out = await commit(db, () =>
        admitScheduledXhs(tx, {
          ...input('media'),
          task: { ...input('media').task, noteIds: ids },
        }),
      );
      assert.equal(out.kind, expected);
    }
});

test('paired unknown, tampered or unpaired evidence blocks another account', async () => {
  const { createHash } = await import('node:crypto');
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  for (const variant of ['valid', 'tampered', 'unpaired']) {
    const { db, tx } = fixture();
    const creatorId = 'other',
      phase = 'comments',
      targetHash = hash('note'),
      cursorHash = hash(JSON.stringify(['', ''])),
      fingerprint = hash(
        JSON.stringify([creatorId, phase, targetHash, cursorHash]),
      ),
      marker = 'xhs:dispatch-pending:unknown:' + fingerprint;
    db.prepare(
      'insert into xhs_request_budgets(id,used,request_limit) values(?,1,1)',
    ).run(marker);
    if (variant !== 'unpaired') {
      const entry = {
        marker,
        fingerprint,
        phase,
        targetHash: variant === 'tampered' ? hash('wrong') : targetHash,
        cursorHash,
        outcome: 'unknown',
        classification: 'request-outcome-unknown',
        taskId: 'old',
        creatorId,
      };
      db.prepare('insert into xhs_subscription_tasks values(?,?,?,?,?)').run(
        'old',
        creatorId,
        'blocked',
        JSON.stringify({
          creatorId,
          state: 'blocked',
          sourceUnknowns: [entry],
        }),
        1,
      );
    }
    assert.equal(
      (await commit(db, () => admitScheduledXhs(tx, input()))).kind,
      'blocked',
    );
    db.close();
  }
});
test('a bound local admission review permits another scheduled account but rejects tampering', async () => {
  const { createHash } = await import('node:crypto');
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  for (const variant of ['valid', 'wrong-owner', 'wrong-target']) {
    const { db, tx } = fixture(),
      creatorId = 'other',
      phase = 'detail',
      targetHash = hash('note'),
      cursorHash = hash(''),
      fingerprint = hash(
        JSON.stringify([creatorId, phase, targetHash, cursorHash]),
      ),
      marker = 'xhs:dispatch-pending:unknown:' + fingerprint;
    db.prepare(
      'insert into xhs_request_budgets(id,used,request_limit) values(?,1,1)',
    ).run(marker);
    const entry = {
      marker,
      fingerprint,
      phase,
      targetHash: variant === 'wrong-target' ? hash('other') : targetHash,
      cursorHash,
      outcome: 'not-dispatched',
      classification: 'local-pre-dispatch-review',
      owner:
        variant === 'wrong-owner'
          ? 'invalid'
          : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      taskId: 'old',
      creatorId,
    };
    db.prepare('insert into xhs_subscription_tasks values(?,?,?,?,?)').run(
      'old',
      creatorId,
      'blocked',
      JSON.stringify({ creatorId, state: 'blocked', sourceUnknowns: [entry] }),
      1,
    );
    assert.equal(
      (await commit(db, () => admitScheduledXhs(tx, input()))).kind,
      variant === 'valid' ? 'created' : 'blocked',
    );
    db.close();
  }
});

const {
  prepareScheduledPolicy,
  confirmScheduledPolicy,
  prepareScheduledTaskReview,
} = require('./xhs-scheduled-review-scope.ts');
const { fullHistoryContext } = require('./xhs-full-history-scope.ts');

// Entirely synthetic retained history and approval. No platform or production I/O.
async function reviewedFixture() {
  const { db, tx } = fixture();
  tx.$queryRawUnsafe = async (sql, ...v) => db.prepare(sql).all(...v);
  tx.$executeRawUnsafe = async (sql, ...v) =>
    Number(db.prepare(sql).run(...v).changes);
  db.exec(`
    ALTER TABLE xhs_request_budgets ADD COLUMN next_at INTEGER DEFAULT 0;
    ALTER TABLE xhs_request_budgets ADD COLUMN interval_ms INTEGER DEFAULT 1000;
    ALTER TABLE xhs_source_risk ADD COLUMN code TEXT;
    ALTER TABLE xhs_source_risk ADD COLUMN owner TEXT;
    ALTER TABLE xhs_source_risk ADD COLUMN http_status INTEGER;
    ALTER TABLE xhs_source_risk ADD COLUMN endpoint TEXT;
    CREATE TABLE xhs_unbound_owner_reviews(id TEXT PRIMARY KEY,plan_digest TEXT,original_risk_json TEXT,original_outcome TEXT,old_task_ids_json TEXT,old_job_ids_json TEXT,creator_bindings_json TEXT,budget_snapshot_json TEXT,scope_json TEXT,backup_sha256 TEXT,approved_at INTEGER);
    CREATE TABLE xhs_unbound_owner_requests(operation_id TEXT PRIMARY KEY,review_id TEXT,task_id TEXT,creator_id TEXT,phase TEXT,logical_target TEXT,outcome TEXT,listed_note_ids_json TEXT);
    INSERT INTO xhs_creators VALUES('b',1,'author-b'),('c',1,'author-c');
    INSERT INTO xhs_request_budgets(id,used,request_limit) VALUES('xhs:source-total',0,100),('xhs:dispatch-pending:synthetic-old',1,1);
  `);
  const old = {
    taskId: 'synthetic-old-task',
    creatorId: 'b',
    state: 'blocked',
    code: 'XHS_SOURCE_TRANSPORT_BLOCKED',
    sourceActive: {
      phase: 'detail',
      state: 'started',
      noteId: 'synthetic-old-note',
      marker: 'xhs:dispatch-pending:synthetic-old',
    },
  };
  const writeOld = (doc = old, state = doc.state) =>
    db
      .prepare(
        'INSERT OR REPLACE INTO xhs_subscription_tasks VALUES(?,?,?,?,1)',
      )
      .run(old.taskId, 'b', state, JSON.stringify(doc));
  writeOld();
  const scopeInput = {
    creatorIds: ['a', 'b', 'c'],
    maxRequests: 20,
    phaseLimits: { profile: 3, list: 3, detail: 10, media: 10 },
  };
  const plan = await prepareScheduledPolicy(tx, scopeInput);
  await confirmScheduledPolicy(
    tx,
    scopeInput,
    plan.digest,
    {
      assertQuiescent: async () => {},
      verifyBackup: async () => 'a'.repeat(64),
    },
    10n,
  );
  const context = await prepareScheduledTaskReview(
    tx,
    {
      round,
      creatorId: 'a',
      phase: 'basic',
      taskId: input().task.taskId,
      sessionBinding: 'b'.repeat(64),
      authorId: 'author',
    },
    11n,
  );
  assert.ok(context);
  const admit = () =>
    fullHistoryContext.run(context, () =>
      commit(db, () => admitScheduledXhs(tx, input())),
    );
  return { db, tx, old, writeOld, plan, context, admit };
}

test('exact retained terminal sourceActive permits another account without changing or replaying history', async () => {
  const f = await reviewedFixture();
  try {
    const snapshot = () =>
      f.db
        .prepare('SELECT * FROM xhs_subscription_tasks WHERE id=?')
        .get(f.old.taskId);
    const before = snapshot();
    const budgets = f.db
      .prepare('SELECT * FROM xhs_request_budgets ORDER BY id')
      .all();
    assert.deepEqual(f.plan.scope.exclusions.b, [
      { phase: 'detail', target: 'synthetic-old-note' },
    ]);
    assert.equal((await f.admit()).kind, 'created');
    assert.equal((await f.admit()).kind, 'existing');
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(
      f.db.prepare('SELECT * FROM xhs_request_budgets ORDER BY id').all(),
      budgets,
    );
    assert.equal(
      f.db.prepare('SELECT COUNT(*) n FROM xhs_unbound_owner_requests').get().n,
      0,
    );
  } finally {
    f.db.close();
  }
});

test('unreviewed retained sourceActive still blocks admission', async () => {
  const f = await reviewedFixture();
  try {
    assert.equal(
      (await commit(f.db, () => admitScheduledXhs(f.tx, input()))).reason,
      'XHS_SCHEDULE_SOURCE_BLOCKED',
    );
  } finally {
    f.db.close();
  }
});

for (const mutation of [
  'changed-active',
  'new-active',
  'changed-unknowns',
  'new-marker',
  'new-ledger',
]) {
  test(`reviewed baseline rejects ${mutation} before creating any scheduled work`, async () => {
    const f = await reviewedFixture();
    try {
      if (mutation === 'changed-active')
        f.writeOld({
          ...f.old,
          sourceActive: { ...f.old.sourceActive, noteId: 'new-note' },
        });
      if (mutation === 'new-active')
        f.db
          .prepare('INSERT INTO xhs_subscription_tasks VALUES(?,?,?,?,1)')
          .run(
            'new-task',
            'c',
            'blocked',
            JSON.stringify({ ...f.old, taskId: 'new-task', creatorId: 'c' }),
          );
      if (mutation === 'changed-unknowns')
        f.writeOld({
          ...f.old,
          sourceUnknowns: [
            { phase: 'detail', outcome: 'unknown', targetHash: 'f'.repeat(64) },
          ],
        });
      if (mutation === 'new-marker')
        f.db.exec(
          "INSERT INTO xhs_request_budgets(id,used,request_limit) VALUES('xhs:dispatch-pending:new',1,1)",
        );
      if (mutation === 'new-ledger')
        f.db.exec(
          "INSERT INTO xhs_unbound_owner_requests VALUES('new-operation','review','task','c','detail','new-note','unknown',NULL)",
        );
      await assert.rejects(f.admit(), /SCHEDULED_NEW_UNKNOWN_REVIEW_REQUIRED/);
      assert.equal(
        f.db
          .prepare('SELECT COUNT(*) n FROM xhs_subscription_tasks WHERE id=?')
          .get(input().task.taskId).n,
        0,
      );
    } finally {
      f.db.close();
    }
  });
}

for (const mutation of [
  'running',
  'queued',
  'state-mismatch',
  'task-mismatch',
  'creator-mismatch',
  'new-restriction',
  'other-corrupt-state',
]) {
  test(`retained receipt cannot exempt ${mutation} from the structural and live-task guards`, async () => {
    const f = await reviewedFixture();
    try {
      if (mutation === 'running' || mutation === 'queued')
        f.writeOld({ ...f.old, state: mutation });
      if (mutation === 'state-mismatch')
        f.writeOld({ ...f.old, state: 'completed' }, 'blocked');
      if (mutation === 'task-mismatch')
        f.writeOld({ ...f.old, taskId: 'not-the-row' });
      if (mutation === 'creator-mismatch')
        f.writeOld({ ...f.old, creatorId: 'not-the-creator' });
      if (mutation === 'new-restriction')
        f.writeOld({ ...f.old, code: 'XHS_SOURCE_AUTHENTICATION_BLOCKED' });
      if (mutation === 'other-corrupt-state')
        f.db.exec(
          "INSERT INTO xhs_subscription_tasks VALUES('other','c','invalid','{}',1)",
        );
      assert.equal((await f.admit()).reason, 'XHS_SCHEDULE_SOURCE_BLOCKED');
      assert.equal(
        f.db.prepare('SELECT COUNT(*) n FROM xhs_unbound_owner_requests').get()
          .n,
        0,
      );
    } finally {
      f.db.close();
    }
  });
}

test('stored retained baseline must still match its reviewed digest', async () => {
  const f = await reviewedFixture();
  try {
    const row = f.db
      .prepare('SELECT scope_json FROM xhs_unbound_owner_reviews WHERE id=?')
      .get(f.context.reviewId);
    const scope = JSON.parse(row.scope_json);
    scope.baseline.unknowns[0].sourceActive.noteId = 'tampered-review';
    f.db
      .prepare('UPDATE xhs_unbound_owner_reviews SET scope_json=? WHERE id=?')
      .run(JSON.stringify(scope), f.context.reviewId);
    await assert.rejects(f.admit(), /REVIEW_STATE_CHANGED/);
  } finally {
    f.db.close();
  }
});

for (const sourceActive of [false, 0, '']) {
  test(`malformed non-null sourceActive ${JSON.stringify(sourceActive)} remains blocked`, async () => {
    const { db, tx } = fixture();
    try {
      db.prepare('INSERT INTO xhs_subscription_tasks VALUES(?,?,?,?,1)').run(
        'old',
        'a',
        'blocked',
        JSON.stringify({
          taskId: 'old',
          creatorId: 'a',
          state: 'blocked',
          sourceActive,
        }),
      );
      assert.equal(
        (await commit(db, () => admitScheduledXhs(tx, input()))).reason,
        'XHS_SCHEDULE_SOURCE_BLOCKED',
      );
    } finally {
      db.close();
    }
  });
}
