import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import * as claims from './refresh-submission-claim';
import * as registry from './provider-registry';
import { TrpcService } from '../trpc/trpc.service';
import { CollectionService } from './collection.service';
import {
  beginRefreshSubmission,
  finishRefreshSubmission,
  refreshSubmissionProof,
  reserveRefreshSubmission,
  RefreshSubmissionTicket,
} from './refresh-submission-claim';
import {
  readRefreshResponseReceipt,
  refreshSubmissionFailure,
  saveRefreshResponseReceipt,
} from './refresh-response-receipt';

describe('validated refresh response proof (tiny owned SQLite, no network)', () => {
  const env = { ...process.env },
    id = 'MP_WXS_1234567890',
    batch = 'synthetic-response-round';
  let root: string,
    database: string,
    prisma: PrismaClient,
    ticket: RefreshSubmissionTicket;
  const file = () =>
    path.join(root, '.wechat2rss-refresh-responses', ticket.id + '.json');
  const response = () => ({
    version: 1 as const,
    httpStatus: 200 as const,
    receivedAt: Date.now(),
    responseDigest: 'a'.repeat(64),
  });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'refresh-response-proof-'));
    database = path.join(root, 'fixture.db');
    Object.assign(process.env, {
      DATABASE_URL: 'file:' + database,
      WECHAT2RSS_BASE_URL: 'http://127.0.0.1:18080/',
      WECHAT2RSS_TOKEN: 'synthetic-private-token',
    });
    prisma = new PrismaClient({
      datasources: { db: { url: 'file:' + database } },
    });
    const directory = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(directory)).sort()) {
      const sql = await fs
        .readFile(path.join(directory, name, 'migration.sql'), 'utf8')
        .catch(() => '');
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    const feed = await prisma.feed.create({
      data: {
        id,
        mpName: 'synthetic',
        mpCover: '',
        mpIntro: '',
        status: 1,
        collectionChannel: 'wechat2rss',
        providerRefreshAttemptTime: 0,
        updateTime: 0,
      },
    });
    ticket = (
      await reserveRefreshSubmission(
        prisma,
        feed,
        batch,
        Math.floor(Date.now() / 1000),
      )
    ).ticket!;
    await beginRefreshSubmission(prisma, ticket);
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(Error('REAL_NETWORK_FORBIDDEN'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma?.$disconnect();
    process.env = { ...env };
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^refresh-response-proof-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const state = async () =>
    (
      await prisma.$queryRawUnsafe<Array<{ state: string }>>(
        'SELECT state FROM refresh_submission_claims WHERE id=?',
        ticket.id,
      )
    )[0].state;
  it('repairs unknown after restart only from a complete matching response proof, without requests', async () => {
    await saveRefreshResponseReceipt(ticket, response());
    const raw = await fs.readFile(file(), 'utf8');
    await finishRefreshSubmission(prisma, ticket, 'unknown');
    await prisma.$disconnect();
    prisma = new PrismaClient({
      datasources: { db: { url: 'file:' + database } },
    });
    expect(await refreshSubmissionProof(prisma, batch, id)).toBe('accepted');
    expect(await state()).toBe('accepted');
    expect(await refreshSubmissionProof(prisma, batch, id)).toBe('accepted');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(raw).not.toMatch(/synthetic-private-token|http:|synthetic"/);
    await expect(fs.readFile(file())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not infer acceptance from an attempted/unknown ledger or cache/check activity', async () => {
    await finishRefreshSubmission(prisma, ticket, 'unknown');
    expect(await refreshSubmissionProof(prisma, batch, id)).toBe('unknown');
    expect(await state()).toBe('unknown');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('keeps an existing verified proof immutable and never starts another attempt', async () => {
    await saveRefreshResponseReceipt(ticket, response());
    const raw = await fs.readFile(file(), 'utf8');
    await saveRefreshResponseReceipt(ticket, response());
    expect(await fs.readFile(file(), 'utf8')).toBe(raw);
    await expect(beginRefreshSubmission(prisma, ticket)).rejects.toThrow(
      'REFRESH_ALREADY_ATTEMPTED',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('a cleanup failure cannot downgrade a strict committed SQL accepted receipt', async () => {
    await saveRefreshResponseReceipt(ticket, response());
    const unlink = fs.unlink.bind(fs);
    const remove = jest
      .spyOn(fs, 'unlink')
      .mockImplementation(async (target) => {
        if (String(target) === file())
          throw Object.assign(Error('synthetic cleanup busy'), {
            code: 'EACCES',
          });
        return unlink(target);
      });
    await expect(
      finishRefreshSubmission(prisma, ticket, 'accepted'),
    ).resolves.toBeUndefined();
    remove.mockRestore();
    expect(await state()).toBe('accepted');
    expect(
      await readRefreshResponseReceipt(ticket.responseContext!, ticket),
    ).toBe(true);
    expect(await refreshSubmissionProof(prisma, batch, id)).toBe('accepted');
  });
  it('rechecks a changed source inside the repair transaction rather than trusting a prior proof read', async () => {
    await saveRefreshResponseReceipt(ticket, response());
    const other = new PrismaClient({
      datasources: { db: { url: 'file:' + database } },
    });
    const transaction = prisma.$transaction.bind(prisma);
    const tx = jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(async (fn: any) => {
        await other.feed.update({
          where: { id },
          data: { mpName: 'concurrent-source-change' },
        });
        return transaction(fn);
      });
    try {
      expect(await refreshSubmissionProof(prisma, batch, id)).toBe('unknown');
    } finally {
      tx.mockRestore();
      await other.$disconnect();
    }
    expect(await state()).toBe('attempted');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it.each(['before-commit', 'ack-lost'])(
    'recovers a batch after validated-response SQL %s failure and restart, with only one submit',
    async (mode) => {
      const secondId = 'MP_WXS_2234567890';
      await prisma.feed.create({
        data: {
          id: secondId,
          mpName: 'synthetic-next',
          updateTime: 0,
          mpCover: '',
          mpIntro: '',
          status: 1,
          collectionChannel: 'wechat2rss',
        },
      });
      process.env.WECHAT2RSS_ENABLED = '1';
      const send = jest.fn();
      jest.spyOn(registry, 'wechat2RssProvider').mockReturnValue({
        checkAccountStatus: async () => ({
          available: true,
          challenged: false,
        }),
        prepareRefreshSubscription:
          async (
            _id: string,
            _automatic: boolean,
            accepted: (receipt: ReturnType<typeof response>) => Promise<void>,
          ) =>
          async () => {
            send();
            await accepted(response());
            return { accepted: true, pending: true };
          },
        fetchArticles: async () => ({
          articles: [],
          upstreamCount: 0,
          bodyMissing: 0,
          imageBlocked: 0,
          coverage: 'recent-window',
        }),
      } as any);
      const make = () =>
        new TrpcService(
          prisma as any,
          { get: () => ({ url: '', updateDelayTime: 0 }) } as any,
          {} as any,
          new CollectionService(prisma as any),
        );
      const first = make();
      const finish = claims.finishRefreshSubmission;
      let failed = false;
      jest
        .spyOn(claims, 'finishRefreshSubmission')
        .mockImplementation(async (p, t, s) => {
          if (s === 'accepted' && !failed) {
            failed = true;
            if (mode === 'ack-lost') await finish(p, t, s);
            throw Error('private SQL detail ?k=secret');
          }
          return finish(p, t, s);
        });
      const original = await first.beginManualRefreshAll(
        [secondId],
        'f'.repeat(64),
      );
      const batches = (first as any).subscriptionBatches;
      try {
        await batches.runDue();
        expect((await batches.list())[0].items[0]).toMatchObject({
          submissionUnknown: true,
          submissionFailure: {
            phase: 'sql-receipt',
            code: 'REFRESH_RECEIPT_SQL_FAILED',
          },
        });
        expect(JSON.stringify(await batches.list())).not.toMatch(
          /private SQL|secret/,
        );
      } finally {
        first.onModuleDestroy();
      }
      const restarted = make();
      try {
        await (restarted as any).subscriptionBatches.runDue();
        await (restarted as any).subscriptionBatches.runDue();
        expect(
          await claims.readRefreshSubmission(
            prisma,
            original.batchId,
            secondId,
          ),
        ).toMatchObject({ accepted: true, submissionUnknown: false });
        expect(
          (await (restarted as any).subscriptionBatches.list())[0].items[0],
        ).toMatchObject({ accepted: true, submissionUnknown: false });
        expect(send).toHaveBeenCalledTimes(1);
        expect(global.fetch).not.toHaveBeenCalled();
      } finally {
        restarted.onModuleDestroy();
      }
    },
  );
  it('retains proof through an interrupted SQL repair and heals once the existing strict writer works', async () => {
    await saveRefreshResponseReceipt(ticket, response());
    const tx = jest
      .spyOn(prisma, '$transaction')
      .mockRejectedValueOnce(Error('synthetic SQL busy'));
    await expect(refreshSubmissionProof(prisma, batch, id)).rejects.toThrow(
      'synthetic SQL busy',
    );
    expect(await state()).toBe('attempted');
    tx.mockRestore();
    expect(await refreshSubmissionProof(prisma, batch, id)).toBe('accepted');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it.each([
    'truncated',
    'oversized',
    'checksum',
    'feed',
    'reservation',
    'future',
    'instance',
  ])('rejects %s proof instead of promoting unknown', async (kind) => {
    await saveRefreshResponseReceipt(ticket, response());
    await finishRefreshSubmission(prisma, ticket, 'unknown');
    const raw = JSON.parse(await fs.readFile(file(), 'utf8'));
    if (kind === 'truncated') await fs.writeFile(file(), '{"version":');
    else if (kind === 'oversized') await fs.writeFile(file(), 'x'.repeat(4097));
    else if (kind === 'instance')
      process.env.WECHAT2RSS_TOKEN = 'different-instance';
    else {
      if (kind === 'checksum') raw.checksum = 'b'.repeat(64);
      if (kind === 'feed') raw.feedId = 'MP_WXS_2234567890';
      if (kind === 'reservation') raw.reservedAt += 1;
      if (kind === 'future') raw.response.receivedAt = Date.now() + 3600000;
      if (kind !== 'checksum') {
        const payload = { ...raw };
        delete payload.checksum;
        raw.checksum = createHash('sha256')
          .update(JSON.stringify(payload))
          .digest('hex');
      }
      await fs.writeFile(file(), JSON.stringify(raw));
    }
    await expect(refreshSubmissionProof(prisma, batch, id)).rejects.toThrow(
      'REFRESH_RESPONSE_RECEIPT_INVALID',
    );
    expect(await state()).toBe('unknown');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('does not apply a matching old proof after the source or reservation changes', async () => {
    await saveRefreshResponseReceipt(ticket, response());
    await finishRefreshSubmission(prisma, ticket, 'unknown');
    await prisma.feed.update({
      where: { id },
      data: { collectionChannel: 'public-album' },
    });
    expect(await refreshSubmissionProof(prisma, batch, id)).toBe('unknown');
    expect(await state()).toBe('unknown');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('cannot transfer an old claim proof to a recreated feed with identical visible metadata', async () => {
    await saveRefreshResponseReceipt(ticket, response());
    await finishRefreshSubmission(prisma, ticket, 'unknown');
    const original = await prisma.feed.findUniqueOrThrow({ where: { id } });
    await prisma.feed.delete({ where: { id } });
    await prisma.feed.create({
      data: {
        ...original,
        createdAt: new Date(original.createdAt.getTime() + 1),
      },
    });
    await expect(refreshSubmissionProof(prisma, batch, id)).rejects.toThrow(
      'REFRESH_RESPONSE_RECEIPT_INVALID',
    );
    expect(await state()).toBe('unknown');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('racing independent clients can only promote the same proven claim once', async () => {
    await saveRefreshResponseReceipt(ticket, response());
    const other = new PrismaClient({
      datasources: { db: { url: 'file:' + database } },
    });
    try {
      expect(
        await Promise.all([
          refreshSubmissionProof(prisma, batch, id),
          refreshSubmissionProof(other, batch, id),
        ]),
      ).toEqual(['accepted', 'accepted']);
    } finally {
      await other.$disconnect();
    }
    expect(await state()).toBe('accepted');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('publishes no readable proof when fsync fails, and stores no raw exception text', async () => {
    const open = fs.open.bind(fs);
    const spy = jest
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (!String(args[0]).endsWith('.tmp')) return handle;
        return new Proxy(handle, {
          get(target, key) {
            if (key === 'sync')
              return async () => {
                throw Error('private secret body https://host/?k=secret');
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      });
    await expect(
      saveRefreshResponseReceipt(ticket, response()),
    ).rejects.toThrow('REFRESH_RESPONSE_RECEIPT_STORAGE_FAILED');
    spy.mockRestore();
    expect(
      await readRefreshResponseReceipt(ticket.responseContext!, ticket),
    ).toBe(false);
    expect(await refreshSubmissionProof(prisma, batch, id)).toBe('unknown');
    expect(
      refreshSubmissionFailure(
        Error('private secret https://host/?k=secret'),
        'sql-receipt',
      ),
    ).toEqual({ phase: 'sql-receipt', code: 'REFRESH_RECEIPT_SQL_FAILED' });
  });
  it('publishes no accepted proof when atomic publication fails after fsync', async () => {
    const link = jest
      .spyOn(fs, 'link')
      .mockRejectedValueOnce(
        Object.assign(Error('synthetic publication fault'), { code: 'EIO' }),
      );
    await expect(
      saveRefreshResponseReceipt(ticket, response()),
    ).rejects.toThrow('REFRESH_RESPONSE_RECEIPT_STORAGE_FAILED');
    link.mockRestore();
    expect(
      await readRefreshResponseReceipt(ticket.responseContext!, ticket),
    ).toBe(false);
    expect(await state()).toBe('attempted');
    expect(await fs.readdir(path.dirname(file()))).toEqual([]);
  });
  it('cannot transfer a response proof to a replaced database file', async () => {
    await saveRefreshResponseReceipt(ticket, response());
    await prisma.$disconnect();
    expect(path.dirname(database)).toBe(root);
    await fs.rename(database, path.join(root, 'original-fixture.db'));
    await fs.writeFile(database, 'different synthetic database identity');
    await expect(
      readRefreshResponseReceipt(ticket.responseContext!, ticket),
    ).rejects.toThrow('REFRESH_RESPONSE_RECEIPT_INVALID');
  });
  it.each(['disk', 'durability'])(
    'does not bypass %s admission while repairing an accepted proof',
    async (kind) => {
      await saveRefreshResponseReceipt(ticket, response());
      if (kind === 'disk') {
        const original = fs.statfs.bind(fs);
        const space = jest
          .spyOn(fs, 'statfs')
          .mockImplementation(
            async (...args: Parameters<typeof fs.statfs>) =>
              ({ ...(await original(...args)), bavail: 0n }) as any,
          );
        await expect(refreshSubmissionProof(prisma, batch, id)).rejects.toThrow(
          'INCREMENTAL_DISK_SPACE_INSUFFICIENT',
        );
        space.mockRestore();
      } else {
        await prisma.$executeRawUnsafe('PRAGMA synchronous=OFF');
        await expect(refreshSubmissionProof(prisma, batch, id)).rejects.toThrow(
          'INCREMENTAL_DURABILITY_MODE_UNPROVED',
        );
        await prisma.$executeRawUnsafe('PRAGMA synchronous=FULL');
      }
      expect(await state()).toBe('attempted');
      expect(await refreshSubmissionProof(prisma, batch, id)).toBe('accepted');
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );
});
