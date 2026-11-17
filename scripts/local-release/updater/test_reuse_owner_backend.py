"""Actual temporary SQLite and OS locks; never production or a source request."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HERE = Path(__file__).resolve().parent
BACKUP_FILE = HERE.parents[2] / 'apps/server/scripts/backup-sqlite.py'
backup = load('fixed_backup_test', BACKUP_FILE)
worker = load('fixed_worker_test', HERE / 'reuse-owner-backend.py')


class ReuseOwnerBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fixed-reuse-owner-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.database = self.root / 'source.db'
        self.backups = self.root / 'backups'
        with closing(sqlite3.connect(self.database)) as db, db:
            db.executescript("CREATE TABLE feeds(id PRIMARY KEY);INSERT INTO feeds VALUES('synthetic');"
                             "CREATE TABLE articles(id PRIMARY KEY,body BLOB);INSERT INTO articles VALUES('a',X'0102');"
                             "CREATE TABLE requests(id PRIMARY KEY,state);INSERT INTO requests VALUES('u1','unknown');")
        report = backup.create_backup(self.database, self.backups)
        self.expected = Path(report['backup'])
        self.profile = self.root / 'profile.json'
        self.value = {'kind': 'fixed-held-same-schema-maintenance-v1', 'database': str(self.database),
                      'backupDataRoot': str(self.backups), 'backup': {'mode': 'exact-protected-reuse-v1',
                      'path': str(self.expected), 'sha256': report['sha256'],
                      'sourceIdentity': [str(self.database.stat().st_dev), str(self.database.stat().st_ino)],
                      'helper': {'path': str(BACKUP_FILE), 'sha256': worker.digest(BACKUP_FILE)},
                      'inventory': worker.inventory(self.backups), 'limits': [16*1024**3, 9, 4*1024**3]}}
        self.nonce = 'a' * 64
        self.tx = 'synthetic-transaction-123'
        self.sequence = 0

    def start(self, operation='admit'):
        self.profile.write_text(json.dumps(self.value), encoding='utf-8')
        child = subprocess.Popen([sys.executable, '-B', str(HERE / 'reuse-owner-backend.py'),
                                  str(self.profile), worker.digest(self.profile)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        def cleanup():
            if not child.stdin.closed:
                child.stdin.close()
            child.wait(timeout=10)
            child.stdout.close()
            child.stderr.close()
        self.addCleanup(cleanup)
        child.stdin.write(json.dumps({'operation': operation, 'transactionId': self.tx, 'nonce': self.nonce})+'\n')
        child.stdin.flush()
        result = json.loads(child.stdout.readline())
        return child, result

    def request(self, child, operation, **extra):
        self.sequence += 1
        child.stdin.write(json.dumps({'operation': operation, 'transactionId': self.tx, 'nonce': self.nonce,
                                     'sequence': self.sequence, **extra})+'\n')
        child.stdin.flush()
        return json.loads(child.stdout.readline())

    def test_admit_checks_and_close_preserve_all_rows_bytes_and_backup_inventory(self):
        before = self.database.read_bytes(), worker.inventory(self.backups)
        child, result = self.start()
        self.assertTrue(result['ready'])
        self.assertTrue(self.request(child, 'same')['same'])
        self.assertTrue(self.request(child, 'check')['ok'])
        self.assertTrue(self.request(child, 'close')['ok'])
        self.assertEqual(child.wait(timeout=10), 0)
        self.assertEqual(before, (self.database.read_bytes(), worker.inventory(self.backups)))

    def test_changed_source_refuses_admission_without_a_fresh_backup(self):
        before = worker.inventory(self.backups)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("INSERT INTO feeds VALUES('changed')")
        child, result = self.start()
        self.assertEqual(result['error'], 'REQUIRED_REUSE_UNAVAILABLE')
        self.assertEqual(child.wait(timeout=10), 1)
        self.assertEqual(worker.inventory(self.backups), before)

    def test_second_actual_worker_cannot_share_the_os_snapshot_lease(self):
        first, result = self.start()
        self.assertTrue(result['ready'])
        other, rejected = self.start()
        self.assertIn('error', rejected)
        self.assertEqual(other.wait(timeout=10), 1)
        self.assertTrue(self.request(first, 'same')['same'])

    def test_channel_replay_is_rejected_and_exits(self):
        child, result = self.start()
        self.assertTrue(result['ready'])
        self.assertEqual(self.request(child, 'check', sequence=0)['error'], 'REUSE_CHANNEL_REPLAY')
        self.assertEqual(child.wait(timeout=10), 1)

    def test_tampered_backup_during_ownership_fails_closed(self):
        child, result = self.start()
        self.assertTrue(result['ready'])
        with self.expected.open('ab') as stream:
            stream.write(b'tampered')
        self.assertIn('error', self.request(child, 'check'))
        self.assertEqual(child.wait(timeout=10), 1)

    def test_resume_is_not_claimed_equal_after_source_changes(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE requests SET state='still-unknown'")
        child, result = self.start('resume')
        self.assertTrue(result['ready'])
        self.assertFalse(self.request(child, 'same')['same'])
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute('SELECT state FROM requests').fetchone()[0], 'still-unknown')


if __name__ == '__main__':
    unittest.main()
