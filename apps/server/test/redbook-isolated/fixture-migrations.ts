import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { withFixtureMigrationConnection } from '../fixture-migration-connection';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';

/** Test-only: caller supplies the URL of its newly created fixture explicitly. */
export async function applyFixtureMigrations(
  originalFixtureUrl: string,
  range: { through?: string; after?: string } = {},
): Promise<void> {
  const root = path.resolve(__dirname, '../../prisma/migrations');
  await withFixtureMigrationConnection(originalFixtureUrl, async (db) => {
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
  });
}
