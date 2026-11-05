import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';

/** Test-only: caller must supply a client bound to its newly created fixture. */
export async function applyFixtureMigrations(
  db: PrismaClient,
  range: { through?: string; after?: string } = {},
): Promise<void> {
  const root = path.resolve(__dirname, '../../prisma/migrations');
  for (const name of (await fs.readdir(root)).sort()) {
    if (!(await fs.stat(path.join(root, name))).isDirectory()) continue;
    if (
      (range.through && name > range.through) ||
      (range.after && name <= range.after)
    )
      continue;
    const sql = await fs.readFile(
      path.join(root, name, 'migration.sql'),
      'utf8',
    );
    for (const statement of splitSqliteStatements(sql)) {
      await db.$executeRawUnsafe(statement);
    }
  }
}
