import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { RedbookPauseError } from './redbook-client';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { safeSourceFailure, writeSourceReceipt, SafeSourceReceipt, SourceReceiptScope } from './xhs-source-receipt';

describe('safe source receipts with real SQLite', () => {
  let db: PrismaClient, folder: string;
  const secret = 'SENSITIVE_cookie_token_url_headers_body';
  const scope: SourceReceiptScope = { jobId: 'job', creatorId: 'creator', authorId: 'author', generationId: 'generation', marker: 'active-marker', owner: { pid: 12, startIdentity: '12345678901234567', nonce: 'owner-nonce' } };
  const receipt = (change: Partial<SafeSourceReceipt> = {}): SafeSourceReceipt => ({ generationId: scope.generationId!, marker: scope.marker, owner: scope.owner, phase: 'detail', stage: 'response', outcome: 'response-received', settled: false, status: 200, ...change });
  const read = async () => JSON.parse((await db.$queryRaw<Array<{ document: string }>>`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`)[0].document);
  const write = (value = receipt(), binding = scope) => db.$transaction(tx => writeSourceReceipt(tx, binding, value));
  beforeAll(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'safe-source-receipt-'));
    db = new PrismaClient({ datasources: { db: { url: 'file:' + path.join(folder, 'fixture.db').replace(/\\/g, '/') } } });
    await db.$executeRawUnsafe('CREATE TABLE xhs_creators(id TEXT PRIMARY KEY, external_author_id TEXT)');
    await db.$executeRawUnsafe('CREATE TABLE xhs_whole_creator_jobs(id TEXT PRIMARY KEY, creator_id TEXT, state TEXT, document TEXT)');
    await db.$executeRaw`INSERT INTO xhs_creators VALUES('creator','author')`;
  });
  beforeEach(async () => {
    const job = { id: 'job', creatorId: 'creator', sourceGrant: { creatorId: 'creator', authorId: 'author' }, sourceFence: { marker: 'old-marker', state: 'started' },
      generation: { id: 'generation', activeFence: { marker: scope.marker, owner: scope.owner, phase: 'detail', state: 'started' } } };
    await db.$executeRaw`DELETE FROM xhs_whole_creator_jobs`;
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs VALUES('job','creator','running',${JSON.stringify(job)})`;
  });
  afterAll(async () => { await db.$disconnect(); await rm(folder, { recursive: true, force: true }); });

  it('projects only durable identity and fixed safe diagnostics', async () => {
    await write({ ...receipt(), generationId: secret, marker: secret, owner: { ...scope.owner, nonce: secret }, phase: secret, code: secret, headers: secret, body: secret, url: secret, message: secret, events: [{ stage: 'response', body: secret }] } as any);
    const job = await read();
    expect(JSON.stringify(job)).not.toContain(secret);
    expect(job.generation.activeFence.receipt).toEqual(job.generation.lastSourceReceipt);
    expect(job.generation.lastSourceReceipt).toMatchObject({ generationId: 'generation', marker: 'active-marker', owner: scope.owner, phase: 'detail', status: 200 });
    expect(job.sourceFence).toEqual({ marker: 'old-marker', state: 'started' });
  });
  it.each(['pid', 'startIdentity', 'nonce'])('rejects a mismatched owner %s', async key => {
    const owner = { ...scope.owner, [key]: key === 'pid' ? 99 : 'wrong' };
    await expect(write(receipt(), { ...scope, owner })).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
    expect((await read()).generation.lastSourceReceipt).toBeUndefined();
  });
  it('rejects wrong epoch, late old marker and author', async () => {
    for (const binding of [{ ...scope, generationId: 'old-generation' }, { ...scope, marker: 'old-marker' }, { ...scope, authorId: 'other' }])
      await expect(write(receipt(), binding)).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
    expect((await read()).generation.lastSourceReceipt).toBeUndefined();
  });
  it('ignores absent generation scopes and absent active fences without filling historical state', async () => {
    expect(await write(receipt(), { ...scope, generationId: undefined })).toBe(false);
    const job = await read(); delete job.generation.activeFence;
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id='job'`;
    expect(await write()).toBe(false); expect(await read()).toEqual(job);
  });
  it('allows paused owner writes and transaction rollback leaves no false receipt', async () => {
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET state='paused' WHERE id='job'`;
    await expect(db.$transaction(async tx => { await writeSourceReceipt(tx, scope, receipt()); throw Error('rollback'); })).rejects.toThrow('rollback');
    expect((await read()).generation.lastSourceReceipt).toBeUndefined();
    expect(await write()).toBe(true);
  });
  it('keeps stage monotonic, bounded events and response evidence across local failures', async () => {
    await write();
    for (let i = 0; i < 8; i++) {
      await write(receipt({ stage: 'transport', status: undefined, outcome: 'in-progress' }));
      await write(receipt({ stage: 'sent', status: undefined, outcome: 'in-progress' }));
      await write();
    }
    expect((await read()).generation.lastSourceReceipt.stage).toBe('response');
    expect(await write(receipt({ stage: 'admitted', outcome: 'not-sent' }))).toBe(false);
    await write(receipt({ stage: 'storage', status: undefined, outcome: 'local-failure', settled: true, code: 'XHS_STORAGE_FAILED' }));
    const saved = (await read()).generation.lastSourceReceipt;
    expect(saved).toMatchObject({ stage: 'storage', outcome: 'local-failure', status: 200, settled: true, code: 'XHS_STORAGE_FAILED' });
    expect(saved.events).toHaveLength(12); expect(saved.events.some((e: any) => e.stage === 'response')).toBe(true);
    expect(await write()).toBe(false); expect((await read()).generation.lastSourceReceipt).toEqual(saved);
  });
  it('drops invalid HTTP status and arbitrary parser messages', async () => {
    await write(receipt({ status: 999, code: secret }));
    expect((await read()).generation.lastSourceReceipt.status).toBeUndefined();
    expect((await read()).generation.lastSourceReceipt.code).toBeUndefined();
    expect(safeSourceFailure(new XhsSubscriptionError('XHS_PROFILE_SCHEMA_UNRECOGNIZED'), 'parse')).toEqual({ code: 'XHS_PROFILE_SCHEMA_UNRECOGNIZED', outcome: 'response-received' });
    expect(safeSourceFailure(new XhsSubscriptionError(secret), 'parse')).toEqual({ code: 'XHS_LOCAL_OPERATION_FAILED', outcome: 'response-received' });
  });
  it('isolates a second transport timeout from the first HTTP 200 in the same group', async () => {
    await write(receipt({ sequence: 1 }));
    await write(receipt({ sequence: 2, stage: 'transport', outcome: 'in-progress', status: undefined }));
    let current = (await read()).generation.lastSourceReceipt;
    expect(current).toMatchObject({ sequence: 2, stage: 'transport', outcome: 'in-progress' });
    expect(current.status).toBeUndefined();
    expect(await write(receipt({ sequence: 1 }))).toBe(false);
    const failure = safeSourceFailure(new RedbookPauseError('transport'), 'transport');
    await write(receipt({ sequence: 2, stage: 'transport', status: undefined, settled: true, ...failure }));
    current = (await read()).generation.lastSourceReceipt;
    expect(current).toMatchObject({ sequence: 2, stage: 'transport', outcome: 'unknown', settled: true });
    expect(current.status).toBeUndefined();
    expect(current.outcome).not.toBe('response-received');
    expect(current.events).toContainEqual({ stage: 'response', status: 200 });
  });
  it('keeps a terminal dispatch failure immutable even when stream quiescence remains unproven', async () => {
    await write(receipt({ stage:'response',outcome:'response-received',status:461,code:'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',settled:false }));
    const before=(await read()).generation.lastSourceReceipt;
    expect(await write(receipt({stage:'sent',status:undefined,outcome:'in-progress',settled:false}))).toBe(false);
    expect((await read()).generation.lastSourceReceipt).toEqual(before);
  });
  it('classifies fixed local codes without leaking error data or claiming unknown transport succeeded', () => {
    const values = [
      safeSourceFailure(Object.assign(Error(secret), { code: 'P2002', meta: secret }), 'storage'),
      safeSourceFailure(new TypeError(secret), 'checkpoint'),
      safeSourceFailure(new RedbookPauseError('transport'), 'transport'),
      safeSourceFailure(new RedbookPauseError('authentication', 401), 'transport'),
    ];
    expect(values).toEqual([{ code: 'XHS_STORAGE_FAILED', outcome: 'local-failure' }, { code: 'XHS_LOCAL_PROGRAM_ERROR', outcome: 'local-failure' },
      { code: 'XHS_SOURCE_TRANSPORT_BLOCKED', outcome: 'unknown' }, { code: 'XHS_SOURCE_AUTHENTICATION_BLOCKED', outcome: 'response-received' }]);
    expect(JSON.stringify(values)).not.toContain(secret);
  });
});
