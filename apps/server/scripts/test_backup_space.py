import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup_sqlite', Path(__file__).with_name('backup-sqlite.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)

class BackupSpaceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wewe-budget-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.database = self.root / 'source.db'
        self.backups = self.root / 'backups'
        with closing(sqlite3.connect(self.database)) as db, db:
            db.executescript('CREATE TABLE feeds(id); CREATE TABLE articles(id,body); INSERT INTO feeds VALUES(1); INSERT INTO articles VALUES(1,"synthetic");')
    def test_unchanged_backup_is_verified_and_reused_without_new_copy(self):
        original = self.database.read_bytes()
        first = backup.create_backup(self.database, self.backups)
        second = backup.create_backup(self.database, self.backups)
        self.assertTrue(second['reused'])
        self.assertEqual(first['backup'], second['backup'])
        self.assertEqual(first['startedAtUtc'], second['startedAtUtc'])
        self.assertEqual(len(list(self.backups.rglob('*.db'))), 1)
        self.assertEqual(self.database.read_bytes(), original)
    def test_changed_source_at_quota_is_refused_and_unique_recovery_point_untouched(self):
        first = backup.create_backup(self.database, self.backups)
        saved = Path(first['backup']).read_bytes()
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('UPDATE articles SET body="changed"')
        with patch.dict(os.environ, {'SQLITE_PRODUCTION_MAX_COPIES': '1'}):
            with self.assertRaisesRegex(ValueError, 'budget exceeded'):
                backup.create_backup(self.database, self.backups)
        self.assertEqual(Path(first['backup']).read_bytes(), saved)
        self.assertEqual(len(list(self.backups.rglob('*.db'))), 1)
    def test_corrupted_receipt_and_backup_do_not_get_reused(self):
        first = backup.create_backup(self.database, self.backups)
        Path(first['backup']).write_bytes(b'corrupt')
        second = backup.create_backup(self.database, self.backups)
        self.assertFalse(second['reused'])
        self.assertNotEqual(first['backup'], second['backup'])
        self.assertEqual(Path(first['backup']).read_bytes(), b'corrupt')
    def test_free_space_byte_and_count_checks_happen_before_database_generation(self):
        for settings in [{'SQLITE_PRODUCTION_MAX_BYTES': '1'}, {'SQLITE_PRODUCTION_MIN_FREE_BYTES': str(2**60)}]:
            with patch.dict(os.environ, settings):
                with self.assertRaisesRegex(ValueError, 'budget exceeded'):
                    backup.create_backup(self.database, self.backups)
            self.assertFalse(self.backups.exists())
    def test_nested_destination_refused_and_failed_attempts_count_against_budget(self):
        with self.assertRaisesRegex(ValueError, 'Nested'):
            backup.create_backup(self.database, self.root)
        self.backups.mkdir()
        (self.backups/'failed.db').write_bytes(b'partial previous attempt')
        with patch.dict(os.environ, {'SQLITE_PRODUCTION_MAX_COPIES': '1'}):
            with self.assertRaisesRegex(ValueError, 'budget exceeded'):
                backup.create_backup(self.database, self.backups)
        self.assertEqual((self.backups/'failed.db').read_bytes(), b'partial previous attempt')
    def test_wal_change_invalidates_reuse(self):
        db = sqlite3.connect(self.database)
        self.addCleanup(db.close)
        db.execute('PRAGMA journal_mode=WAL')
        backup.create_backup(self.database, self.backups)
        db.execute('UPDATE articles SET body="wal changed"'); db.commit()
        second = backup.create_backup(self.database, self.backups)
        self.assertFalse(second['reused'])
        with closing(sqlite3.connect(second['backup'])) as copied:
            self.assertEqual(copied.execute('SELECT body FROM articles').fetchone()[0], 'wal changed')
    def test_existing_lease_fails_closed_without_deletion(self):
        self.backups.mkdir()
        lock = self.backups/'.space-budget.lock'; lock.write_text('operator review needed')
        with self.assertRaises(FileExistsError):
            backup.create_backup(self.database, self.backups)
        self.assertEqual(lock.read_text(), 'operator review needed')
    def test_metadata_touch_with_identical_content_does_not_duplicate_backup(self):
        first = backup.create_backup(self.database, self.backups)
        os.utime(self.database, ns=(self.database.stat().st_atime_ns, self.database.stat().st_mtime_ns + 1000000000))
        second = backup.create_backup(self.database, self.backups)
        self.assertTrue(second['reused'])
        self.assertEqual(first['backup'], second['backup'])
    def test_test_budget_scans_aggregate_sibling_runs(self):
        sibling = self.root/'run-old'; sibling.mkdir(); (sibling/'old.db').write_bytes(b'old')
        with patch.dict(os.environ, {'SQLITE_BACKUP_KIND': 'test', 'SQLITE_TEST_BUDGET_ROOT': str(self.root), 'SQLITE_TEST_MAX_COPIES': '2'}):
            with self.assertRaisesRegex(ValueError, 'budget exceeded'):
                backup.create_backup(self.database, self.backups)
        self.assertEqual((sibling/'old.db').read_bytes(), b'old')

if __name__ == '__main__':
    unittest.main()
