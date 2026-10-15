import * as path from 'node:path';
import { resolveSqliteBackupRoot } from './sqlite-backup-root';
describe('one SQLite backup root for every entrypoint', () => {
  const database = path.resolve('fixture/source.db');
  it('defaults to the existing backups root without silently migrating history', () => {
    expect(resolveSqliteBackupRoot(database, {})).toBe(
      path.join(path.dirname(database), 'backups'),
    );
  });
  it('honors an explicit production root and separates explicit test roots', () => {
    const production = path.resolve('production-recovery'),
      test = path.resolve('synthetic-recovery');
    expect(
      resolveSqliteBackupRoot(database, {
        SQLITE_PRODUCTION_BACKUP_ROOT: production,
      }),
    ).toBe(production);
    expect(
      resolveSqliteBackupRoot(database, {
        SQLITE_BACKUP_KIND: 'test',
        SQLITE_PRODUCTION_BACKUP_ROOT: production,
        SQLITE_TEST_BACKUP_ROOT: test,
      }),
    ).toBe(test);
    expect(
      resolveSqliteBackupRoot(database, {
        SQLITE_BACKUP_KIND: 'test',
        SQLITE_PRODUCTION_BACKUP_ROOT: production,
      }),
    ).toBe(path.join(path.dirname(database), 'backups'));
  });
  it.each(['relative/folder', 'invalid\nfolder'])(
    'rejects unsafe configured roots: %s',
    (configured) => {
      expect(() =>
        resolveSqliteBackupRoot(database, {
          SQLITE_PRODUCTION_BACKUP_ROOT: configured,
        }),
      ).toThrow();
    },
  );
});
