import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { applyFixtureMigrations } from '../../test/redbook-isolated/fixture-migrations';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
jest.setTimeout(60000);

it('upgrades a synthetic older schema while preserving existing publisher, article and creator data', async () => {
  const root = await fs.mkdtemp(
      path.join(tmpdir(), 'redbook-old-schema-fixture-'),
    ),
    file = path.join(root, 'fixture.sqlite');
  const db = new PrismaClient({
    datasources: { db: { url: 'file:' + file.replace(/\\/g, '/') } },
  });
  try {
    const cutoff = '20261009050000_add_xhs_local_archive';
    await applyFixtureMigrations('file:' + file.replace(/\\/g, '/'), {
      through: cutoff,
    });
    for (const sql of splitSqliteStatements(
      "INSERT INTO feeds(id,mp_name,mp_cover,mp_intro,update_time) VALUES('old-feed','old name','cover','intro',123); INSERT INTO articles(id,mp_id,title,pic_url,publish_time,content_html) VALUES('old-article','old-feed','old title','pic',456,'old body'); INSERT INTO xhs_creators(id,profile_url,display_name,external_author_id,enabled) VALUES('old-creator','https://example.invalid/old','old creator','old-author',1); INSERT INTO xhs_notes(id,creator_id,title,publish_time,status,content_html) VALUES('old-note','old-creator','old note',789,'complete','old note body');",
    ))
      await db.$executeRawUnsafe(sql);
    const tables = ['feeds', 'articles', 'xhs_creators', 'xhs_notes'];
    const columns = await Promise.all(
      tables.map(async (t) =>
        (await db.$queryRawUnsafe<any[]>(`PRAGMA table_info(${t})`)).map(
          (r) => r.name,
        ),
      ),
    );
    const snapshot = async (t: string, cols: string[]) =>
      JSON.stringify(
        await db.$queryRawUnsafe(
          `SELECT ${cols.map((c) => '"' + c + '"').join(',')} FROM ${t} ORDER BY id`,
        ),
        (_key, value) => (typeof value === 'bigint' ? Number(value) : value),
      );
    const before = await Promise.all(
      tables.map((t, i) => snapshot(t, columns[i])),
    );
    await applyFixtureMigrations('file:' + file.replace(/\\/g, '/'), {
      after: cutoff,
    });
    expect(
      await Promise.all(tables.map((t, i) => snapshot(t, columns[i]))),
    ).toEqual(before);
    expect(
      (await db.$queryRawUnsafe<any[]>('PRAGMA quick_check'))[0].quick_check,
    ).toBe('ok');
    expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});
