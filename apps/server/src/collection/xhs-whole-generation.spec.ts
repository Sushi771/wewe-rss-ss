jest.mock('./xhs-legacy-review', () => ({
  ...jest.requireActual('./xhs-legacy-review'),
  // The real maintenance lease is independently tested; this suite owns only a synthetic SQLite database.
  assertLegacyDatabase: jest.fn(async () => undefined),
}));
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { legacyBudgetDigest } from './xhs-legacy-review';
import { activeWholeFence, createWholeGeneration, generationMatches, historicalGenerationMarker, setActiveWholeFence } from './xhs-whole-generation';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
describe('explicit whole creator generation preserves unknown origin and cumulative budgets', () => {
  let db: PrismaClient, root: string;
  const marker = 'xhs:dispatch-pending:whole:00000000-0000-4000-8000-000000000001';
  const phaseLimits = { profile: 4, list: 4, detail: 8, media: 300, metrics: 8 };
  const input = { jobId: 'job', profileUrl: 'https://xhslink.cn/o/Synthetic', confirmUnknown: true as const, phaseLimits };
  const read = async () => JSON.parse((await db.$queryRaw<Array<{ document: string }>>`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`)[0].document);
  const write = async (job: any) => db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id='job'`;
  const create = () => db.$transaction(tx => createWholeGeneration(tx, input, 10000));
  async function scope() {
    const job = await read();
    return { jobId: 'job', creatorId: 'creator', authorId: 'author', generationId: job.generation.id };
  }
  const allowed = async () => db.$transaction(async tx => historicalGenerationMarker(tx, await scope()));
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'xhs-generation-'));
    db = new PrismaClient({ datasources: { db: { url: 'file:' + path.join(root, 'fixture.sqlite').replace(/\\/g, '/') } } });
    await db.$executeRawUnsafe('CREATE TABLE xhs_creators(id TEXT PRIMARY KEY,external_author_id TEXT,enabled INTEGER)');
    await db.$executeRawUnsafe('CREATE TABLE xhs_whole_creator_jobs(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT,updated_at INTEGER)');
    await db.$executeRawUnsafe('CREATE TABLE xhs_request_budgets(id TEXT PRIMARY KEY,used INTEGER,request_limit INTEGER,next_at INTEGER,interval_ms INTEGER)');
    await db.$executeRawUnsafe('CREATE TABLE xhs_source_risk(id TEXT PRIMARY KEY,state TEXT,code TEXT)');
    await db.$executeRawUnsafe('CREATE TABLE xhs_limited_recovery(id TEXT,note_id TEXT,author_id TEXT,state TEXT)');
    await db.$executeRawUnsafe('CREATE TABLE xhs_limited_recovery_append(id TEXT,note_id TEXT,author_id TEXT,state TEXT)');
    await db.$executeRawUnsafe("INSERT INTO xhs_creators VALUES('creator','author',1)");
  });
  beforeEach(async () => {
    await db.$executeRaw`DELETE FROM xhs_whole_creator_jobs`;
    await db.$executeRaw`DELETE FROM xhs_request_budgets`;
    await db.$executeRaw`DELETE FROM xhs_source_risk`;
    await db.$executeRaw`DELETE FROM xhs_limited_recovery`;
    await db.$executeRaw`DELETE FROM xhs_limited_recovery_append`;
    await db.$executeRaw`UPDATE xhs_creators SET enabled=1`;
    await db.$executeRawUnsafe("INSERT INTO xhs_request_budgets VALUES('job',6,310,10000,10000),('xhs:source-total',8,312,10000,10000)");
    await db.$executeRaw`INSERT INTO xhs_request_budgets VALUES(${marker},1,1,10000,0)`;
    await db.$executeRawUnsafe("INSERT INTO xhs_source_risk VALUES('source','blocked','XHS_SOURCE_HISTORY_REVIEW_REQUIRED')");
    const job: any = { id: 'job', creatorId: 'creator', state: 'paused', code: 'XHS_DOWNLOAD_BLOCKED',
      sourceFence: { marker, state: 'started', phase: 'detail', noteId: 'note' },
      sourceGrant: { creatorId: 'creator', authorId: 'author', phases: ['profile','list','detail','media','metrics'],
        limits: { profile: 2, list: 3, detail: 5, media: 300, metrics: 0 }, used: { profile: 2, list: 2, detail: 1, media: 1, metrics: 0 } } };
    const budgets = await db.$queryRaw<any[]>`SELECT id,used,request_limit,next_at,interval_ms FROM xhs_request_budgets WHERE id IN ('job','xhs:source-total')`;
    const proof: any = { boundaryVersion: 'project-start-dispatch-v2', oldOwner: null, oldResult: 'unknown', allowsRetry: false,
      claim: 'no-local-project-writer-at-observation', lockIdentity: hash('lock'), lockNonce: 'synthetic', holder: { pid: 123 }, snapshot: { observed: true },
      scope: { jobId: 'job', authorId: 'author', noteId: 'note', databaseIdentity: hash('db'), projectIdentity: hash('project'),
        unknownDigest: hash({ fence: job.sourceFence, code: job.code }), budgetDigest: legacyBudgetDigest(job, budgets, 'job') } };
    proof.proofId = hash({ scope: proof.scope, lockIdentity: proof.lockIdentity, lockNonce: proof.lockNonce, holder: proof.holder, snapshot: proof.snapshot });
    job.legacyMaintenanceProof = proof;
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs VALUES('job','creator','paused',${JSON.stringify(job)},10000)`;
  });
  afterAll(async () => { await db.$disconnect(); await fs.rm(root, { recursive: true, force: true }); });

  it('records only intent; preserves unknown, old marker, phase used, and both cumulative counters', async () => {
    const before = await read();
    expect(await create()).toMatchObject({ state: 'prepared' });
    const job = await read();
    expect(job.sourceFence).toEqual(before.sourceFence);
    expect(job.sourceGrant.used).toEqual(before.sourceGrant.used);
    expect(job.legacyMaintenanceProof).toEqual(before.legacyMaintenanceProof);
    expect(job.state).toBe('paused');
    expect(generationMatches(job)).toBe(true);
    expect(await allowed()).toBe(marker);
    expect(await db.$queryRaw`SELECT id,used FROM xhs_request_budgets ORDER BY id`).toEqual([
      { id: 'job', used: 6 }, { id: marker, used: 1 }, { id: 'xhs:source-total', used: 8 },
    ].sort((a,b) => a.id.localeCompare(b.id)));
  });
  it('keeps ordinary writers blocked by returning no historical exception without an explicit generation', async () => {
    await create();
    expect(await db.$transaction(tx => historicalGenerationMarker(tx, { jobId:'job', creatorId:'creator', authorId:'author' }))).toBe('');
  });
  it('keeps original fence immutable while active generation fences are prepared and cleared', async () => {
    await create(); const job = await read(), old = JSON.stringify(job.sourceFence);
    expect(activeWholeFence(job)).toBeUndefined();
    setActiveWholeFence(job, { marker: 'new-marker', state: 'prepared' });
    expect(activeWholeFence(job)).toEqual({ marker:'new-marker', state:'prepared' });
    setActiveWholeFence(job, undefined);
    expect(activeWholeFence(job)).toBeUndefined(); expect(JSON.stringify(job.sourceFence)).toBe(old);
  });
  it('validates historical proof against origin despite current code and used counters advancing', async () => {
    await create(); const job = await read(); job.code = 'XHS_REQUEST_BUDGET_EXHAUSTED'; job.sourceGrant.used.detail++;
    await write(job); await db.$executeRaw`UPDATE xhs_request_budgets SET used=used+1 WHERE id IN ('job','xhs:source-total')`;
    expect(generationMatches(await read())).toBe(true); expect(await allowed()).toBe(marker);
  });
  it.each(['fence','code','grant','proofId','budgets'])('rejects altered origin %s even before any transport', async key => {
    await create(); const job = await read(); job.generation.origin[key] = null; await write(job);
    expect(generationMatches(job)).toBe(false); await expect(allowed()).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
  });
  it('rejects original unknown rewrite and old budget refunds', async () => {
    await create(); const original = await read(), changed = JSON.parse(JSON.stringify(original));
    changed.sourceFence.state='failed'; await write(changed); await expect(allowed()).rejects.toThrow();
    await write(original); await db.$executeRaw`UPDATE xhs_request_budgets SET used=5 WHERE id='job'`;
    await expect(allowed()).rejects.toThrow();
    await db.$executeRaw`UPDATE xhs_request_budgets SET used=6 WHERE id='job'`;
    await db.$executeRaw`UPDATE xhs_request_budgets SET used=7 WHERE id='xhs:source-total'`;
    await expect(allowed()).rejects.toThrow();
  });
  it('rejects another pending marker at creation and later admission', async () => {
    await db.$executeRawUnsafe("INSERT INTO xhs_request_budgets VALUES('xhs:dispatch-pending:other',1,1,0,0)");
    await expect(create()).rejects.toThrow();
    await db.$executeRawUnsafe("DELETE FROM xhs_request_budgets WHERE id='xhs:dispatch-pending:other'");
    await create(); await db.$executeRawUnsafe("INSERT INTO xhs_request_budgets VALUES('xhs:dispatch-pending:other',1,1,0,0)");
    await expect(allowed()).rejects.toThrow();
  });
  it('rejects duplicate generation and mismatched or stale generation scope', async () => {
    await create(); await expect(create()).rejects.toThrow(); const s = await scope();
    await expect(db.$transaction(tx => historicalGenerationMarker(tx, {...s, generationId:'wrong'}))).rejects.toThrow();
    await expect(db.$transaction(tx => historicalGenerationMarker(tx, {...s, authorId:'other'}))).rejects.toThrow();
  });
  it('rejects missing old marker, active other job, unresolved recovery and actual risk blocks', async () => {
    await create(); await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`; await expect(allowed()).rejects.toThrow();
    await db.$executeRaw`INSERT INTO xhs_request_budgets VALUES(${marker},1,1,0,0)`;
    await db.$executeRawUnsafe("INSERT INTO xhs_whole_creator_jobs VALUES('other','creator','running','{}',0)"); await expect(allowed()).rejects.toThrow();
    await db.$executeRawUnsafe("DELETE FROM xhs_whole_creator_jobs WHERE id='other'");
    await db.$executeRawUnsafe("INSERT INTO xhs_limited_recovery VALUES('unresolved','note','author','unknown')"); await expect(allowed()).rejects.toThrow();
    await db.$executeRaw`DELETE FROM xhs_limited_recovery`;
    await db.$executeRawUnsafe("UPDATE xhs_source_risk SET code='XHS_SOURCE_VERIFICATION_BLOCKED'"); await expect(allowed()).rejects.toThrow();
  });
  it('cannot create after previous single-note attempt or without explicit confirmation', async () => {
    await expect(db.$transaction(tx => createWholeGeneration(tx, {...input,confirmUnknown:false} as any,10000))).rejects.toThrow();
    const job = await read(); job.reviewAttempt={state:'consumed'}; await write(job); await expect(create()).rejects.toThrow();
  });
  it('rejects a counter regression but allows observed counts beyond the historical parent cap', async () => {
    await expect(db.$transaction(tx => createWholeGeneration(tx, {...input,phaseLimits:{...phaseLimits,detail:4}},10000))).rejects.toThrow();
    await expect(db.$transaction(tx => createWholeGeneration(tx, {...input,phaseLimits:{...phaseLimits,detail:311}},10000))).resolves.toMatchObject({state:'prepared'});
  });
  it('rolls back intent on interruption without changing any historical facts', async () => {
    const before = await read();
    await expect(db.$transaction(async tx => { await createWholeGeneration(tx,input,10000); throw Error('synthetic interruption'); })).rejects.toThrow('synthetic interruption');
    expect(await read()).toEqual(before);
  });
});
