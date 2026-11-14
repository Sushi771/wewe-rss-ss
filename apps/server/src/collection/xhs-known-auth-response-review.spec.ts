import { knownAuthCheckpointPredecessor } from './xhs-known-auth-checkpoint-successor';
import { ConfigService } from '@nestjs/config';
import { TrpcRouter } from '../trpc/trpc.router';
import { TrpcService } from '../trpc/trpc.service';
import {
  prepareKnownAuthProfile,
  runKnownAuthProfile,
} from './xhs-known-auth-profile-probe';
import { Prisma, PrismaClient } from '@prisma/client';
import { mkdtemp, readdir } from 'node:fs/promises';
import { prepareWriterSelf } from '../../../../scripts/local-release/writer-self.fixture.test.cjs';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { sqliteWrites } from './sqlite-write-coordinator';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { applyFixtureMigrations } from '../../test/redbook-isolated/fixture-migrations';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { assertLegacyXhsSourceReady } from './xhs-legacy-source-fence';
import { fullHistoryContext } from './xhs-full-history-scope';
import { knownAuthLineageFixture } from '../../test/redbook-isolated/known-auth-lineage.fixture';
import {
  admitUnboundRequest,
  settleUnboundRequest,
  assertUnboundDispatch,
  unboundRoundContext,
} from './xhs-unbound-round';
import { scheduledTaskId, admitScheduledXhs } from './xhs-scheduled-admission';
import {
  prepareScheduledPolicy,
  confirmScheduledPolicy,
  prepareScheduledTaskReview,
} from './xhs-scheduled-review-scope';
import {
  prepareKnownAuthResponseReview,
  readKnownAuthControlState,
  confirmKnownAuthResponseReview,
  assertKnownAuthCommittedSession,
  refreshKnownAuthAfterCommit,
  KnownAuthReviewHost,
} from './xhs-known-auth-response-review';

jest.setTimeout(60000);
const pack = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
const round = '2026-11-08/14:00';
const target = { taskId: scheduledTaskId(round, 'a', 'basic'), creatorId: 'a' };
const AUTH = 'XHS_SOURCE_AUTHENTICATION_BLOCKED';
let db: PrismaClient,
  runtime: XhsSubscriptionRuntime,
  host: KnownAuthReviewHost;
let context: any, original: any, operationId: string, activeTx: any;
let network: jest.SpyInstance;
let api: jest.Mock;
let profileResult: (id: string) => any;
let fixtureDatabase: string;
let fixtureEnvironment: NodeJS.ProcessEnv;
const taskRows = () =>
  db.$queryRawUnsafe<any[]>('SELECT * FROM xhs_subscription_tasks ORDER BY id');
const prep = () => prepareKnownAuthResponseReview(db, target, host);
const confirm = (digest: string) =>
  confirmKnownAuthResponseReview(target, digest, host, 400n);
async function snapshot() {
  const tables = await db.$queryRawUnsafe<any[]>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'xhs_*' ORDER BY name",
  );
  return pack(
    await Promise.all(
      tables.map(async (t) => [
        t.name,
        await db.$queryRawUnsafe(`SELECT * FROM ${t.name} ORDER BY rowid`),
      ]),
    ),
  );
}
async function mutateDoc(update: (d: any) => void, id = target.taskId) {
  const row = (await taskRows()).find((t) => t.id === id),
    d = JSON.parse(row.document);
  update(d);
  await db.$executeRawUnsafe(
    'UPDATE xhs_subscription_tasks SET document=? WHERE id=?',
    JSON.stringify(d),
    id,
  );
}
async function insertHistoryLineage() {
  const f = knownAuthLineageFixture(true);
  for (const [table, values] of [
    ['xhs_whole_creator_jobs', f.jobs],
    ['xhs_subscription_tasks', f.tasks],
  ] as const)
    for (const r of values)
      await db.$executeRawUnsafe(
        `INSERT INTO ${table} VALUES(?,?,?,?,?)`,
        r.id,
        r.creator_id,
        r.state,
        r.document,
        BigInt(r.updated_at),
      );
  for (const r of f.reviews)
    await db.$executeRawUnsafe(
      `INSERT INTO xhs_unbound_owner_reviews(${Object.keys(r).join(',')}) VALUES(${Object.keys(
        r,
      )
        .map(() => '?')
        .join(',')})`,
      ...Object.values(r),
    );
}
beforeEach(async () => {
  fixtureEnvironment = { ...process.env };
  const dir = await mkdtemp(path.join(tmpdir(), 'xhs-known-response-'));
  fixtureDatabase = path.join(dir, 'fixture.sqlite');
  db = new PrismaClient({
    datasources: {
      db: {
        url:
          'file:' +
          path.join(dir, 'fixture.sqlite').replace(/\\/g, '/') +
          '?connection_limit=1',
      },
    },
  });
  network = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(Error('NETWORK_FORBIDDEN'));
  api = jest.fn(async () => {
    throw Error('TRANSPORT_FORBIDDEN');
  });
  profileResult = (id) => ({
    id,
    name: 'Synthetic',
    profileUrl: 'https://www.xiaohongshu.com/user/profile/' + id,
  });
  runtime = new XhsSubscriptionRuntime({
    enabled: () => true,
    api,
    profileParser: (_raw, id) => profileResult(id),
  });
  await applyFixtureMigrations(
    'file:' +
      path.join(dir, 'fixture.sqlite').replace(/\\/g, '/') +
      '?connection_limit=1',
  );
  for (const id of ['a', 'b', 'c'])
    await db.xhsCreator.create({
      data: {
        id,
        externalAuthorId: 'author-' + id,
        displayName: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author-' + id,
        enabled: true,
      },
    });
  await db.$executeRawUnsafe(
    "INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('xhs:source-total',7,100,0,1000),('xhs:dispatch-pending:old-fixture',1,1,0,1000)",
  );
  await db.$executeRawUnsafe(
    "INSERT INTO xhs_subscription_tasks VALUES('old-fixture','b','blocked',?,1)",
    JSON.stringify({
      taskId: 'old-fixture',
      creatorId: 'b',
      state: 'blocked',
      code: 'XHS_SOURCE_TRANSPORT_BLOCKED',
      sourceActive: {
        phase: 'detail',
        outcome: 'started',
        targetHash: createHash('sha256')
          .update('historical-note')
          .digest('hex'),
        owner: randomUUID(),
      },
    }),
  );
  await runtime.connectSession({
    a1: 'synthetic-old',
    webSession: 'synthetic-old',
  });
  const oldBinding = runtime.fullScopeSessionBinding();
  const input = {
    creatorIds: ['a', 'b', 'c'],
    maxRequests: 20,
    phaseLimits: { profile: 3, list: 3, detail: 10, media: 10 },
  };
  if (
    expect.getState().currentTestName?.includes('exactly retained full-history')
  )
    await insertHistoryLineage();
  await db.$transaction(async (tx) => {
    const p = await prepareScheduledPolicy(tx, input);
    await confirmScheduledPolicy(
      tx,
      input,
      p.digest,
      {
        assertQuiescent: async () => {},
        verifyBackup: async () => 'd'.repeat(64),
      },
      10n,
    );
    context = await prepareScheduledTaskReview(
      tx,
      {
        ...target,
        phase: 'basic',
        round,
        sessionBinding: oldBinding,
        authorId: 'author-a',
      },
      20n,
    );
  });
  original = {
    taskId: target.taskId,
    creatorId: 'a',
    kind: 'list',
    state: 'blocked',
    code: AUTH,
    collectionStage: 'listing',
    schedule: { round, phase: 'basic', batch: 0 },
    scheduledContext: { authorId: 'author-a', used: 1, state: 'started' },
    taskFailure: {
      phase: 'listing',
      code: AUTH,
      errorKind: 'Error',
      dispatched: 'transport-entered',
    },
    total: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
    noteIds: [],
    items: {},
    sourceActive: null,
  };
  // Preserve noncanonical whitespace to prove original raw document bytes survive in audit.
  await db.$executeRawUnsafe(
    'INSERT INTO xhs_subscription_tasks VALUES(?,?,?,?,?)',
    target.taskId,
    'a',
    'blocked',
    JSON.stringify(original, null, 2),
    200n,
  );
  operationId = randomUUID();
  await db.$executeRawUnsafe(
    "INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,'response-received',NULL)",
    operationId,
    context.reviewId,
    target.taskId,
    'a',
    'profile',
    'profile:1',
  );
  await db.$executeRawUnsafe(
    "UPDATE xhs_source_risk SET state='blocked',code=?,owner=NULL,http_status=NULL,endpoint=NULL,updated_at=100 WHERE id='source'",
    AUTH,
  );
  const clock = jest.spyOn(Date, 'now').mockReturnValue(300);
  try {
    await runtime.connectSession({
      a1: 'synthetic-new',
      webSession: 'synthetic-new',
    });
  } finally {
    clock.mockRestore();
  }
  host = {
    knownAuthSessionForReview: () => runtime.knownAuthSessionForReview(),
    protectedTransaction: (work) =>
      db.$transaction(
        async (tx) => {
          activeTx = tx;
          try {
            return await work(tx);
          } finally {
            activeTx = undefined;
          }
        },
        { timeout: 30000 },
      ),
    assertQuiescent: async () => {},
    authorizePlan: async () => {},
    assertPolicyInstalled: async () => {},
    assertSafeRestorePolicy: async () => {},
  };
});

it.each([
  ['earlier exact response', 'accept'],
  ['same-time response', 'newer'],
  ['later response', 'later'],
  ['other platform restriction', 'other'],
  ['unknown response', 'unknown'],
  ['additional request', 'extra'],
])(
  'recognizes only a proven earlier AUTH failure: %s',
  async (_label, mode) => {
    const id = 'earlier-auth';
    const doc = {
      ...original,
      taskId: id,
      creatorId: 'b',
      ...(mode === 'other' ? { extra: { httpStatus: 429 } } : {}),
    };
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_subscription_tasks VALUES(?,?,?,?,?)',
      id,
      'b',
      'blocked',
      JSON.stringify(doc),
      mode === 'newer' ? 100n : mode === 'later' ? 101n : 50n,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO xhs_unbound_owner_reviews
     SELECT ?,?,original_risk_json,original_outcome,old_task_ids_json,old_job_ids_json,creator_bindings_json,budget_snapshot_json,scope_json,backup_sha256,approved_at
     FROM xhs_unbound_owner_reviews WHERE id=?`,
      'earlier-review',
      'e'.repeat(64),
      context.reviewId,
    );
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,?,NULL)',
      randomUUID(),
      'earlier-review',
      id,
      'b',
      'profile',
      'profile:1',
      mode === 'unknown' ? 'unknown' : 'response-received',
    );
    if (mode === 'extra')
      await db.$executeRawUnsafe(
        'INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,?,NULL)',
        randomUUID(),
        'earlier-review',
        id,
        'b',
        'list',
        'list:1',
        'response-received',
      );
    const before = await snapshot();
    if (mode === 'accept') await expect(prep()).resolves.toBeDefined();
    else await expect(prep()).rejects.toThrow();
    expect(await snapshot()).toBe(before);
  },
);

it.each([
  'success',
  'rollback',
  'ack-lost',
  'refresh-failed',
  'concurrent-writer',
  'restored-saved',
  'origin-not-confirmed',
  'unsafe-journal',
])('protected service wiring: %s', async (mode) => {
  if (mode === 'restored-saved') {
    runtime.onModuleDestroy();
    runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      vault: {
        status: async () => ({ stored: true }),
        policy: async () => ({ autoRestore: true, needsReconnect: false }),
        load: async () => ({
          a1: 'synthetic-saved',
          web_session: 'synthetic-saved',
        }),
        store: async () => {
          throw Error('SAVE_FORBIDDEN');
        },
        disconnect: async () => {
          throw Error('DISCONNECT_FORBIDDEN');
        },
      },
    });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(150);
    try {
      await runtime.onModuleInit();
    } finally {
      clock.mockRestore();
    }
    expect(() => runtime.replacementSessionForReview()).toThrow();
  }
  runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
  (runtime as any).stopCode = AUTH;
  const subscriptions: any = { hasLocalSourceWork: () => false };
  const service: any = new XhsWholeCreatorService(
    db as any,
    subscriptions,
    runtime,
    {} as any,
  );
  service.readyForMutation = async () => {};
  db.$use((params, next) =>
    sqliteWrites.write(() => next(params), params.runInTransaction === true),
  );
  (createVerifiedSqliteBackup as jest.Mock)
    .mockReset()
    .mockRejectedValue(Error('FULL_BACKUP_FORBIDDEN'));
  const p = await service.prepareKnownResponseAuthReview(target),
    before = await snapshot();
  if (mode === 'unsafe-journal')
    await db.$queryRawUnsafe('PRAGMA synchronous=OFF');
  const realWrite = service.write.bind(service);
  if (mode === 'rollback')
    service.write = (fn: any) =>
      realWrite(async (tx: any) => {
        await fn(tx);
        throw Error('SYNTHETIC_ROLLBACK');
      });
  if (mode === 'ack-lost')
    service.write = async (fn: any) => {
      await realWrite(fn);
      throw Error('SYNTHETIC_ACK_LOST');
    };
  const refresh = jest.spyOn(runtime, 'refreshKnownAuthSession');
  if (mode === 'refresh-failed')
    refresh.mockRejectedValue(Error('SYNTHETIC_REFRESH_FAILURE'));
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>((r) => {
      release = r;
    }),
    refreshing = new Promise<void>((r) => {
      entered = r;
    });
  const events: string[] = [];
  if (mode === 'concurrent-writer') {
    refresh.mockImplementation(async (binding, version) => {
      events.push('refresh-start');
      entered();
      await paused;
      await XhsSubscriptionRuntime.prototype.refreshKnownAuthSession.call(
        runtime,
        binding,
        version,
      );
      events.push('refresh-finish');
    });
  }
  // Created before confirmation: no inherited protected AsyncLocalStorage permit.
  const competing =
    mode === 'concurrent-writer'
      ? (async () => {
          await refreshing;
          await sqliteWrites.write(async () => {
            events.push('writer');
            await db.$executeRawUnsafe(
              "UPDATE xhs_source_risk SET state='blocked',code='XHS_SOURCE_VERIFICATION_BLOCKED',updated_at=999999 WHERE id='source'",
            );
          });
        })()
      : undefined;
  const pending = service.confirmKnownResponseAuthReview({
    ...target,
    digest: p.digest,
    acknowledgedKnownResponseAuth: true,
    confirmedSessionOrigin:
      mode === 'origin-not-confirmed'
        ? 'user-confirmed-restored-saved-session'
        : p.sessionOrigin,
  });
  if (mode === 'concurrent-writer') {
    await refreshing;
    await Promise.resolve();
    expect(events).toEqual(['refresh-start']);
    release();
  }
  if (['origin-not-confirmed', 'unsafe-journal'].includes(mode)) {
    await expect(pending).rejects.toThrow(
      mode === 'unsafe-journal'
        ? 'INCREMENTAL_DURABILITY_MODE_UNPROVED'
        : 'PLAN_NOT_AUTHORIZED',
    );
    expect(await snapshot()).toBe(before);
    expect(refresh).not.toHaveBeenCalled();
  } else if (mode === 'rollback') {
    await expect(pending).rejects.toThrow('SYNTHETIC_ROLLBACK');
    expect(await snapshot()).toBe(before);
    expect(refresh).not.toHaveBeenCalled();
  } else {
    const result = await pending;
    expect(result).toMatchObject({
      state: ['ack-lost', 'refresh-failed'].includes(mode)
        ? 'committed-runtime-blocked'
        : 'confirmed-runtime-ready',
      authenticationVerified: false,
      sourceRequestsSent: 0,
      newGrant: false,
    });
    if (mode === 'ack-lost') expect(refresh).not.toHaveBeenCalled();
    if (['ack-lost', 'refresh-failed'].includes(mode)) {
      expect((runtime as any).stopCode).toBe(AUTH);
      expect(result.doNotRetryConfirmation).toBe(true);
      await expect(
        service.confirmKnownResponseAuthReview({
          ...target,
          digest: p.digest,
          acknowledgedKnownResponseAuth: true,
          confirmedSessionOrigin: p.sessionOrigin,
        }),
      ).rejects.toThrow();
      expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
    }
    await competing;
    if (mode === 'concurrent-writer')
      expect(events).toEqual(['refresh-start', 'refresh-finish', 'writer']);
    expect(
      JSON.parse(
        (await taskRows()).find((r) => r.id === target.taskId).document,
      ).knownResponseAuthReviews,
    ).toHaveLength(1);
  }
  expect(api).not.toHaveBeenCalled();
  expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
  expect(await readdir(path.dirname(fixtureDatabase))).not.toContain('backups');
  refresh.mockRestore();
});
afterEach(async () => {
  process.env = fixtureEnvironment;
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
  runtime.onModuleDestroy();
  await db.$disconnect();
  // Fixtures are deliberately retained. No production copies or deletion of backups.
});

it('prepare is read-only; confirm appends one audit and clears only exact risk, retaining raw original evidence', async () => {
  const before = await snapshot(),
    tasks = await taskRows();
  const p = await prep();
  expect(await snapshot()).toBe(before);
  const result = await confirm(p.digest);
  expect(result).toMatchObject({
    originalOutcome: 'response-received',
    authenticationVerified: false,
    sourceRequestsSent: 0,
    newGrant: false,
  });
  const after = await taskRows(),
    row = after.find((t) => t.id === target.taskId),
    d = JSON.parse(row.document);
  const [audit] = d.knownResponseAuthReviews;
  expect(d.knownResponseAuthReviews).toHaveLength(1);
  expect(audit.originalTaskRaw).toBe(
    tasks.find((t) => t.id === target.taskId).document,
  );
  delete d.knownResponseAuthReviews;
  expect(d).toEqual(original);
  expect(row.updated_at).toBe(200n);
  expect(after.filter((t) => t.id !== target.taskId)).toEqual(
    tasks.filter((t) => t.id !== target.taskId),
  );
  // Comparing every table after reversing only the two intended changes proves no
  // budget, policy, old review, ledger, other task or application row changed.
  await db
    .$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'UPDATE xhs_subscription_tasks SET document=? WHERE id=?',
        audit.originalTaskRaw,
        target.taskId,
      );
      await tx.$executeRawUnsafe(
        "UPDATE xhs_source_risk SET state='blocked',code=?,updated_at=100 WHERE id='source'",
        AUTH,
      );
      // Verification mutation only in synthetic fixture and rolled back intentionally.
      const tables = await tx.$queryRawUnsafe<any[]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'xhs_*' ORDER BY name",
      );
      expect(
        pack(
          await Promise.all(
            tables.map(async (t) => [
              t.name,
              await tx.$queryRawUnsafe(
                `SELECT * FROM ${t.name} ORDER BY rowid`,
              ),
            ]),
          ),
        ),
      ).toBe(before);
      throw Error('FIXTURE_ROLLBACK');
    })
    .catch((e) => {
      expect(e.message).toBe('FIXTURE_ROLLBACK');
    });
  await expect(confirm(p.digest)).rejects.toThrow();
});

it.each([
  [
    'wrong creator',
    async () => {
      target.creatorId = 'b';
    },
  ],
  [
    'missing ledger',
    async () => {
      await db.$executeRawUnsafe(
        'DELETE FROM xhs_unbound_owner_requests WHERE operation_id=?',
        operationId,
      );
    },
  ],
  [
    'second ledger',
    async () => {
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,'response-received',NULL)",
        randomUUID(),
        context.reviewId,
        target.taskId,
        'a',
        'profile',
        'profile:2',
      );
    },
  ],
  [
    'wrong phase',
    async () => {
      await db.$executeRawUnsafe(
        "UPDATE xhs_unbound_owner_requests SET phase='list' WHERE operation_id=?",
        operationId,
      );
    },
  ],
  [
    'wrong outcome',
    async () => {
      await db.$executeRawUnsafe(
        "UPDATE xhs_unbound_owner_requests SET outcome='unknown' WHERE operation_id=?",
        operationId,
      );
    },
  ],
  [
    'listed note ids',
    async () => {
      await db.$executeRawUnsafe(
        "UPDATE xhs_unbound_owner_requests SET listed_note_ids_json='[]' WHERE operation_id=?",
        operationId,
      );
    },
  ],
  [
    'new active',
    async () =>
      mutateDoc((d) => {
        d.sourceActive = { phase: 'profile' };
      }),
  ],
  [
    'verification in taskFailure',
    async () =>
      mutateDoc((d) => {
        d.taskFailure.code = 'XHS_SOURCE_VERIFICATION_BLOCKED';
      }),
  ],
  [
    'extra taskFailure field',
    async () =>
      mutateDoc((d) => {
        d.taskFailure.httpStatus = 401;
      }),
  ],
  [
    'wrong task phase',
    async () =>
      mutateDoc((d) => {
        d.taskFailure.phase = 'details';
      }),
  ],
  [
    'wrong author',
    async () =>
      mutateDoc((d) => {
        d.scheduledContext.authorId = 'author-b';
      }),
  ],
  [
    'wrong round',
    async () =>
      mutateDoc((d) => {
        d.schedule.round = '2026-11-08/17:30';
      }),
  ],
  [
    'new unknown',
    async () =>
      mutateDoc((d) => {
        d.sourceUnknowns = [{ phase: 'profile' }];
      }),
  ],
  [
    'changed old unknown',
    async () =>
      mutateDoc((d) => {
        d.sourceActive.targetHash = 'f'.repeat(64);
      }, 'old-fixture'),
  ],
  [
    'extra nested restriction',
    async () =>
      mutateDoc((d) => {
        d.extra = { receipt: { httpStatus: 429 } };
      }),
  ],
  [
    'nested reserved audit key',
    async () =>
      mutateDoc((d) => {
        d.extra = {
          knownResponseAuthReviews: [
            { code: 'XHS_SOURCE_VERIFICATION_BLOCKED' },
          ],
        };
      }),
  ],
  [
    'nested reserved handoff key',
    async () =>
      mutateDoc((d) => {
        d.sourceReceipt = { historyHandoff: { httpStatus: 461 } };
      }),
  ],
  [
    'target reserved root audit',
    async () =>
      mutateDoc((d) => {
        d.genericRiskReviews = [];
      }),
  ],
  [
    'primitive items',
    async () =>
      mutateDoc((d) => {
        d.items = 1;
      }),
  ],
  [
    'pending risk',
    async () => {
      await db.$executeRawUnsafe("UPDATE xhs_source_risk SET state='pending'");
    },
  ],
  [
    'wrong risk endpoint',
    async () => {
      await db.$executeRawUnsafe(
        "UPDATE xhs_source_risk SET endpoint='profile'",
      );
    },
  ],
  [
    'wrong risk owner',
    async () => {
      await db.$executeRawUnsafe("UPDATE xhs_source_risk SET owner='other'");
    },
  ],
  [
    'wrong risk status',
    async () => {
      await db.$executeRawUnsafe('UPDATE xhs_source_risk SET http_status=401');
    },
  ],
  [
    'risk after task terminal',
    async () => {
      await db.$executeRawUnsafe('UPDATE xhs_source_risk SET updated_at=201');
    },
  ],
  [
    'risk before request review',
    async () => {
      await db.$executeRawUnsafe('UPDATE xhs_source_risk SET updated_at=20');
    },
  ],
  [
    'count not zero',
    async () =>
      mutateDoc((d) => {
        d.completed = 1;
      }),
  ],
  [
    'missing task',
    async () => {
      await db.$executeRawUnsafe(
        'DELETE FROM xhs_subscription_tasks WHERE id=?',
        target.taskId,
      );
    },
  ],
  [
    'wrong ledger creator',
    async () => {
      await db.$executeRawUnsafe(
        "UPDATE xhs_unbound_owner_requests SET creator_id='b' WHERE operation_id=?",
        operationId,
      );
    },
  ],
  [
    'creator disabled',
    async () => {
      await db.$executeRawUnsafe(
        "UPDATE xhs_creators SET enabled=0 WHERE id='a'",
      );
    },
  ],
  [
    'policy revoked',
    async () => {
      const [r] = await db.$queryRawUnsafe<any[]>(
        'SELECT * FROM xhs_unbound_owner_reviews WHERE id=?',
        context.reviewId,
      );
      await db.$executeRawUnsafe(
        'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        'synthetic-revocation',
        'f'.repeat(64),
        '{}',
        'unknown',
        '[]',
        '[]',
        '{}',
        '[]',
        JSON.stringify({
          reviewKind: 'scheduled-recurring-revocation-v1',
          policyId: JSON.parse(r.scope_json).policyId,
        }),
        'd'.repeat(64),
        250n,
      );
    },
  ],
  [
    'new other auth task',
    async () => {
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_subscription_tasks VALUES('other','b','blocked',?,201)",
        JSON.stringify({
          taskId: 'other',
          creatorId: 'b',
          state: 'blocked',
          code: AUTH,
        }),
      );
    },
  ],
  [
    'busy task',
    async () => {
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_subscription_tasks VALUES('busy','b','queued',?,201)",
        JSON.stringify({ taskId: 'busy', creatorId: 'b', state: 'queued' }),
      );
    },
  ],
  [
    'legacy unresolved',
    async () => {
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_limited_recovery(id,note_id,author_id,owner,state,expires_at,created_at,updated_at) VALUES('single-round','n','a','o','unknown',1,1,1)",
      );
    },
  ],
] as const)('rejects %s without writes', async (_label, mutate) => {
  try {
    await mutate();
    const before = await snapshot();
    await expect(prep()).rejects.toThrow();
    expect(await snapshot()).toBe(before);
  } finally {
    target.creatorId = 'a';
  }
});

it.each([
  'VERIFICATION',
  'PERMISSION',
  'SIGNATURE',
  'RATE_LIMIT',
  'UNKNOWN_REJECTION',
  'TRANSPORT',
])('rejects risk %s', async (code) => {
  await db.$executeRawUnsafe(
    'UPDATE xhs_source_risk SET code=?',
    `XHS_SOURCE_${code}_BLOCKED`,
  );
  await expect(prep()).rejects.toThrow('KNOWN_AUTH_RISK_REQUIRED');
});
it.each([99, 100, 199, 200])(
  'requires connectedAt strictly after BOTH risk and terminal task (%s)',
  async (time) => {
    host.knownAuthSessionForReview = () => ({
      binding: 'f'.repeat(64),
      connectedAt: time,
    });
    await expect(prep()).rejects.toThrow('FRESH_RUNTIME_SESSION_REQUIRED');
  },
);
it('binds the authorized digest to budgets and refuses stale/different session plans', async () => {
  const p = await prep();
  await expect(confirm('0'.repeat(64))).rejects.toThrow('REVIEW_STATE_CHANGED');
  await db.$executeRawUnsafe(
    "UPDATE xhs_request_budgets SET used=used+1 WHERE id='xhs:source-total'",
  );
  await expect(confirm(p.digest)).rejects.toThrow('REVIEW_STATE_CHANGED');
  const next = await prep();
  await runtime.connectSession({
    a1: 'synthetic-third',
    webSession: 'synthetic-third',
  });
  await expect(confirm(next.digest)).rejects.toThrow('REVIEW_STATE_CHANGED');
});

it.each([
  'authorization',
  'transaction-admission',
  'policy',
  'restore-policy',
  'busy',
  'session-last',
  'history-after-write',
  'task-cas',
  'risk-cas',
  'audit-write',
])('rolls back both audit and risk on %s', async (fault) => {
  const p = await prep(),
    before = await snapshot();
  let count = 0;
  if (fault === 'authorization')
    host.authorizePlan = async () => {
      throw Error('PLAN_NOT_AUTHORIZED');
    };
  if (fault === 'transaction-admission')
    host.protectedTransaction = async () => {
      throw Error('INCREMENTAL_DURABILITY_MODE_UNPROVED');
    };
  if (fault === 'policy')
    host.assertPolicyInstalled = async () => {
      throw Error('POLICY_CHANGED');
    };
  if (fault === 'restore-policy')
    host.assertSafeRestorePolicy = async () => {
      throw Error('RESTORE_UNPROVED');
    };
  if (fault === 'busy')
    host.assertQuiescent = async () => {
      if (++count === 3) throw Error('BUSY_AFTER_WRITE');
    };
  if (fault === 'session-last')
    host.knownAuthSessionForReview = () => {
      const s = runtime.knownAuthSessionForReview();
      return ++count === 6 ? { ...s, binding: 'f'.repeat(64) } : s;
    };
  if (fault === 'history-after-write')
    host.assertSafeRestorePolicy = async () => {
      if (++count === 2)
        await activeTx.$executeRawUnsafe(
          "UPDATE xhs_request_budgets SET used=used+1 WHERE id='xhs:source-total'",
        );
    };
  if (['task-cas', 'risk-cas', 'audit-write'].includes(fault))
    host.protectedTransaction = (work) =>
      db.$transaction((tx) =>
        work({
          $queryRawUnsafe: (sql, ...args) => tx.$queryRawUnsafe(sql, ...args),
          $executeRawUnsafe: async (sql, ...args) => {
            if (sql.startsWith('UPDATE xhs_subscription_tasks')) {
              if (fault === 'task-cas') return 0;
              if (fault === 'audit-write') throw Error('AUDIT_WRITE_FAILED');
            }
            if (
              fault === 'risk-cas' &&
              sql.startsWith('UPDATE xhs_source_risk')
            )
              return 0;
            return tx.$executeRawUnsafe(sql, ...args);
          },
        }),
      );
  await expect(confirm(p.digest)).rejects.toThrow();
  expect(await snapshot()).toBe(before);
});

it('freezes reviewed task against stale persistence, forged/changed audits, resume and copying to a new task', async () => {
  await confirm((await prep()).digest);
  const service: any = new XhsSubscriptionService(db as any, runtime);
  service.readyForMutation = async () => {};
  const before = await snapshot();
  expect(
    await db.$transaction((tx) => service.persistIn(tx, { ...original })),
  ).toBe(0);
  expect(await snapshot()).toBe(before);
  const d = JSON.parse(
    (await taskRows()).find((r) => r.id === target.taskId).document,
  );
  expect(service.view(d).resumable).toBe(false);
  expect(service.view(d)).not.toHaveProperty('knownResponseAuthReviews');
  await expect(service.resumeTask({ taskId: target.taskId })).rejects.toThrow(
    'XHS_TASK_NOT_RESUMABLE',
  );
  for (const changed of [
    { ...d, knownResponseAuthReviews: [] },
    { ...d, completed: 1 },
    { ...d, taskId: 'forged' },
    { ...original, taskId: 'stale-child', resumedFromTaskId: target.taskId },
  ])
    await expect(
      db.$transaction((tx) => service.persistIn(tx, changed)),
    ).rejects.toThrow();
  expect(await snapshot()).toBe(before);
  await service.onModuleDestroy();
});

it('normal scheduled service/runtime admits the future round with synthetic transport, never the old round', async () => {
  runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
  runtime.bindFullHistoryWriter((work) => db.$transaction((tx) => work(tx)));
  runtime.bindFullHistoryReader((work) => db.$transaction((tx) => work(tx)));
  runtime.bindFullHistoryLegacyGuard(() => assertLegacyXhsSourceReady(db));
  const result = await confirm((await prep()).digest);
  await refreshKnownAuthAfterCommit(db, result, runtime);
  api.mockImplementation(async (request: any) => ({
    status: 200,
    url: request.url,
    body: {
      success: true,
      code: 0,
      data: new URL(request.url).pathname.includes('otherinfo')
        ? { syntheticProfile: true }
        : { notes: [], cursor: '', has_more: false },
    },
  }));
  const service: any = new XhsSubscriptionService(db as any, runtime);
  service.write = async (_bytes: number, work: any) => db.$transaction(work);
  try {
    for (const creatorId of ['a', 'b', 'c']) {
      await expect(
        service.scheduleCreatorPhase({ round, creatorId, phase: 'basic' }),
      ).rejects.toThrow();
      await service.lane;
    }
    expect(api).not.toHaveBeenCalled();
    const before = (await taskRows()).find((r) => r.id === target.taskId);
    for (const creatorId of ['a', 'b', 'c']) {
      await service.scheduleCreatorPhase({
        round: '2026-11-08/17:30',
        creatorId,
        phase: 'basic',
      });
      await service.lane;
      const diagnostic = await service.task({
        taskId: scheduledTaskId('2026-11-08/17:30', creatorId, 'basic'),
      });
      if (diagnostic.state !== 'completed')
        throw Error(
          pack({
            diagnostic,
            internal: (await taskRows()).find(
              (r) => r.id === diagnostic.taskId,
            ),
            calls: api.mock.calls.length,
            resultTypes: api.mock.results.map((r) => r.type),
          }),
        );
      expect(
        await service.task({
          taskId: scheduledTaskId('2026-11-08/17:30', creatorId, 'basic'),
        }),
      ).toMatchObject({ state: 'completed' });
    }
    expect(api).toHaveBeenCalledTimes(6);
    expect((await taskRows()).find((r) => r.id === target.taskId)).toEqual(
      before,
    );
  } finally {
    await service.onModuleDestroy();
  }
});

it('retained auth sourceActive remains blocked by real admission, not exempted to make recovery pass', async () => {
  // Code is outside baseline; a retained auth event is not permission to bypass
  // the existing platform restriction check in actual task admission.
  await mutateDoc((d) => {
    d.code = AUTH;
  }, 'old-fixture');
  await confirm((await prep()).digest);
  const nextRound = '2026-11-08/17:30',
    taskId = scheduledTaskId(nextRound, 'a', 'basic');
  const c = await db.$transaction((tx) =>
    prepareScheduledTaskReview(
      tx,
      {
        round: nextRound,
        creatorId: 'a',
        phase: 'basic',
        taskId,
        sessionBinding: runtime.fullScopeSessionBinding(),
        authorId: 'author-a',
      },
      500n,
    ),
  );
  const result = await fullHistoryContext.run(c!, () =>
    db.$transaction((tx) =>
      admitScheduledXhs(tx, {
        round: nextRound,
        creatorId: 'a',
        phase: 'basic',
        task: { taskId, creatorId: 'a', state: 'queued' },
        now: 500,
      }),
    ),
  );
  expect(result).toMatchObject({
    kind: 'blocked',
    reason: 'XHS_SCHEDULE_SOURCE_BLOCKED',
  });
  expect(api).not.toHaveBeenCalled();
});

it('does not query archive bodies or video blobs, regardless of their size', async () => {
  const first = await prep();
  await db.$executeRawUnsafe(
    "INSERT INTO xhs_notes(id,creator_id,title,publish_time,status,content_html,video_bytes) VALUES('large-fixture','a','Synthetic',0,'complete',?,zeroblob(8388608))",
    'x'.repeat(1024 * 1024),
  );
  const queried: string[] = [];
  const tx = {
    $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => {
      queried.push(sql);
      if (/\b(?:xhs_notes|xhs_saved_comments|xhs_metric_snapshots)\b/.test(sql))
        throw Error('CONTENT_QUERY_FORBIDDEN');
      return db.$queryRawUnsafe<T>(sql, ...args);
    },
    $executeRawUnsafe: async () => {
      throw Error('PREPARE_WRITE_FORBIDDEN');
    },
  };
  expect((await prepareKnownAuthResponseReview(tx, target, host)).digest).toBe(
    first.digest,
  );
  expect(queried.length).toBeGreaterThan(0);
});

it('requires exact committed same runtime session; restore/no binding or failed refresh cannot acknowledge recovery', async () => {
  const p = await prep();
  const result = await confirm(p.digest);
  await expect(
    refreshKnownAuthAfterCommit(db, result, {
      ...host,
      refreshAfterAuthSessionReview: async () => {
        throw Error('REFRESH_FAILED');
      },
    }),
  ).rejects.toThrow('REFRESH_FAILED');
  const refresh = jest.fn(async () => {});
  await refreshKnownAuthAfterCommit(db, result, {
    ...host,
    refreshAfterAuthSessionReview: refresh,
  });
  expect(refresh).toHaveBeenCalledWith(result.session.binding);
  await assertKnownAuthCommittedSession(db, result, runtime);
  await expect(
    assertKnownAuthCommittedSession(
      db,
      { ...result, digest: '0'.repeat(64) },
      runtime,
    ),
  ).rejects.toThrow('KNOWN_AUTH_COMMITTED_REVIEW_REQUIRED');
  const lost = {
    knownAuthSessionForReview: () => {
      throw Error('XHS_SESSION_CHANGED');
    },
  };
  await expect(
    assertKnownAuthCommittedSession(db, result, lost),
  ).rejects.toThrow('XHS_SESSION_CHANGED');
  const restarted = new XhsSubscriptionRuntime({ enabled: () => true });
  try {
    await expect(
      assertKnownAuthCommittedSession(db, result, restarted),
    ).rejects.toThrow('XHS_SESSION_CHANGED');
  } finally {
    restarted.onModuleDestroy();
  }
});

it('has no fallible database proof after the final synchronous memory refresh', async () => {
  const result = await confirm((await prep()).digest);
  let refreshed = false;
  const tx = {
    $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => {
      if (refreshed) throw Error('POST_REFRESH_READ_FORBIDDEN');
      return db.$queryRawUnsafe<T>(sql, ...args);
    },
    $executeRawUnsafe: async () => {
      throw Error('REFRESH_WRITE_FORBIDDEN');
    },
  };
  await refreshKnownAuthAfterCommit(tx, result, {
    ...host,
    refreshAfterAuthSessionReview: async () => {
      refreshed = true;
    },
  });
  expect(refreshed).toBe(true);
});

it('permits only a future natural round under unchanged policy; old round all creators closed, next unknown closes source', async () => {
  const result = await confirm((await prep()).digest);
  await refreshKnownAuthAfterCommit(db, result, {
    ...host,
    refreshAfterAuthSessionReview: async () => {},
  });
  const sessionBinding = runtime.fullScopeSessionBinding();
  for (const creatorId of ['a', 'b', 'c'])
    await expect(
      db.$transaction((tx) =>
        prepareScheduledTaskReview(
          tx,
          {
            round,
            creatorId,
            phase: 'basic',
            taskId: scheduledTaskId(round, creatorId, 'basic'),
            sessionBinding,
            authorId: 'author-' + creatorId,
          },
          500n,
        ),
      ),
    ).rejects.toThrow();
  await assertKnownAuthCommittedSession(db, result, runtime);
  const future = '2026-11-08/17:30',
    taskId = scheduledTaskId(future, 'a', 'basic');
  const c = await db.$transaction((tx) =>
    prepareScheduledTaskReview(
      tx,
      {
        round: future,
        creatorId: 'a',
        phase: 'basic',
        taskId,
        sessionBinding,
        authorId: 'author-a',
      },
      500n,
    ),
  );
  expect(c).toBeDefined();
  await db.$executeRawUnsafe(
    'INSERT INTO xhs_subscription_tasks VALUES(?,?,?,?,?)',
    taskId,
    'a',
    'running',
    JSON.stringify({
      taskId,
      creatorId: 'a',
      state: 'running',
      schedule: { round: future, phase: 'basic', batch: 0 },
    }),
    500n,
  );
  await fullHistoryContext.run(c!, async () => {
    const q = {
      operationId: randomUUID(),
      taskId,
      creatorId: 'a',
      phase: 'profile' as const,
      target: 'profile:1',
    };
    await db.$transaction((tx) => admitUnboundRequest(tx, c!.reviewId, q));
    await db.$transaction((tx) =>
      settleUnboundRequest(tx, c!.reviewId, q.operationId, 'unknown'),
    );
    await expect(
      db.$transaction((tx) =>
        admitUnboundRequest(tx, c!.reviewId, {
          ...q,
          operationId: randomUUID(),
          target: 'profile:2',
        }),
      ),
    ).rejects.toThrow();
  });
  await expect(
    assertKnownAuthCommittedSession(db, result, runtime),
  ).rejects.toThrow();
  expect(
    JSON.parse((await taskRows()).find((t) => t.id === target.taskId).document)
      .scheduledContext.state,
  ).toBe('started');
});

it('retains historical unknown target exclusion for future round', async () => {
  await confirm((await prep()).digest);
  const future = '2026-11-08/17:30',
    taskId = scheduledTaskId(future, 'b', 'basic');
  const c = await db.$transaction((tx) =>
    prepareScheduledTaskReview(
      tx,
      {
        round: future,
        creatorId: 'b',
        phase: 'basic',
        taskId,
        sessionBinding: runtime.fullScopeSessionBinding(),
        authorId: 'author-b',
      },
      500n,
    ),
  );
  await db.$executeRawUnsafe(
    'INSERT INTO xhs_subscription_tasks VALUES(?,?,?,?,?)',
    taskId,
    'b',
    'running',
    JSON.stringify({
      taskId,
      creatorId: 'b',
      state: 'running',
      schedule: { round: future, phase: 'basic', batch: 0 },
    }),
    500n,
  );
  await fullHistoryContext.run(c!, async () => {
    await expect(
      db.$transaction((tx) =>
        admitUnboundRequest(tx, c!.reviewId, {
          operationId: randomUUID(),
          taskId,
          creatorId: 'b',
          phase: 'detail',
          target: 'historical-note',
        }),
      ),
    ).rejects.toThrow('HISTORICAL_UNKNOWN_TARGET_EXCLUDED');
  });
});

it.each([false, true])(
  'preserves exact historical generic verification review projection (tampered=%s)',
  async (tampered) => {
    const old = {
      id: 'old-verification',
      state: 'paused',
      document: JSON.stringify(
        {
          id: 'old-verification',
          state: 'paused',
          code: 'XHS_SOURCE_VERIFICATION_BLOCKED',
        },
        null,
        2,
      ),
      updated_at: '1',
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(old))
      .digest('hex');
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_whole_creator_jobs VALUES(?,?,?,?,?)',
      old.id,
      'b',
      old.state,
      old.document,
      1n,
    );
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_whole_creator_jobs VALUES(?,?,?,?,?)',
      'historical-review',
      'c',
      'partial',
      JSON.stringify({
        id: 'historical-review',
        state: 'partial',
        historyHandoff: { confirmedAt: 2 },
        genericRiskReviews: [
          {
            version: 1,
            digest: 'd'.repeat(64),
            confirmedAt: 4,
            acknowledgedLoginAndVerification: true,
            outcome: 'unknown',
            requestIdentity: 'unknown',
            risk: {
              state: 'blocked',
              code: 'XHS_SOURCE_RISK_REVIEW_REQUIRED',
              owner: null,
              http_status: null,
              endpoint: null,
              updated_at: '3',
            },
            historicalRestrictions: [
              {
                code: 'XHS_SOURCE_VERIFICATION_BLOCKED',
                updatedAt: '1',
                fingerprint: tampered ? '0'.repeat(64) : fingerprint,
              },
            ],
          },
        ],
      }),
      4n,
    );
    const before = await db.$queryRawUnsafe(
      'SELECT * FROM xhs_whole_creator_jobs ORDER BY id',
    );
    if (tampered)
      await expect(prep()).rejects.toThrow('OTHER_PLATFORM_RESTRICTION');
    else await confirm((await prep()).digest);
    expect(
      await db.$queryRawUnsafe(
        'SELECT * FROM xhs_whole_creator_jobs ORDER BY id',
      ),
    ).toEqual(before);
  },
);
it.each([
  'valid',
  'new-code',
  'new-field',
  'annotation-extra',
  'sql-time',
  'task-binding',
  'nested-live-risk',
])(
  'recognizes only an exactly retained full-history annotation without changing any historical row: %s',
  async (mode) => {
    if (mode !== 'valid') {
      const table = ['task-binding', 'nested-live-risk'].includes(mode)
        ? 'xhs_subscription_tasks'
        : 'xhs_whole_creator_jobs';
      const id =
        table === 'xhs_subscription_tasks' ? 'full-task' : 'historical-job';
      const [r] = await db.$queryRawUnsafe<any[]>(
        `SELECT * FROM ${table} WHERE id=?`,
        id,
      );
      const doc = JSON.parse(r.document);
      if (mode === 'new-code') doc.code = 'XHS_SOURCE_RATE_LIMIT_BLOCKED';
      if (mode === 'new-field') doc.unknownField = 'not-reviewed';
      if (mode === 'annotation-extra') doc.fullHistoryReview.extra = false;
      if (mode === 'task-binding') doc.creatorId = 'c';
      if (mode === 'nested-live-risk')
        doc.unrecognized = { nested: { httpStatus: 429 } };
      await db.$executeRawUnsafe(
        `UPDATE ${table} SET document=?,updated_at=? WHERE id=?`,
        JSON.stringify(doc),
        mode === 'sql-time' ? 8n : r.updated_at,
        id,
      );
    }
    const before = await snapshot();
    if (mode === 'valid')
      expect((await prep()).authenticationVerified).toBe(false);
    else await expect(prep()).rejects.toThrow('OTHER_PLATFORM_RESTRICTION');
    expect(await snapshot()).toBe(before);
    expect(network).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  },
);

jest.mock('./sqlite-backup', () => ({
  ...jest.requireActual('./sqlite-backup'),
  createVerifiedSqliteBackup: jest.fn(),
}));
beforeAll(prepareWriterSelf);

async function profileFixture(now = 400n) {
  runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
  const committed = await confirmKnownAuthResponseReview(
    target,
    (await prep()).digest,
    host,
    now,
  );
  await assertKnownAuthCommittedSession(db, committed, runtime);
  await runtime.refreshKnownAuthSession(
    committed.session.binding,
    committed.riskClearedAt,
  );
  const input = {
    ...target,
    authReviewId: committed.reviewId,
    authDigest: committed.digest,
  };
  const before = await snapshot();
  const plan = await prepareKnownAuthProfile(db, input, runtime);
  expect(await snapshot()).toBe(before);
  return { input, plan };
}
it('one-profile probe saves exactly one real-runtime synthetic profile and consumes the audit forever', async () => {
  const { input, plan } = await profileFixture();
  profileResult = (id) => ({
    id,
    name: 'Synthetic verified',
    profileUrl: 'https://www.xiaohongshu.com/user/profile/' + id,
    metrics: {
      collectedAt: Date.now(),
      values: { fans: 123 },
      source: 'synthetic',
    },
  });
  const oldTasks = await taskRows();
  const oldReviews = await db.$queryRawUnsafe<any[]>(
    'SELECT * FROM xhs_unbound_owner_reviews ORDER BY id',
  );
  api.mockImplementation(async (request: any) => ({
    status: 200,
    url: request.url,
    body: { success: true, code: 0, data: { syntheticProfile: true } },
  }));
  const result = await runKnownAuthProfile(
    (work) => db.$transaction(work),
    runtime,
    input,
    plan.digest,
    true,
  );
  expect(result).toMatchObject({
    state: 'profile-saved',
    profileRequests: 1,
    notesCollected: 0,
    imagesCollected: 0,
  });
  expect(api).toHaveBeenCalledTimes(1);
  const metrics = await db.$queryRawUnsafe<any[]>(
    "SELECT document FROM xhs_metric_snapshots WHERE owner_kind='creator' AND owner_id='a'",
  );
  expect(JSON.parse(metrics[0].document).values.fans).toBe(123);
  expect(
    (await db.xhsCreator.findUnique({ where: { id: 'a' } }))?.displayName,
  ).toBe('Synthetic verified');
  expect(await taskRows()).toEqual(oldTasks);
  expect(
    await db.$queryRawUnsafe<any[]>(
      'SELECT * FROM xhs_unbound_owner_reviews WHERE id!=? ORDER BY id',
      plan.reviewId,
    ),
  ).toEqual(oldReviews);
  expect(
    await db.$queryRawUnsafe<any[]>(
      'SELECT outcome FROM xhs_unbound_owner_requests WHERE review_id=?',
      plan.reviewId,
    ),
  ).toEqual([{ outcome: 'response-received' }]);
  const receipts = await db.$queryRawUnsafe<any[]>(
    'SELECT document FROM xhs_unbound_source_receipts',
  );
  expect(JSON.parse(receipts[0].document)).toMatchObject({
    stage: 'checkpoint',
    outcome: 'checkpointed',
    status: 200,
  });
  expect(
    await db.$queryRawUnsafe<any[]>(
      "SELECT state,owner FROM xhs_source_risk WHERE id='source'",
    ),
  ).toEqual([{ state: 'clear', owner: null }]);
  await expect(prepareKnownAuthProfile(db, input, runtime)).rejects.toThrow();
  await expect(
    runKnownAuthProfile(
      (work) => db.$transaction(work),
      runtime,
      input,
      plan.digest,
      true,
    ),
  ).rejects.toThrow();
  expect(api).toHaveBeenCalledTimes(1);
  expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
});

it.each([
  'http401',
  'http429',
  'transport',
  'parse',
  'wrong-author',
  'storage',
  'creator-cas',
  'owner-cas',
  'terminal-store',
  'ack-lost',
  'admission-ack-lost',
  'no-dispatch',
])('one-profile probe failure is consumed without retry: %s', async (mode) => {
  const { input, plan } = await profileFixture();
  const oldTasks = await taskRows();
  api.mockImplementation(async (request: any) => {
    if (mode === 'transport') throw Error('synthetic-timeout');
    if (mode === 'parse')
      profileResult = () => {
        throw Error('synthetic-parse');
      };
    if (mode === 'wrong-author')
      profileResult = () => ({
        id: 'wrong',
        name: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/wrong',
      });
    return {
      status: mode === 'http401' ? 401 : mode === 'http429' ? 429 : 200,
      url: request.url,
      body: { success: true, code: 0, data: { synthetic: true } },
    };
  });
  let writes = 0,
    injected = false;
  const write: any = async (work: any) => {
    writes++;
    const v = await db.$transaction(async (tx: any) => {
      const proxy = new Proxy(tx, {
        get(t, k) {
          if (k === '$executeRawUnsafe')
            return async (sql: string, ...args: any[]) => {
              if (
                mode === 'creator-cas' &&
                sql.startsWith('UPDATE xhs_creators')
              )
                return 0;
              if (mode === 'storage' && sql.startsWith('UPDATE xhs_creators'))
                throw Error('synthetic-storage');
              if (
                mode === 'owner-cas' &&
                sql.includes('SET state=?,owner=NULL')
              )
                return 0;
              if (
                mode === 'terminal-store' &&
                sql.startsWith('INSERT INTO xhs_unbound_source_receipts') &&
                String(args[0]).includes('"terminal":true')
              )
                throw Error('synthetic-terminal-store');
              return t.$executeRawUnsafe(sql, ...args);
            };
          return t[k];
        },
      });
      return work(proxy);
    });
    if (writes === 2 && mode === 'no-dispatch') runtime.onModuleDestroy();
    if (writes === 2 && mode === 'admission-ack-lost')
      throw Error('synthetic-ack-lost');
    if (mode === 'ack-lost' && !injected) {
      const ledger = await db.$queryRawUnsafe<any[]>(
        'SELECT outcome FROM xhs_unbound_owner_requests WHERE review_id=?',
        plan.reviewId,
      );
      if (ledger[0]?.outcome === 'response-received') {
        injected = true;
        throw Error('synthetic-ack-lost');
      }
    }
    return v;
  };
  const result = await runKnownAuthProfile(
    write,
    runtime,
    input,
    plan.digest,
    true,
  );
  expect(result).toMatchObject({
    state: 'profile-not-confirmed',
    checkpointConfirmed: false,
    automaticRetry: false,
  });
  const expectedCalls = ['no-dispatch', 'admission-ack-lost'].includes(mode)
    ? 0
    : 1;
  expect(api).toHaveBeenCalledTimes(expectedCalls);
  const ledger = await db.$queryRawUnsafe<any[]>(
    'SELECT outcome FROM xhs_unbound_owner_requests WHERE review_id=?',
    plan.reviewId,
  );
  expect(ledger).toHaveLength(1);
  const expected =
    mode === 'transport'
      ? 'unknown'
      : ['terminal-store', 'admission-ack-lost'].includes(mode)
        ? 'started'
        : mode === 'no-dispatch'
          ? 'not-sent'
          : 'response-received';
  expect(ledger[0].outcome).toBe(expected);
  const receipts = await db.$queryRawUnsafe<any[]>(
    'SELECT document FROM xhs_unbound_source_receipts WHERE operation_id IN (SELECT operation_id FROM xhs_unbound_owner_requests WHERE review_id=?)',
    plan.reviewId,
  );
  if (['parse', 'wrong-author', 'storage'].includes(mode))
    expect(JSON.parse(receipts[0].document)).toMatchObject({
      outcome: 'local-failure',
      status: 200,
    });
  if (['http401', 'http429'].includes(mode))
    expect(JSON.parse(receipts[0].document)).toMatchObject({
      outcome: 'response-received',
      status: mode === 'http401' ? 401 : 429,
    });
  const risk = (
    await db.$queryRawUnsafe<any[]>(
      "SELECT state FROM xhs_source_risk WHERE id='source'",
    )
  )[0];
  expect(risk.state).toBe(
    mode === 'ack-lost'
      ? 'clear'
      : ['http401', 'http429'].includes(mode)
        ? 'blocked'
        : 'pending',
  );
  await expect(
    runKnownAuthProfile(write, runtime, input, plan.digest, true),
  ).rejects.toThrow();
  expect(api).toHaveBeenCalledTimes(expectedCalls);
  expect(await taskRows()).toEqual(oldTasks);
  expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
});
// A revoked fixture needs a distinct valid digest even when the source has no a.
const revokedFixtureDigestSql =
  "(CASE substr(plan_digest,1,1) WHEN '0' THEN '1' ELSE '0' END)||substr(plan_digest,2)";
it('revoked fixture digest always differs even without a', async () => {
  for (const first of '0123456789abcdef') {
    const original = first + 'b'.repeat(63);
    const [row] = await db.$queryRawUnsafe<Array<{ digest: string }>>(
      `SELECT ${revokedFixtureDigestSql} AS digest FROM (SELECT ? AS plan_digest)`,
      original,
    );
    expect(row.digest).not.toBe(original);
    expect(row.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(row.digest.slice(1)).toBe(original.slice(1));
  }
});
it.each([
  'creator',
  'author',
  'audit',
  'digest',
  'session',
  'blocked',
  'unknown',
  'verification',
  'budget',
  'cooldown',
  'revoked',
  'ack',
])(
  'one-profile probe rejects changed proof before transport: %s',
  async (mode) => {
    const { input, plan } = await profileFixture();
    if (mode === 'creator') input.creatorId = 'b';
    if (mode === 'author')
      await db.$executeRawUnsafe(
        "UPDATE xhs_creators SET external_author_id='different' WHERE id='a'",
      );
    if (mode === 'audit') input.authReviewId += 'wrong';
    if (mode === 'digest') input.authDigest = '0'.repeat(64);
    if (mode === 'session')
      await runtime.connectSession({
        a1: 'synthetic-next',
        webSession: 'synthetic-next',
      });
    if (mode === 'blocked') (runtime as any).stopCode = AUTH;
    if (mode === 'unknown')
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,'b','detail','new-target','unknown',NULL)",
        randomUUID(),
        context.reviewId,
        'new-task',
      );
    if (mode === 'verification')
      await db.$executeRawUnsafe(
        "UPDATE xhs_source_risk SET state='blocked',code='XHS_SOURCE_VERIFICATION_BLOCKED' WHERE id='source'",
      );
    if (mode === 'budget')
      await db.$executeRawUnsafe(
        "UPDATE xhs_request_budgets SET used=request_limit WHERE id='xhs:source-total'",
      );
    if (mode === 'cooldown')
      await db.$executeRawUnsafe(
        "UPDATE xhs_request_budgets SET next_at=? WHERE id='xhs:source-total'",
        BigInt(Date.now() + 60000),
      );
    if (mode === 'revoked')
      await db.$executeRawUnsafe(
        `INSERT INTO xhs_unbound_owner_reviews SELECT 'revoked',${revokedFixtureDigestSql},original_risk_json,original_outcome,old_task_ids_json,old_job_ids_json,creator_bindings_json,budget_snapshot_json,replace(scope_json,'scheduled-policy-v1','scheduled-policy-revoked-v1'),backup_sha256,approved_at FROM xhs_unbound_owner_reviews WHERE id=?`,
        plan.policy.id,
      );
    const before = await snapshot();
    await expect(
      runKnownAuthProfile(
        (w) => db.$transaction(w),
        runtime,
        input,
        plan.digest,
        mode === 'ack' ? (false as any) : true,
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toBe(before);
    expect(api).not.toHaveBeenCalled();
  },
);
it.each([
  'receipt-unknown',
  'receipt-terminal',
  'receipt-response',
  'other-started',
  'other-unknown',
  'new-budget',
  'new-owner',
  'review-row',
])('one-profile probe rejects dispatch-time changes: %s', async (mode) => {
  const { input, plan } = await profileFixture();
  let writes = 0;
  const write: any = async (work: any) => {
    const v = await db.$transaction(work);
    writes++;
    if (writes === 3) {
      if (mode.startsWith('receipt-'))
        await db.$executeRawUnsafe(
          'UPDATE xhs_unbound_source_receipts SET document=?',
          pack({
            stage: mode === 'receipt-response' ? 'response' : 'admitted',
            outcome: mode === 'receipt-unknown' ? 'unknown' : 'in-progress',
            terminal: mode === 'receipt-terminal',
            status: mode === 'receipt-response' ? 200 : undefined,
            events: [],
          }),
        );
      if (mode === 'other-started' || mode === 'other-unknown')
        await db.$executeRawUnsafe(
          "INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,'b','detail','new-target',?,NULL)",
          randomUUID(),
          context.reviewId,
          'new-task',
          mode === 'other-started' ? 'started' : 'unknown',
        );
      if (mode === 'new-budget')
        await db.$executeRawUnsafe(
          "UPDATE xhs_request_budgets SET used=used+1 WHERE id='xhs:source-total'",
        );
      if (mode === 'new-owner')
        await db.$executeRawUnsafe(
          "UPDATE xhs_source_risk SET owner=? WHERE id='source'",
          randomUUID(),
        );
      if (mode === 'review-row') {
        // Immutable rows cannot be altered even by a direct SQL caller.
        await expect(
          db.$executeRawUnsafe(
            'UPDATE xhs_unbound_owner_reviews SET creator_bindings_json=? WHERE id=?',
            '{}',
            plan.reviewId,
          ),
        ).rejects.toThrow();
        await db.$executeRawUnsafe(
          "UPDATE xhs_source_risk SET code='XHS_SOURCE_VERIFICATION_BLOCKED' WHERE id='source'",
        );
      }
    }
    return v;
  };
  const result = await runKnownAuthProfile(
    write,
    runtime,
    input,
    plan.digest,
    true,
  );
  expect(result.state).toBe('profile-not-confirmed');
  expect(api).not.toHaveBeenCalled();
  expect(
    (
      await db.$queryRawUnsafe<any[]>(
        'SELECT outcome FROM xhs_unbound_owner_requests WHERE review_id=?',
        plan.reviewId,
      )
    )[0].outcome,
  ).toBe('started');
  await expect(prepareKnownAuthProfile(db, input, runtime)).rejects.toThrow();
});
it('one-profile probe actual service prepare/confirm projects fields and concurrent clicks produce at most one request', async () => {
  const { input } = await profileFixture();
  const service: any = new XhsWholeCreatorService(
    db as any,
    { hasLocalSourceWork: () => false } as any,
    runtime,
    {} as any,
  );
  service.readyForMutation = async () => {};
  api.mockImplementation(async (request: any) => ({
    status: 200,
    url: request.url,
    body: { success: true, code: 0, data: { synthetic: true } },
  }));
  const p = await service.prepareKnownAuthProfileProbe(input);
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      service.confirmKnownAuthProfileProbe({
        ...input,
        digest: p.digest,
        acknowledgedOneProfile: true,
      }),
    ),
  );
  expect(
    results.filter(
      (r) => r.status === 'fulfilled' && r.value.state === 'profile-saved',
    ),
  ).toHaveLength(1);
  expect(api).toHaveBeenCalledTimes(1);
  expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
});
it('known-auth snapshot safely projects real epoch INTEGER review timestamps', async () => {
  // The deployed historical schema deliberately has INTEGER approved_at.
  const p = await prep();
  await confirm(p.digest);
  const input = {
    ...target,
    authReviewId: 'known-auth-response-' + p.digest,
    authDigest: p.digest,
  };
  // Create a synthetic historical review with an actual millisecond epoch.
  await db.$executeRawUnsafe(
    "INSERT INTO xhs_unbound_owner_reviews SELECT 'epoch-proof',?,original_risk_json,original_outcome,old_task_ids_json,old_job_ids_json,creator_bindings_json,budget_snapshot_json,scope_json,backup_sha256,? FROM xhs_unbound_owner_reviews LIMIT 1",
    'e'.repeat(64),
    BigInt(Date.now()),
  );
  const { readKnownAuthControlState } =
    await import('./xhs-known-auth-response-review');
  const state = await readKnownAuthControlState(db);
  expect(
    state.data.xhs_unbound_owner_reviews.find((r) => r.id === 'epoch-proof')
      .approved_at,
  ).toMatch(/^\d{13}$/);
  await expect(prepareKnownAuthProfile(db, input, runtime)).rejects.toThrow();
});

it('one-profile probe leaves next natural scheduled round admissible, never replays old round', async () => {
  const { input, plan } = await profileFixture();
  api.mockImplementation(async (request: any) => ({
    status: 200,
    url: request.url,
    body: {
      success: true,
      code: 0,
      data: new URL(request.url).pathname.includes('otherinfo')
        ? { synthetic: true }
        : { notes: [], cursor: '', has_more: false },
    },
  }));
  expect(
    (
      await runKnownAuthProfile(
        (w) => db.$transaction(w),
        runtime,
        input,
        plan.digest,
        true,
      )
    ).state,
  ).toBe('profile-saved');
  runtime.bindFullHistoryWriter((w) => db.$transaction((tx) => w(tx)));
  runtime.bindFullHistoryReader((w) => db.$transaction((tx) => w(tx)));
  runtime.bindFullHistoryLegacyGuard(() => assertLegacyXhsSourceReady(db));
  const before = (await taskRows()).find((r) => r.id === target.taskId);
  const service: any = new XhsSubscriptionService(db as any, runtime);
  service.write = async (_bytes: number, w: any) => db.$transaction(w);
  try {
    for (const creatorId of ['a', 'b', 'c'])
      await expect(
        service.scheduleCreatorPhase({ round, creatorId, phase: 'basic' }),
      ).rejects.toThrow();
    const next = '2026-11-08/17:30';
    await service.scheduleCreatorPhase({
      round: next,
      creatorId: 'a',
      phase: 'basic',
    });
    await service.lane;
    expect(
      await service.task({ taskId: scheduledTaskId(next, 'a', 'basic') }),
    ).toMatchObject({ state: 'completed' });
    expect(api).toHaveBeenCalledTimes(3);
    expect((await taskRows()).find((r) => r.id === target.taskId)).toEqual(
      before,
    );
  } finally {
    await service.onModuleDestroy();
  }
});
it('one-profile probe uses actual epoch service recovery and saved-session confirmation without backup', async () => {
  runtime.onModuleDestroy();
  runtime = new XhsSubscriptionRuntime({
    enabled: () => true,
    api,
    profileParser: (_raw, id) => profileResult(id),
    vault: {
      status: async () => ({ stored: true }),
      policy: async () => ({ autoRestore: true, needsReconnect: false }),
      load: async () => ({
        a1: 'synthetic-saved',
        web_session: 'synthetic-saved',
      }),
      store: async () => {
        throw Error('SAVE_FORBIDDEN');
      },
      disconnect: async () => {
        throw Error('DISCONNECT_FORBIDDEN');
      },
    },
  });
  await runtime.onModuleInit();
  runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
  const service: any = new XhsWholeCreatorService(
    db as any,
    { hasLocalSourceWork: () => false } as any,
    runtime,
    {} as any,
  );
  service.readyForMutation = async () => {};
  db.$use((params, next) =>
    sqliteWrites.write(() => next(params), params.runInTransaction === true),
  );
  (createVerifiedSqliteBackup as jest.Mock)
    .mockReset()
    .mockRejectedValue(Error('FULL_BACKUP_FORBIDDEN'));
  const auth = await service.prepareKnownResponseAuthReview(target);
  const committed = await service.confirmKnownResponseAuthReview({
    ...target,
    digest: auth.digest,
    confirmedSessionOrigin: auth.sessionOrigin,
    acknowledgedKnownResponseAuth: true,
  });
  expect(committed.state).toBe('confirmed-runtime-ready');
  const audit = JSON.parse(
    (await taskRows()).find((r) => r.id === target.taskId).document,
  ).knownResponseAuthReviews[0];
  expect(audit.confirmedAt).toMatch(/^\d{13}$/);
  const input = { ...target, authReviewId: audit.id, authDigest: audit.digest };
  const plan = await service.prepareKnownAuthProfileProbe(input);
  api.mockImplementation(async (request: any) => ({
    status: 200,
    url: request.url,
    body: { success: true, code: 0, data: { synthetic: true } },
  }));
  const result = await service.confirmKnownAuthProfileProbe({
    ...input,
    digest: plan.digest,
    acknowledgedOneProfile: true,
  });
  expect(result.state).toBe('profile-saved');
  expect(api).toHaveBeenCalledTimes(1);
  expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
});

it.each(['profile', 'list', 'detail', 'media', 'comments', 'replies'])(
  'one-profile probe kind never falls through to generic admission or dispatch: %s',
  async (phase) => {
    const { input, plan } = await profileFixture();
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      plan.reviewId,
      plan.digest,
      plan.policy.original_risk_json,
      'unknown',
      '[]',
      '[]',
      pack(plan.scope.creatorBindings),
      pack(plan.state.data.xhs_request_budgets),
      pack(plan.scope),
      plan.policy.backup_sha256,
      1000n,
    );
    const request = {
      operationId: randomUUID(),
      taskId: plan.scope.requestScope.taskId,
      creatorId: 'a',
      phase: phase as any,
      target: phase === 'profile' ? 'profile' : 'new-target',
    };
    await expect(
      admitUnboundRequest(db, plan.reviewId, request),
    ).rejects.toThrow('KNOWN_PROFILE_CONTEXT_REQUIRED');
    if (!['comments', 'replies'].includes(phase)) {
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,'started',NULL)",
        request.operationId,
        plan.reviewId,
        request.taskId,
        'a',
        phase,
        request.target,
      );
      await expect(
        unboundRoundContext.run({ reviewId: plan.reviewId, request }, () =>
          assertUnboundDispatch(db),
        ),
      ).rejects.toThrow('KNOWN_PROFILE_CONTEXT_REQUIRED');
    }
    expect(api).not.toHaveBeenCalled();
    await expect(prepareKnownAuthProfile(db, input, runtime)).rejects.toThrow();
  },
);

it.each([
  'prepare-autoRestore',
  'prepare-needsReconnect',
  'dispatch-autoRestore',
  'dispatch-needsReconnect',
])(
  'one-profile probe saved restore policy drift stays closed: %s',
  async (mode) => {
    const policy = { autoRestore: true, needsReconnect: false };
    runtime.onModuleDestroy();
    runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      profileParser: (_raw, id) => profileResult(id),
      vault: {
        status: async () => ({ stored: true }),
        policy: async () => ({ ...policy }),
        load: async () => ({
          a1: 'synthetic-saved',
          web_session: 'synthetic-saved',
        }),
        store: async () => {
          throw Error('SAVE_FORBIDDEN');
        },
        disconnect: async () => {
          throw Error('DISCONNECT_FORBIDDEN');
        },
      },
    });
    await runtime.onModuleInit();
    const { input, plan } = await profileFixture(BigInt(Date.now()));
    const drift = () => {
      if (mode.endsWith('autoRestore')) policy.autoRestore = false;
      else policy.needsReconnect = true;
    };
    let writes = 0;
    const write: any = async (work: any) => {
      const v = await db.$transaction(work);
      if (++writes === 3) drift();
      return v;
    };
    if (mode.startsWith('prepare')) {
      drift();
      await expect(
        runKnownAuthProfile(write, runtime, input, plan.digest, true),
      ).rejects.toThrow();
    } else
      expect(
        (await runKnownAuthProfile(write, runtime, input, plan.digest, true))
          .state,
      ).toBe('profile-not-confirmed');
    expect(api).not.toHaveBeenCalled();
  },
);

it('one-profile probe rejects a missing durable policy binding before any write or request', async () => {
  const { input, plan } = await profileFixture();
  (runtime as any).riskStore = undefined;
  const write: any = jest.fn((work: any) => db.$transaction(work));
  const before = await snapshot();
  await expect(
    runKnownAuthProfile(write, runtime, input, plan.digest, true),
  ).rejects.toThrow('SOURCE_POLICY_NOT_INSTALLED');
  expect(await snapshot()).toBe(before);
  expect(api).not.toHaveBeenCalled();
});

describe('connection verification before AUTH clear', () => {
  async function fixture() {
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    (runtime as any).stopCode = AUTH;
    const service: any = new XhsWholeCreatorService(
      db as any,
      { hasLocalSourceWork: () => false } as any,
      runtime,
      {} as any,
    );
    service.readyForMutation = async () => {};
    db.$use((params, next) =>
      sqliteWrites.write(() => next(params), params.runInTransaction === true),
    );
    return service;
  }
  it.each([
    ['SOURCE_WORK_NOT_IDLE', 'SOURCE_WORK_NOT_IDLE'],
    ['synthetic-secret-do-not-return', 'UNKNOWN'],
  ])('returns only a safe preflight diagnostic: %s', async (message, code) => {
    const service = await fixture();
    service.readyForMutation = async () => {
      throw Error(message);
    };
    const result = await service.verifyKnownAuthenticationAfterConnection();
    expect(result.authenticationRecovery).toMatchObject({
      state: 'paused',
      diagnostic: { stage: 'readiness', code },
      automaticRetry: false,
    });
    expect(JSON.stringify(result)).not.toContain(
      'synthetic-secret-do-not-return',
    );
    expect(api).not.toHaveBeenCalled();
  });
  it('gives only known-auth verification writes a bounded native-vault transaction budget', async () => {
    const service = await fixture();
    api.mockImplementation(async (request: any) => ({
      status: 200,
      url: request.url,
      body: { success: true, code: 0, data: { synthetic: true } },
    }));
    const transactions = jest.spyOn(db, '$transaction');
    await service.write(async (tx: any) => tx.$queryRawUnsafe('SELECT 1'));
    expect(transactions.mock.calls).toHaveLength(1);
    expect(transactions.mock.calls[0][1]).toBeUndefined();
    transactions.mockClear();
    try {
      const result = await service.verifyKnownAuthenticationAfterConnection();
      expect(result.authenticationRecovery.state).toBe('profile-verified');
      expect(api).toHaveBeenCalledTimes(1);
      const options = transactions.mock.calls
        .map((call) => call[1])
        .filter((value) => value !== undefined);
      expect(options.length).toBeGreaterThan(0);
      expect(
        options.every(
          (value) =>
            JSON.stringify(value) === JSON.stringify({ timeout: 30000 }),
        ),
      ).toBe(true);
      expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
    } finally {
      transactions.mockRestore();
    }
  });
  it.each([
    'success',
    'second-local-failure',
    'unknown',
    'auth',
    'control-drift',
    'receipt-drift',
    'budget-drift',
    'predecessor-digest',
    'predecessor-root',
    'predecessor-extra',
    'predecessor-author',
  ])(
    'permits only one explicit successor of an exact local checkpoint failure: %s',
    async (mode) => {
      const service = await fixture();
      api.mockImplementation(async (request: any) => ({
        status: 200,
        url: request.url,
        body: { success: true, code: 0, data: { synthetic: true } },
      }));
      const originalTask = (await taskRows()).find(
        (r) => r.id === target.taskId,
      );
      const beforeRisk = await db.$queryRawUnsafe(
        'SELECT * FROM xhs_source_risk',
      );
      const beforeBudget = await db.$queryRawUnsafe<any[]>(
        "SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'",
      );
      const realWrite = service.write.bind(service);
      let failed = false;
      service.write = async (work: any, ...options: any[]) =>
        realWrite(
          (tx: any) =>
            work(
              new Proxy(tx, {
                get(t, k) {
                  if (k === '$executeRawUnsafe')
                    return async (sql: string, ...args: any[]) => {
                      if (
                        sql.startsWith(
                          'UPDATE xhs_subscription_tasks SET document',
                        ) &&
                        (!failed || mode === 'second-local-failure')
                      ) {
                        failed = true;
                        throw new Prisma.PrismaClientKnownRequestError(
                          'synthetic checkpoint transaction timeout',
                          { code: 'P2028', clientVersion: 'test' },
                        );
                      }
                      return t.$executeRawUnsafe(sql, ...args);
                    };
                  return t[k];
                },
              }),
            ),
          ...options,
        );
      expect(
        (await service.verifyKnownAuthenticationAfterConnection())
          .authenticationRecovery.state,
      ).toBe('paused');
      expect(api).toHaveBeenCalledTimes(1);
      expect((await taskRows()).find((r) => r.id === target.taskId)).toEqual(
        originalTask,
      );
      expect(await db.$queryRawUnsafe('SELECT * FROM xhs_source_risk')).toEqual(
        beforeRisk,
      );
      const oldRequests = await db.$queryRawUnsafe<any[]>(
        "SELECT * FROM xhs_unbound_owner_requests WHERE logical_target='profile'",
      );
      expect(oldRequests).toHaveLength(1);
      const oldReceipt = (
        await db.$queryRawUnsafe<any[]>(
          'SELECT * FROM xhs_unbound_source_receipts WHERE operation_id=?',
          oldRequests[0].operation_id,
        )
      )[0];
      expect(JSON.parse(oldReceipt.document)).toMatchObject({
        stage: 'checkpoint',
        outcome: 'local-failure',
        terminal: true,
        status: 200,
        code: 'XHS_STORAGE_FAILED',
      });
      if (mode === 'unknown')
        await db.$executeRawUnsafe(
          "UPDATE xhs_unbound_owner_requests SET outcome='unknown' WHERE operation_id=?",
          oldRequests[0].operation_id,
        );
      if (mode === 'auth' || mode === 'receipt-drift') {
        const receipt = JSON.parse(oldReceipt.document);
        if (mode === 'auth') {
          receipt.code = AUTH;
          receipt.status = 401;
        } else receipt.unrecognized = true;
        await db.$executeRawUnsafe(
          'UPDATE xhs_unbound_source_receipts SET document=? WHERE operation_id=?',
          JSON.stringify(receipt),
          oldReceipt.operation_id,
        );
      }
      if (mode === 'control-drift')
        await db.$executeRawUnsafe(
          "UPDATE xhs_creators SET enabled=0 WHERE id='b'",
        );
      if (mode === 'budget-drift')
        await db.$executeRawUnsafe(
          "UPDATE xhs_request_budgets SET used=used+1 WHERE id='xhs:source-total'",
        );
      if (mode.startsWith('predecessor-')) {
        const review = (
          await db.$queryRawUnsafe<any[]>(
            'SELECT id,scope_json FROM xhs_unbound_owner_reviews WHERE id=?',
            oldRequests[0].review_id,
          )
        )[0];
        const scope = JSON.parse(review.scope_json);
        if (mode === 'predecessor-digest')
          scope.knownAuthentication.authDigest = 'f'.repeat(64);
        if (mode === 'predecessor-root')
          scope.rootHistoricalEvidence.inherited = false;
        if (mode === 'predecessor-extra')
          scope.unrecognizedRestriction = {
            code: 'XHS_SOURCE_VERIFICATION_BLOCKED',
          };
        if (mode === 'predecessor-author')
          scope.creatorBindings = { a: 'different-author' };
        const digest = createHash('sha256').update(pack(scope)).digest('hex');
        await expect(
          db.$executeRawUnsafe(
            'UPDATE xhs_unbound_owner_reviews SET scope_json=?,plan_digest=? WHERE id=?',
            pack(scope),
            digest,
            review.id,
          ),
        ).rejects.toThrow('UNBOUND_REVIEW_IMMUTABLE');
        // The immutable DB rejects tampering first. Independently exercise the
        // pure proof against a forged in-memory projection, without dropping it.
        const state = await readKnownAuthControlState(db);
        const forged = state.data.xhs_unbound_owner_reviews.find(
          (r) => r.id === review.id,
        );
        forged.scope_json = pack(scope);
        forged.plan_digest = digest;
        const plan = await prepareKnownAuthResponseReview(db, target, runtime);
        const policy = state.data.xhs_unbound_owner_reviews.find(
          (r) => r.id === scope.rootHistoricalEvidence.policyId,
        );
        expect(() =>
          knownAuthCheckpointPredecessor(
            state,
            scope.knownAuthentication.authReviewId,
            target.taskId,
            target.creatorId,
            policy,
            state.data.xhs_source_risk[0],
            plan,
          ),
        ).toThrow('KNOWN_PROFILE_ALREADY_CONSUMED');
        expect(api).toHaveBeenCalledTimes(1);
        expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
        return;
      }
      // Let the unchanged real budget cooldown pass without modifying its rows.
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
      const admitted = ['success', 'second-local-failure'].includes(mode);
      if (admitted)
        await prepareKnownAuthProfile(
          db,
          { ...target, authReviewId: '', authDigest: '' },
          runtime,
          false,
          true,
        );
      const second = await service.verifyKnownAuthenticationAfterConnection();
      expect(second.authenticationRecovery.state).toBe(
        mode === 'success' ? 'profile-verified' : 'paused',
      );
      expect(api).toHaveBeenCalledTimes(admitted ? 2 : 1);
      if (admitted) {
        expect(
          await db.$queryRawUnsafe(
            'SELECT * FROM xhs_unbound_owner_requests WHERE operation_id=?',
            oldRequests[0].operation_id,
          ),
        ).toEqual(oldRequests);
        expect(
          await db.$queryRawUnsafe(
            'SELECT * FROM xhs_unbound_source_receipts WHERE operation_id=?',
            oldReceipt.operation_id,
          ),
        ).toEqual([oldReceipt]);
        const used = await db.$queryRawUnsafe<any[]>(
          "SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'",
        );
        expect(Number(used[0].used)).toBe(Number(beforeBudget[0].used) + 2);
        const attempts = await db.$queryRawUnsafe<any[]>(
          "SELECT review_id FROM xhs_unbound_owner_requests WHERE logical_target='profile'",
        );
        expect(attempts).toHaveLength(2);
        expect(
          attempts.some((r) => r.review_id.endsWith('-local-checkpoint-1')),
        ).toBe(true);
      }
      if (mode === 'success') {
        const doc = JSON.parse(
          (await taskRows()).find((r) => r.id === target.taskId).document,
        );
        expect(
          doc.knownResponseAuthReviews[0].localCheckpointRecovery,
        ).toMatchObject({
          attempt: 1,
          operationId: oldRequests[0].operation_id,
          automaticRetry: false,
        });
      }
      await service.verifyKnownAuthenticationAfterConnection();
      expect(api).toHaveBeenCalledTimes(admitted ? 2 : 1);
      expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
    },
  );
  it('keeps exact AUTH through real profile transport, atomically saves then clears, never retries', async () => {
    const service = await fixture();
    const beforeRisk = await db.$queryRawUnsafe<any[]>(
      'SELECT * FROM xhs_source_risk',
    );
    const beforeTask = (await taskRows()).find((r) => r.id === target.taskId);
    api.mockImplementation(async (request: any) => {
      expect(await db.$queryRawUnsafe('SELECT * FROM xhs_source_risk')).toEqual(
        beforeRisk,
      );
      expect(
        JSON.parse(
          (await taskRows()).find((r) => r.id === target.taskId).document,
        ).knownResponseAuthReviews,
      ).toBeUndefined();
      await expect(
        runtime.withScheduledReview(
          {
            round: '2026-11-08/17:30',
            creatorId: 'b',
            authorId: 'author-b',
            phase: 'basic',
          },
          async () => undefined,
        ),
      ).rejects.toThrow();
      return {
        status: 200,
        url: request.url,
        body: { success: true, code: 0, data: { synthetic: true } },
      };
    });
    const result = await service.verifyKnownAuthenticationAfterConnection();
    expect(result.authenticationRecovery.state).toBe('profile-verified');
    expect(result.riskCode).toBeUndefined();
    expect(api).toHaveBeenCalledTimes(1);
    const afterTask = (await taskRows()).find((r) => r.id === target.taskId);
    const doc = JSON.parse(afterTask.document),
      audit = doc.knownResponseAuthReviews[0];
    delete doc.knownResponseAuthReviews;
    expect(doc).toEqual(JSON.parse(beforeTask.document));
    expect(afterTask.updated_at).toEqual(beforeTask.updated_at);
    expect(audit).toMatchObject({
      authenticationVerified: true,
      sourceRequestsSent: 1,
      originalTaskRaw: beforeTask.document,
      originalOutcome: 'response-received',
      verification: {
        order: 'profile-checkpoint-before-auth-clear',
        profileSaved: true,
      },
    });
    expect(
      (await db.$queryRawUnsafe<any[]>('SELECT state FROM xhs_source_risk'))[0]
        .state,
    ).toBe('clear');
    await service.verifyKnownAuthenticationAfterConnection();
    expect(api).toHaveBeenCalledTimes(1);
    expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
  });
  it.each([
    'http401',
    'http429',
    'http461',
    'http471',
    'captcha',
    'transport',
    'parse',
    'storage',
    'task-cas',
    'risk-cas',
    'session',
    'ack-lost',
    'refresh-failed',
  ])(
    'keeps pause and never repeats a consumed verification: %s',
    async (mode) => {
      const service = await fixture();
      const beforeTask = (await taskRows()).find((r) => r.id === target.taskId);
      const beforeRisk = await db.$queryRawUnsafe<any[]>(
        'SELECT * FROM xhs_source_risk',
      );
      api.mockImplementation(async (request: any) => {
        if (mode === 'transport') throw Error('synthetic-timeout');
        if (mode === 'parse')
          profileResult = () => {
            throw Error('synthetic-parse');
          };
        if (mode === 'session')
          await runtime.connectSession({
            a1: 'synthetic-other',
            webSession: 'synthetic-other',
          });
        return {
          status: mode.startsWith('http') ? Number(mode.slice(4)) : 200,
          url: request.url,
          body:
            mode === 'captcha'
              ? { success: false, code: -1, msg: 'captcha required' }
              : { success: true, code: 0, data: { synthetic: true } },
        };
      });
      const realWrite = service.write.bind(service);
      let injected = false;
      service.write = async (work: any) => {
        let checkpoint = false;
        const result = await realWrite((tx: any) =>
          work(
            new Proxy(tx, {
              get(t, k) {
                if (k === '$executeRawUnsafe')
                  return async (sql: string, ...args: any[]) => {
                    if (
                      sql.startsWith('UPDATE xhs_creators') &&
                      mode === 'storage'
                    )
                      throw Error('synthetic-store');
                    if (
                      sql.startsWith(
                        'UPDATE xhs_subscription_tasks SET document',
                      )
                    ) {
                      checkpoint = true;
                      if (mode === 'task-cas') return 0;
                    }
                    if (
                      sql.startsWith(
                        "UPDATE xhs_source_risk SET state='clear'",
                      ) &&
                      mode === 'risk-cas'
                    )
                      return 0;
                    return t.$executeRawUnsafe(sql, ...args);
                  };
                return t[k];
              },
            }),
          ),
        );
        if (checkpoint && mode === 'ack-lost' && !injected) {
          injected = true;
          throw Error('synthetic-ack-lost');
        }
        return result;
      };
      if (mode === 'refresh-failed')
        jest
          .spyOn(runtime, 'refreshKnownAuthSession')
          .mockRejectedValueOnce(Error('synthetic-refresh'));
      const result = await service.verifyKnownAuthenticationAfterConnection();
      expect(result.authenticationRecovery.state).toBe('paused');
      expect(result.authenticationRecovery.diagnostic.stage).toMatch(
        /^(profile|refresh)$/,
      );
      expect(JSON.stringify(result)).not.toContain('synthetic-timeout');
      expect(api).toHaveBeenCalledTimes(1);
      const committed = ['ack-lost', 'refresh-failed'].includes(mode);
      const afterTask = (await taskRows()).find((r) => r.id === target.taskId);
      if (!committed) expect(afterTask).toEqual(beforeTask);
      const risk = await db.$queryRawUnsafe<any[]>(
        'SELECT * FROM xhs_source_risk',
      );
      if (committed) expect(risk[0].state).toBe('clear');
      else if (mode === 'http429')
        expect(risk[0].code).toBe('XHS_SOURCE_RATE_LIMIT_BLOCKED');
      else if (mode === 'http461')
        expect(risk[0].code).toBe('XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED');
      else if (mode === 'http471')
        expect(risk[0].code).toBe('XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED');
      else if (mode === 'captcha')
        expect(risk[0].code).toBe('XHS_SOURCE_VERIFICATION_BLOCKED');
      else if (mode === 'http401') expect(risk[0].code).toBe(AUTH);
      else expect(risk).toEqual(beforeRisk);
      const request = await db.$queryRawUnsafe<any[]>(
        "SELECT outcome FROM xhs_unbound_owner_requests WHERE logical_target='profile'",
      );
      expect(request).toHaveLength(1);
      expect(request[0].outcome).toBe(
        mode === 'transport' ? 'unknown' : 'response-received',
      );
      if (committed) {
        const receipts = await db.$queryRawUnsafe<any[]>(
          'SELECT document FROM xhs_unbound_source_receipts',
        );
        expect(JSON.parse(receipts[0].document).outcome).toBe('checkpointed');
      }
      await runtime.connectSession({
        a1: 'synthetic-another',
        webSession: 'synthetic-another',
      });
      await service.verifyKnownAuthenticationAfterConnection();
      expect(api).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'new-unknown',
    'verification',
    'revoked',
    'disabled',
    'budget',
    'cooldown',
    'missing-store',
  ])(
    'has no request or new review for inadmissible connection: %s',
    async (mode) => {
      const service = await fixture();
      if (mode === 'new-unknown')
        await mutateDoc((d) => {
          d.sourceUnknowns = [{ phase: 'detail', outcome: 'unknown' }];
        }, 'old-fixture');
      if (mode === 'verification')
        await db.$executeRawUnsafe(
          'UPDATE xhs_source_risk SET code=?',
          'XHS_SOURCE_VERIFICATION_BLOCKED',
        );
      if (mode === 'revoked') {
        const p = await prep();
        await db.$executeRawUnsafe(
          'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          'connection-revocation',
          'f'.repeat(64),
          '{}',
          'unknown',
          '[]',
          '[]',
          '{}',
          '[]',
          pack({
            reviewKind: 'scheduled-recurring-revocation-v1',
            policyId: p.policyId,
          }),
          'a'.repeat(64),
          500n,
        );
      }
      if (mode === 'disabled')
        await db.$executeRawUnsafe(
          "UPDATE xhs_creators SET enabled=0 WHERE id='a'",
        );
      if (mode === 'budget')
        await db.$executeRawUnsafe(
          "UPDATE xhs_request_budgets SET used=request_limit WHERE id='xhs:source-total'",
        );
      if (mode === 'cooldown')
        await db.$executeRawUnsafe(
          "UPDATE xhs_request_budgets SET next_at=? WHERE id='xhs:source-total'",
          BigInt(Date.now() + 100000),
        );
      if (mode === 'missing-store') (runtime as any).riskStore = undefined;
      const before = await snapshot();
      await service.verifyKnownAuthenticationAfterConnection();
      expect(api).not.toHaveBeenCalled();
      expect(await snapshot()).toBe(before);
    },
  );

  it('explicit saved restore route verifies once, startup restore never dispatches or rewrites credentials', async () => {
    runtime.onModuleDestroy();
    const storage = {
      status: jest.fn(async () => ({ stored: true })),
      policy: jest.fn(async () => ({
        autoRestore: true,
        needsReconnect: false,
      })),
      load: jest.fn(async () => ({
        a1: 'synthetic-saved',
        web_session: 'synthetic-saved',
      })),
      store: jest.fn(async () => {
        throw Error('SAVE_FORBIDDEN');
      }),
      disconnect: jest.fn(async () => {}),
    };
    runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      vault: storage,
      profileParser: (_raw, id) => profileResult(id),
    });
    await runtime.onModuleInit();
    expect(api).not.toHaveBeenCalled();
    const service = await fixture();
    api.mockImplementation(async (request: any) => ({
      status: 200,
      url: request.url,
      body: { success: true, code: 0, data: { synthetic: true } },
    }));
    const config = new ConfigService({
      auth: { code: 'synthetic-auth' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const router = new TrpcRouter(
      new TrpcService(db as any, config, {} as any, {} as any),
      db as any,
      config,
      {} as any,
      {} as any,
      undefined,
      undefined,
      runtime,
      undefined,
      service,
    ).appRouter;
    await expect(
      router
        .createCaller({ errorMsg: null, isLocalSave: false })
        .xiaohongshu.restoreSession(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const result = await router
      .createCaller({ errorMsg: null, isLocalSave: true })
      .xiaohongshu.restoreSession();
    expect((result as any).authenticationRecovery.state).toBe(
      'profile-verified',
    );
    expect(api).toHaveBeenCalledTimes(1);
    expect(storage.store).not.toHaveBeenCalled();
    await router
      .createCaller({ errorMsg: null, isLocalSave: true })
      .xiaohongshu.restoreSession();
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('queues an independent writer until verification and final refresh, rejects double clicks', async () => {
    const service = await fixture();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
        enter = r;
      }),
      released = new Promise<void>((r) => {
        release = r;
      });
    const events: string[] = [];
    const competing = (async () => {
      await entered;
      await sqliteWrites.write(async () => {
        events.push('writer');
      });
    })();
    api.mockImplementation(async (request: any) => {
      events.push('profile');
      enter();
      await released;
      return {
        status: 200,
        url: request.url,
        body: { success: true, code: 0, data: { synthetic: true } },
      };
    });
    const originalRefresh = runtime.refreshKnownAuthSession.bind(runtime);
    jest
      .spyOn(runtime, 'refreshKnownAuthSession')
      .mockImplementation(async (...args) => {
        await originalRefresh(...args);
        events.push('refresh');
      });
    const first = service.verifyKnownAuthenticationAfterConnection();
    await entered;
    // Do not wait for the second status read while it is correctly queued behind
    // the exclusive operation. It must never acquire another request grant.
    const second = service.verifyKnownAuthenticationAfterConnection();
    await Promise.resolve();
    expect(events).toEqual(['profile']);
    release();
    await Promise.all([first, second, competing]);
    expect(events).toEqual(['profile', 'refresh', 'writer']);
    expect(api).toHaveBeenCalledTimes(1);
  });
  it('admits the next natural scheduled round only after verification; old round remains closed', async () => {
    const service = await fixture();
    api.mockImplementation(async (request: any) => ({
      status: 200,
      url: request.url,
      body: {
        success: true,
        code: 0,
        data: new URL(request.url).pathname.includes('otherinfo')
          ? { synthetic: true }
          : { notes: [], cursor: '', has_more: false },
      },
    }));
    expect(
      (await service.verifyKnownAuthenticationAfterConnection())
        .authenticationRecovery.state,
    ).toBe('profile-verified');
    runtime.bindFullHistoryWriter((w) => db.$transaction((tx) => w(tx)));
    runtime.bindFullHistoryReader((w) => db.$transaction((tx) => w(tx)));
    runtime.bindFullHistoryLegacyGuard(() => assertLegacyXhsSourceReady(db));
    const before = (await taskRows()).find((r) => r.id === target.taskId);
    const scheduled: any = new XhsSubscriptionService(db as any, runtime);
    scheduled.write = async (_bytes: number, w: any) => db.$transaction(w);
    try {
      for (const creatorId of ['a', 'b', 'c'])
        await expect(
          scheduled.scheduleCreatorPhase({ round, creatorId, phase: 'basic' }),
        ).rejects.toThrow();
      const next = '2026-11-08/17:30';
      await scheduled.scheduleCreatorPhase({
        round: next,
        creatorId: 'a',
        phase: 'basic',
      });
      await scheduled.lane;
      expect(
        await scheduled.task({ taskId: scheduledTaskId(next, 'a', 'basic') }),
      ).toMatchObject({ state: 'completed' });
      expect(api).toHaveBeenCalledTimes(3);
      expect((await taskRows()).find((r) => r.id === target.taskId)).toEqual(
        before,
      );
    } finally {
      await scheduled.onModuleDestroy();
    }
  });
  it.each(['exact', 'changed-audit', 'changed-receipt', 'unreadable'])(
    'lost ACK recognizes only the exact committed checkpoint: %s',
    async (mode) => {
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      (runtime as any).stopCode = AUTH;
      api.mockImplementation(async (request: any) => ({
        status: 200,
        url: request.url,
        body: { success: true, code: 0, data: { synthetic: true } },
      }));
      const input = { ...target, authReviewId: '', authDigest: '' };
      const plan = await prepareKnownAuthProfile(
        db,
        input,
        runtime,
        false,
        true,
      );
      let lost = false;
      const writer: any = async (work: any) => {
        if (lost && mode === 'unreadable')
          throw Error('synthetic-read-failure');
        let checkpoint = false;
        const result = await db.$transaction((tx: any) =>
          work(
            new Proxy(tx, {
              get(t, k) {
                if (k === '$executeRawUnsafe')
                  return async (sql: string, ...args: any[]) => {
                    if (
                      sql.startsWith(
                        'UPDATE xhs_subscription_tasks SET document',
                      )
                    )
                      checkpoint = true;
                    return t.$executeRawUnsafe(sql, ...args);
                  };
                return t[k];
              },
            }),
          ),
        );
        if (checkpoint && !lost) {
          lost = true;
          if (mode === 'changed-audit')
            await mutateDoc((d) => {
              d.knownResponseAuthReviews[0].confirmation.trigger = 'tampered';
            });
          if (mode === 'changed-receipt')
            await db.$executeRawUnsafe(
              "UPDATE xhs_unbound_source_receipts SET document='{}'",
            );
          throw Error('synthetic-ack-lost');
        }
        return result;
      };
      const result = await runKnownAuthProfile(
        writer,
        runtime,
        input,
        plan.digest,
        true,
        true,
      );
      expect(result).toMatchObject({
        checkpointConfirmed: mode === 'exact',
        doNotRetryConfirmation: true,
      });
      expect(api).toHaveBeenCalledTimes(1);
      expect((runtime as any).stopCode).toBe(AUTH);
    },
  );
  it('a genuinely new runtime cannot repeat the consumed unknown event', async () => {
    const service = await fixture();
    api.mockRejectedValue(Error('synthetic-timeout'));
    await service.verifyKnownAuthenticationAfterConnection();
    expect(api).toHaveBeenCalledTimes(1);
    runtime.onModuleDestroy();
    runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      profileParser: (_raw, id) => profileResult(id),
    });
    await runtime.connectSession({
      a1: 'synthetic-restarted',
      webSession: 'synthetic-restarted',
    });
    const restarted = await fixture();
    expect(
      (await restarted.verifyKnownAuthenticationAfterConnection())
        .authenticationRecovery.state,
    ).toBe('paused');
    expect(api).toHaveBeenCalledTimes(1);
    expect(
      (await db.$queryRawUnsafe<any[]>('SELECT code FROM xhs_source_risk'))[0]
        .code,
    ).toBe(AUTH);
  });
  it.each(['receipt', 'risk', 'creator', 'unknown', 'session'])(
    'pre-dispatch change stays paused without transport: %s',
    async (mode) => {
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      (runtime as any).stopCode = AUTH;
      const input = { ...target, authReviewId: '', authDigest: '' };
      const plan = await prepareKnownAuthProfile(
        db,
        input,
        runtime,
        false,
        true,
      );
      let writes = 0;
      const writer: any = async (work: any) => {
        const result = await db.$transaction(work);
        writes++;
        if (writes === 3) {
          if (mode === 'receipt')
            await db.$executeRawUnsafe(
              "UPDATE xhs_unbound_source_receipts SET document='{}'",
            );
          if (mode === 'risk')
            await db.$executeRawUnsafe(
              "UPDATE xhs_source_risk SET code='XHS_SOURCE_VERIFICATION_BLOCKED'",
            );
          if (mode === 'creator')
            await db.$executeRawUnsafe(
              "UPDATE xhs_creators SET enabled=0 WHERE id='a'",
            );
          if (mode === 'unknown')
            await db.$executeRawUnsafe(
              "INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,'b','detail','different','unknown',NULL)",
              randomUUID(),
              context.reviewId,
              'other-task',
            );
          if (mode === 'session')
            await runtime.connectSession({
              a1: 'synthetic-other',
              webSession: 'synthetic-other',
            });
        }
        return result;
      };
      expect(
        (
          await runKnownAuthProfile(
            writer,
            runtime,
            input,
            plan.digest,
            true,
            true,
          )
        ).state,
      ).toBe('profile-not-confirmed');
      expect(api).not.toHaveBeenCalled();
      expect(
        (
          await db.$queryRawUnsafe<any[]>('SELECT state FROM xhs_source_risk')
        )[0].state,
      ).toBe('blocked');
    },
  );
  it('encrypted save route verifies once after persistence, keeping original AUTH until profile response', async () => {
    runtime.onModuleDestroy();
    let policy = { autoRestore: false, needsReconnect: true };
    const storage = {
      status: jest.fn(async () => ({ stored: true })),
      policy: jest.fn(async () => ({ ...policy })),
      load: jest.fn(async () => ({
        a1: 'synthetic-saved',
        web_session: 'synthetic-saved',
      })),
      store: jest.fn(async () => {}),
      replace: jest.fn(async () => {}),
      configureRestore: jest.fn(async (autoRestore: boolean) => {
        policy = { autoRestore, needsReconnect: false };
      }),
      disconnect: jest.fn(async () => {}),
    };
    runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      vault: storage,
      profileParser: (_raw, id) => profileResult(id),
    });
    const service = await fixture();
    api.mockImplementation(async (request: any) => {
      expect(storage.replace).toHaveBeenCalledTimes(1);
      expect(
        (
          await db.$queryRawUnsafe<any[]>(
            'SELECT state,code FROM xhs_source_risk',
          )
        )[0],
      ).toEqual({ state: 'blocked', code: AUTH });
      return {
        status: 200,
        url: request.url,
        body: { success: true, code: 0, data: { synthetic: true } },
      };
    });
    const config = new ConfigService({
      auth: { code: 'synthetic-auth' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const apiCaller = new TrpcRouter(
      new TrpcService(db as any, config, {} as any, {} as any),
      db as any,
      config,
      {} as any,
      {} as any,
      undefined,
      undefined,
      runtime,
      undefined,
      service,
    ).appRouter.createCaller({ errorMsg: null, isLocalSave: true }).xiaohongshu;
    const result = await apiCaller.connectSession({
      a1: 'synthetic-persisted',
      webSession: 'synthetic-persisted',
      persist: true,
      replaceSaved: true,
      autoRestore: true,
    });
    expect((result as any).authenticationRecovery.state).toBe(
      'profile-verified',
    );
    expect(result.verified).toBe(true);
    expect(api).toHaveBeenCalledTimes(1);
    expect(storage.load).not.toHaveBeenCalled();
  });
});
