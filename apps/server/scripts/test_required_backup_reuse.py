"""Exact maintenance reuse, real temporary SQLite only; no production/network."""
import hashlib
import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('required_backup', Path(__file__).with_name('backup-sqlite.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class RequiredReuseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='required-reuse-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.database, self.backups = self.root / 'source.db', self.root / 'backups'
        with closing(sqlite3.connect(self.database)) as db, db:
            db.executescript("CREATE TABLE feeds(id PRIMARY KEY); INSERT INTO feeds VALUES(1);"
                             "CREATE TABLE articles(id PRIMARY KEY, body BLOB); INSERT INTO articles VALUES(1,X'010203');"
                             "CREATE TABLE requests(id PRIMARY KEY,state); INSERT INTO requests VALUES('unknown-1','unknown');")
        self.report = backup.create_backup(self.database, self.backups)
        self.expected = Path(self.report['backup'])
        self.sha = self.report['sha256']
        self.receipt = self.backups / ('.latest-' + hashlib.sha256(str(self.database).encode()).hexdigest()[:24] + '.json')

    def call(self, **kwargs):
        with patch.object(backup, 'create_backup', side_effect=AssertionError('fresh fallback forbidden')):
            return backup.require_reusable(self.database, self.backups, kwargs.pop('expected', self.expected), kwargs.pop('sha', self.sha), **kwargs)

    def inventory(self):
        return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.backups.rglob('*') if p.is_file()}

    def test_exact_backup_reuses_without_copy_metadata_update_or_unknown_mutation(self):
        before, original = self.inventory(), self.database.read_bytes()
        report = self.call()
        self.assertTrue(report['reused'])
        self.assertEqual(report['backup'], str(self.expected))
        self.assertEqual(report['reuseProof'], 'all-schema-and-typed-rows-pinned-snapshot-v1')
        self.assertEqual(self.inventory(), before)
        self.assertEqual(self.database.read_bytes(), original)

    def test_repeat_is_idempotent(self):
        before = self.inventory()
        self.assertEqual(self.call(), self.call())
        self.assertEqual(self.inventory(), before)

    def test_real_wal_source_is_verified_without_rewriting_its_rows(self):
        with closing(sqlite3.connect(self.database)) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute("INSERT INTO articles VALUES(2,X'ABCD')")
            db.commit()
            self.report = backup.create_backup(self.database, self.backups)
            self.expected, self.sha = Path(self.report['backup']), self.report['sha256']
            before = self.inventory()
            self.assertTrue(self.call()['reused'])
            self.assertEqual(self.inventory(), before)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM articles').fetchone()[0], 2)

    def test_changed_source_refuses_without_fresh_fallback(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE articles SET body=X'010204'")
        before = self.inventory()
        with self.assertRaisesRegex(ValueError, 'REUSE_UNAVAILABLE'):
            self.call()
        self.assertEqual(self.inventory(), before)

    def test_wrong_expected_hash_refuses(self):
        with self.assertRaisesRegex(ValueError, 'REUSE_UNAVAILABLE'):
            self.call(sha='f' * 64)

    def test_another_backup_is_not_substituted(self):
        other = self.backups / 'other.db'
        other.write_bytes(self.expected.read_bytes())
        with self.assertRaisesRegex(ValueError, 'REUSE_UNAVAILABLE'):
            self.call(expected=other)

    def test_tampered_backup_refuses(self):
        with self.expected.open('ab') as stream:
            stream.write(b'tampered')
        with self.assertRaisesRegex(ValueError, 'REUSE_UNAVAILABLE'):
            self.call()

    def test_hardlinked_snapshot_is_not_a_plain_protected_input(self):
        os.link(self.expected, self.backups / 'untrusted-alias.db')
        with self.assertRaisesRegex(ValueError, 'REUSE_FILE_INVALID'):
            self.call()

    def test_periodic_origin_is_not_promoted_to_protected(self):
        report = json.loads(self.receipt.read_text())
        report['recoveryOrigin']['kind'] = 'periodic'
        self.receipt.write_text(json.dumps(report))
        with self.assertRaisesRegex(ValueError, 'REUSE_UNAVAILABLE'):
            self.call()

    def test_source_change_after_comparison_refuses(self):
        real = backup.reusable
        def changed(*args, **kwargs):
            result = real(*args, **kwargs)
            with closing(sqlite3.connect(self.database)) as db, db:
                db.execute("INSERT INTO articles VALUES(2,X'AB')")
            return result
        with patch.object(backup, 'reusable', changed), self.assertRaisesRegex(ValueError, 'REUSE_CHANGED'):
            self.call()

    def test_receipt_change_after_comparison_refuses(self):
        real = backup.reusable
        def changed(*args, **kwargs):
            result = real(*args, **kwargs)
            with self.receipt.open('ab') as stream:
                stream.write(b' ')
            return result
        with patch.object(backup, 'reusable', changed), self.assertRaisesRegex(ValueError, 'REUSE_CHANGED'):
            self.call()

    def test_unknown_nonempty_journal_is_preserved_and_blocks(self):
        journal = Path(str(self.database) + '-journal')
        journal.write_bytes(b'unknown unfinished journal')
        with self.assertRaisesRegex(ValueError, 'SOURCE_UNSETTLED'):
            self.call()
        self.assertEqual(journal.read_bytes(), b'unknown unfinished journal')

    def test_existing_full_snapshot_lock_blocks_concurrent_reuse(self):
        key = hashlib.sha256(str(self.database).encode()).hexdigest()[:24]
        with backup.FileLock(self.database.parent / ('.full-snapshot-' + key + '.lock')):
            with self.assertRaises(TimeoutError):
                self.call(timeout=0.03)

    def test_lost_full_snapshot_lock_is_not_accepted_as_proof(self):
        with patch.object(backup.FileLock, 'check', side_effect=ValueError('owner-lock-replaced')):
            with self.assertRaisesRegex(ValueError, 'owner-lock-replaced'):
                self.call()

    def test_schema_change_invalidates_the_existing_snapshot(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('CREATE TABLE extra(id INTEGER)')
        with self.assertRaisesRegex(ValueError, 'REUSE_UNAVAILABLE'):
            self.call()

    def test_invalid_hash_and_timeout_do_not_guess(self):
        for value in ['', '0' * 63, None]:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'INPUT_INVALID'):
                self.call(sha=value)
        for value in [0, -1, 56, float('inf'), True]:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'INPUT_INVALID'):
                self.call(timeout=value)


if __name__ == '__main__':
    unittest.main()
