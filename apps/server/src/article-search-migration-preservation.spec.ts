import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { splitSqliteStatements } from '../../../scripts/sqlite-statements.cjs';
import { prepareBodySearch } from './article-body-search';

// This is a fresh synthetic schema20, never a production database copy.
describe('search migration20 to21 preserves all existing business tables', () => {
  let p: PrismaClient, root: string;
  const migration = '20261020160000_local_body_search';
  const migrations = resolve(__dirname, '../prisma/migrations');
  const tables = [
    'accounts',
    'articles',
    'cache_insert_batches',
    'cache_refresh_commits',
    'feeds',
    'management_groups',
    'refresh_submission_claims',
    'xhs_creators',
    'xhs_notes',
  ];
  const digest = async () =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (name) => {
          const rows = await p.$queryRawUnsafe<any[]>(
            `SELECT * FROM "${name}" ORDER BY id`,
          );
          return [
            name,
            createHash('sha256')
              .update(
                JSON.stringify(rows, (_key, value) =>
                  typeof value === 'bigint'
                    ? { bigint: value.toString() }
                    : Buffer.isBuffer(value)
                      ? { bytes: value.toString('hex') }
                      : value,
                ),
              )
              .digest('hex'),
          ];
        }),
      ),
    );
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wewe-search-preservation-'));
    p = new PrismaClient({
      datasources: {
        db: { url: 'file:' + join(root, 'synthetic.db').replace(/\\/g, '/') },
      },
    });
    for (const name of readdirSync(migrations)
      .filter((n) => /^\d/.test(n) && n !== migration)
      .sort())
      for (const statement of splitSqliteStatements(
        readFileSync(join(migrations, name, 'migration.sql'), 'utf8'),
      ))
        if (statement.trim()) await p.$executeRawUnsafe(statement);
    await p.managementGroup.create({
      data: { id: 'group', name: 'Synthetic group', platform: 'wechat' },
    });
    await p.account.create({
      data: {
        id: 'account',
        name: 'Synthetic account',
        token: 'synthetic-token',
      },
    });
    await p.feed.create({
      data: {
        id: 'feed',
        mpName: 'Synthetic feed',
        mpCover: '',
        mpIntro: '',
        updateTime: 123,
        groupId: 'group',
        providerRefreshAttemptTime: 456,
      },
    });
    await p.article.create({
      data: {
        id: 'article',
        mpId: 'feed',
        title: 'Synthetic title',
        picUrl: '',
        publishTime: 123,
        contentHtml:
          '<p>正文保护合成词</p><img src="data:image/png;base64,c3ludGhldGlj">',
        metrics: '{"read":17}',
        readCount: 17,
        likeCount: 3,
        lastBodyStatus: 'cached',
        lastBodyRetry: 'synthetic-retained-status',
        verifiedSourceUrl: 'https://example.invalid/synthetic',
      },
    });
    await p.xhsCreator.create({
      data: {
        id: 'creator',
        profileUrl: 'https://example.invalid/creator',
        displayName: 'Synthetic creator',
      },
    });
    await p.xhsNote.create({
      data: {
        id: 'note',
        creatorId: 'creator',
        title: 'Synthetic note',
        publishTime: 123,
        status: 'complete',
        contentHtml: '<p>synthetic note</p>',
        videoBytes: Buffer.from('synthetic-video'),
        videoMimeType: 'video/mp4',
        videoExpectedBytes: 15,
        videoSha256: 'synthetic-sha',
      },
    });
    await p.cacheInsertBatch.create({
      data: {
        id: 'insert',
        mpId: 'feed',
        articleManifest: '["article"]',
        snapshotGeneration: 'snapshot',
        guardGeneration: 'guard',
        backupStartedAtMs: 1n,
        coverageAtMs: 2n,
        createdCount: 1,
        committedAtMs: 3n,
      },
    });
    await p.cacheRefreshCommit.create({
      data: {
        id: 'commit',
        mpId: 'feed',
        resultJson: '{"state":"unknown","requestId":"synthetic"}',
        committedAtMs: 4n,
      },
    });
    await p.refreshSubmissionClaim.create({
      data: {
        id: 'claim',
        mpId: 'feed',
        state: 'unknown',
        reservedAt: 456,
        previousAt: 123,
        updatedAtMs: 5n,
      },
    });
  });
  afterAll(async () => {
    await p?.$disconnect();
    if (root) rmSync(root, { recursive: true, force: true });
  });
  it('migration and local extraction change only derived rows, retaining unknown claims and original body/media/metrics', async () => {
    const before = await digest();
    expect(Object.keys(before)).toEqual(tables);
    for (const table of tables)
      expect(await p.$queryRawUnsafe(`SELECT id FROM "${table}"`)).toHaveLength(
        1,
      );
    const sql = readFileSync(
      join(migrations, migration, 'migration.sql'),
      'utf8',
    );
    expect(
      createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
    ).toBe('ff72e5e104374f9ce6b45ef8a9b0320a8bc310a26a447a33f2e4636cf2c36fad');
    await p.$transaction(async (tx) => {
      for (const statement of splitSqliteStatements(sql))
        if (statement.trim()) await tx.$executeRawUnsafe(statement);
    });
    expect(await digest()).toEqual(before);
    await prepareBodySearch(p);
    expect(await digest()).toEqual(before);
    expect(
      await p.refreshSubmissionClaim.findUnique({ where: { id: 'claim' } }),
    ).toMatchObject({
      state: 'unknown',
      reservedAt: 456,
      previousAt: 123,
      updatedAtMs: 5n,
    });
    expect(
      await p.articleSearchDocument.findUnique({
        where: { articleId: 'article' },
        select: { bodyText: true, pending: true },
      }),
    ).toEqual({ bodyText: '正文保护合成词', pending: false });
  });
});
