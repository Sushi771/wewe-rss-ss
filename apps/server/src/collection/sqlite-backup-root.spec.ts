import * as path from 'node:path';
import {
  backupForecastMessage,
  periodicLifecycleMessage,
  resolveSqliteBackupRoot,
} from './sqlite-backup-root';
describe('one SQLite backup root for every entrypoint', () => {
  it('shows actual cadence and estimate for both daily and 15-minute forecasts', () => {
    expect(
      backupForecastMessage({
        warning: true,
        continuousChangedSnapshotIntervalSeconds: 86400,
        estimatedDaysAtContinuousChanges: 12,
      }),
    ).toContain('每24小时一份');
    expect(
      backupForecastMessage({
        warning: true,
        continuousChangedSnapshotIntervalSeconds: 900,
        estimatedDaysAtContinuousChanges: 0.5,
      }),
    ).toContain('每15分钟一份');
    expect(
      backupForecastMessage({
        warning: true,
        continuousChangedSnapshotIntervalSeconds: 'private/path',
        estimatedDaysAtContinuousChanges: NaN,
      }),
    ).not.toContain('private');
    expect(backupForecastMessage({ warning: false })).toBe('');
  });
  it('explains pending/unknown operations without asserting a fresh lease or deleting recovery points', () => {
    expect(
      periodicLifecycleMessage({ status: 'pending-confirmation' }),
    ).toContain('确认本次精确淘汰前');
    expect(
      periodicLifecycleMessage({ status: 'retirement-started' }),
    ).toContain('不能据此获得新鲜快照许可');
    expect(periodicLifecycleMessage({ status: 'ready' })).toBe('');
    expect(periodicLifecycleMessage({ status: 'C:/private/path' })).toBe('');
  });
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
