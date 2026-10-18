"""Synthetic rotation rehearsal only; no production retention or deletion hook."""
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('backup-sqlite.py')
spec = importlib.util.spec_from_file_location('backup', SCRIPT)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)

class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='space-compat-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / 'source.db'
        self.backups = self.root / 'backups'
        with closing(sqlite3.connect(self.source)) as db, db:
            db.executescript('CREATE TABLE feeds(id PRIMARY KEY,name);'
                             'CREATE TABLE articles(id PRIMARY KEY,body,metric);'
                             'INSERT INTO feeds VALUES(1,"subscription retained");'
                             'INSERT INTO articles VALUES(1,"old body",99);')
        self.settings = patch.dict(os.environ, {'SQLITE_BACKUP_KIND': 'test',
                                               'SQLITE_TEST_MAX_COPIES': '4'})
        self.settings.start()
        self.addCleanup(self.settings.stop)

    def change(self, value):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute('INSERT INTO articles VALUES(?,?,?)', (value, 'new body', value))

    def verify(self, report):
        self.assertEqual(backup.sha256(Path(report['backup'])), report['sha256'])
        with closing(sqlite3.connect(Path(report['backup']))) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone(), ('ok',))
            self.assertEqual(db.execute('SELECT body,metric FROM articles WHERE id=1').fetchone(), ('old body',99))
            self.assertEqual(db.execute('SELECT name FROM feeds WHERE id=1').fetchone(), ('subscription retained',))

    def test_synthetic_approved_rotation_uses_spare_slot_and_retains_boundary_and_latest(self):
        boundary = backup.create_backup(self.source,self.backups)
        previous = None
        for value in range(2,10):
            self.change(value)
            latest = backup.create_backup(self.source,self.backups)
            self.verify(latest)
            self.verify(boundary)
            # Represents one explicitly approved synthetic expired intermediate
            # point. This code is test-only, never a production maintenance API.
            if previous:
                old = Path(previous['backup']).parent.resolve()
                self.assertTrue(old.is_relative_to(self.root))
                self.assertNotEqual(old, Path(boundary['backup']).parent)
                self.assertNotEqual(old, Path(latest['backup']).parent)
                shutil.rmtree(old)
            previous = latest
            self.assertEqual(len(list(self.backups.rglob('*.db'))),2)
        with closing(sqlite3.connect(self.source)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM articles').fetchone(),(9,))

    def test_failed_replacement_does_not_remove_any_recovery_point_then_admission_recovers(self):
        first = backup.create_backup(self.source,self.backups)
        self.change(2)
        with patch.dict(os.environ,{'SQLITE_TEST_MAX_BYTES':'1'}):
            with self.assertRaisesRegex(ValueError,'SPACE_BUDGET_EXCEEDED'):
                backup.create_backup(self.source,self.backups)
        self.verify(first)
        self.assertEqual(len(list(self.backups.rglob('*.db'))),1)
        second = backup.create_backup(self.source,self.backups)
        self.verify(second)
        self.assertEqual(len(list(self.backups.rglob('*.db'))),2)

    def test_real_cli_capacity_error_is_safe_and_actionable(self):
        result = subprocess.run([sys.executable,str(SCRIPT),'--database',str(self.source),
                                 '--backup-root',str(self.backups)],capture_output=True,text=True,
                                env={**os.environ,'SQLITE_TEST_MAX_BYTES':'1'},timeout=5)
        self.assertEqual(result.returncode,1)
        error = json.loads(result.stderr)
        self.assertEqual(error['reason'],'space-budget')
        self.assertNotIn(str(self.root),result.stderr)
        self.assertFalse(self.backups.exists())

    def test_reuse_hash_deadline_is_not_bypassed_by_verified_receipt(self):
        first = backup.create_backup(self.source,self.backups)
        with patch.object(backup,'sha256',side_effect=TimeoutError('synthetic deadline')):
            with self.assertRaises(TimeoutError):
                backup.create_backup(self.source,self.backups)
        self.verify(first)

if __name__=='__main__':
    unittest.main()
