"""Finite synthetic SQLite samples only; no network or production files."""

from contextlib import contextmanager, closing
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "guard", Path(__file__).with_name("sqlite-snapshot-guard.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@contextmanager
def connect(*args, **kwargs):
    with closing(sqlite3.connect(*args, **kwargs)) as db:
        with db:
            yield db

class Clock:
    def __init__(self):
        self.wall = 100000
        self.mono = 1000

    def advance(self, seconds):
        self.wall += seconds
        self.mono += seconds


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wewe-snapshot-test-")
        self.root = Path(self.temp.name)
        self.database = self.root / "source.db"
        self.backups = self.root / "backups"
        with connect(self.database) as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE feeds(id TEXT PRIMARY KEY, name TEXT);
                CREATE TABLE articles(id TEXT PRIMARY KEY, body TEXT);
                INSERT INTO feeds VALUES ('old-feed','Old feed');
                INSERT INTO articles VALUES ('old-article','Complete old body');
            """)
        self.clock = Clock()
        self.guards = []

    def tearDown(self):
        for guard in self.guards:
            guard.close()
        self.temp.cleanup()

    def guard(self, backup=module.backup_module.create_backup):
        guard = module.SnapshotGuard(
            self.database, self.backups, wall=lambda: self.clock.wall,
            monotonic=lambda: self.clock.mono, backup=backup
        )
        self.guards.append(guard)
        return guard

    def insert(self, name="new"):
        with connect(self.database) as db:
            db.execute("INSERT INTO articles VALUES (?,?)", (name, "New complete body"))

    def snapshots(self):
        return list(self.backups.glob("periodic-snapshot-*/wewe-rss.db"))

    def test_startup_requires_new_verified_backup_and_restores_old_rows(self):
        guard = self.guard()
        self.assertFalse(guard.query()["fresh"])
        guard.tick()
        lease = guard.query()["lease"]
        self.assertTrue(guard.validate(lease["token"])["fresh"])
        self.assertEqual(len(self.snapshots()), 1)
        restored = self.root / "restored.db"
        with connect(guard.record["backup"]) as source:
            with connect(restored) as target:
                source.backup(target)
        with connect(restored) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(db.execute("SELECT * FROM articles").fetchall(),
                             [("old-article", "Complete old body")])
            self.assertEqual(db.execute("SELECT * FROM feeds").fetchall(),
                             [("old-feed", "Old feed")])

    def test_15_minute_nochange_proof_preserves_real_backup_times(self):
        guard = self.guard()
        guard.tick()
        start, success = guard.record["backupStartedAtMs"], guard.record["backupSucceededAtMs"]
        self.clock.advance(900)
        self.assertEqual(guard.query()["reason"], "snapshot-expired")
        guard.tick()
        self.assertTrue(guard.query()["fresh"])
        self.assertEqual(len(self.snapshots()), 1)
        self.assertEqual(guard.record["backupStartedAtMs"], start)
        self.assertEqual(guard.record["backupSucceededAtMs"], success)
        self.assertEqual(guard.record["coverageAtMs"], self.clock.wall * 1000)
        self.assertEqual(guard.query()["lease"]["elapsedSinceBackupSuccessMs"], 900000)

    def test_dirty_notifies_next_tick_without_per_query_backup(self):
        guard = self.guard()
        guard.tick()
        lease = guard.query()["lease"]
        self.insert()
        guard.dirty(lease["token"])
        for _ in range(10):
            self.assertTrue(guard.query()["fresh"])
        self.assertEqual(len(self.snapshots()), 1)
        self.clock.advance(900)
        guard.tick()
        self.assertEqual(len(self.snapshots()), 2)
        with connect(guard.record["backup"]) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM articles").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT body FROM articles WHERE id='old-article'").fetchone()[0],
                             "Complete old body")

    def test_lost_dirty_signal_and_ordinary_concurrent_write_are_detected(self):
        guard = self.guard()
        guard.tick()
        self.insert()
        self.clock.advance(900)
        guard.tick()
        self.assertEqual(len(self.snapshots()), 2)

    def test_restart_ignores_edited_owner_and_fully_revalidates_existing_bytes(self):
        guard = self.guard()
        guard.tick()
        old_lease = guard.query()['lease']
        saved = Path(guard.record['backup']).read_bytes()
        copy_start = guard.record['copyStartedAtUtc']
        guard.close()
        self.guards.remove(guard)
        receipt = json.loads(guard.receipt.read_text())
        receipt["coverageAtMs"] = 9999999999999
        guard.receipt.write_text(json.dumps(receipt))
        restarted = self.guard()
        self.assertFalse(restarted.query()["fresh"])
        with patch.object(module.backup_module, 'snapshot_equal', wraps=module.backup_module.snapshot_equal) as compare:
            restarted.tick()
        self.assertEqual(compare.call_count, 1)
        self.assertTrue(restarted.query()["fresh"])
        self.assertNotEqual(restarted.generation, guard.generation)
        self.assertNotEqual(restarted.record['snapshotGeneration'], guard.record['snapshotGeneration'])
        self.assertFalse(restarted.validate(old_lease['token'])['fresh'])
        self.assertTrue(restarted.record['backupReused'])
        self.assertEqual(restarted.record['copyStartedAtUtc'], copy_start)
        self.assertEqual(Path(restarted.record['backup']).read_bytes(), saved)
        self.assertEqual(len(self.snapshots()), 1)

    def test_multi_process_owner_lock_fails_promptly_and_does_not_stack(self):
        guard = self.guard()
        guard.tick()
        child = subprocess.run([
            sys.executable, str(Path(module.__file__)), "--database", str(self.database),
            "--backup-root", str(self.backups)
        ], input="", text=True, capture_output=True, timeout=5)
        self.assertNotEqual(child.returncode, 0)
        self.assertEqual(child.stdout, "")
        self.assertEqual(len(self.snapshots()), 1)
        self.assertTrue(guard.query()["fresh"])

    def test_lease_expires_and_clock_rollback_permanently_disables(self):
        guard = self.guard()
        guard.tick()
        lease = guard.query()["lease"]
        self.clock.advance(6)
        self.assertFalse(guard.validate(lease["token"])["fresh"])
        self.clock.wall -= 100
        self.assertFalse(guard.query()["fresh"])
        self.clock.advance(1000)
        guard.tick()
        self.assertFalse(guard.query()["fresh"])

    def test_monotonic_age_catches_frozen_wall_clock(self):
        guard = self.guard()
        guard.tick()
        self.clock.mono += 900
        self.assertEqual(guard.query()["reason"], "snapshot-expired")

    def test_deleted_modified_or_truncated_snapshot_fails_closed(self):
        for action in ["delete", "truncate", "edit"]:
            with self.subTest(action=action):
                guard = self.guard()
                guard.tick()
                snapshot = Path(guard.record["backup"])
                if action == "delete":
                    snapshot.unlink()
                elif action == "truncate":
                    snapshot.write_bytes(b"bad")
                else:
                    with snapshot.open("r+b") as stream:
                        stream.seek(120)
                        stream.write(b"bad")
                self.assertFalse(guard.query()["fresh"])
                guard.close()
                self.guards.remove(guard)

    def test_receipt_edit_delete_and_truncate_fails_closed(self):
        for data in [b"{}", b"", None]:
            with self.subTest(data=data):
                guard = self.guard()
                guard.tick()
                if data is None:
                    guard.receipt.unlink()
                else:
                    guard.receipt.write_bytes(data)
                self.assertFalse(guard.query()["fresh"])
                guard.close()
                self.guards.remove(guard)

    def test_database_replacement_fails_closed_without_following_new_file(self):
        guard = self.guard()
        guard.tick()
        replacement = self.root / "replacement.db"
        with connect(replacement) as db:
            db.execute("CREATE TABLE alien(id)")
        # Windows disallows replacing an open SQLite handle; either outcome is
        # safe. On systems permitting replacement, identity detects it.
        try:
            os.replace(replacement, self.database)
        except PermissionError:
            with patch.object(module, "identity", return_value=["other", "inode"]):
                self.assertFalse(guard.query()["fresh"])
        else:
            self.assertFalse(guard.query()["fresh"])

    def test_schema_change_invalidates_lease_even_if_file_path_unchanged(self):
        guard = self.guard()
        guard.tick()
        lease = guard.query()["lease"]
        with connect(self.database) as db:
            db.execute("CREATE TABLE changed(id)")
        self.assertFalse(guard.validate(lease["token"])["fresh"])

    def test_backup_and_disk_failure_drop_previous_protection(self):
        for failure in [OSError("disk full"), TimeoutError("locked")]:
            with self.subTest(failure=type(failure)):
                guard = self.guard()
                guard.tick()
                self.insert(str(type(failure)))
                guard.backup = lambda *args, **kwargs: (_ for _ in ()).throw(failure)
                self.clock.advance(900)
                guard.tick()
                self.assertFalse(guard.query()["fresh"])
                guard.close()
                self.guards.remove(guard)

    def test_receipt_write_disk_failure_does_not_publish_verified_state(self):
        guard = self.guard()
        with patch.object(guard, "persist", side_effect=OSError("disk full")):
            guard.tick()
        self.assertFalse(guard.query()["fresh"])

    def test_concurrent_backup_write_keeps_start_bound_and_does_not_fake_nochange(self):
        def backup(*args, **kwargs):
            report = module.backup_module.create_backup(*args, **kwargs)
            self.insert()
            self.clock.advance(30)
            return report

        guard = self.guard(backup)
        start = self.clock.wall
        guard.tick()
        lease = guard.query()["lease"]
        self.assertEqual(lease["backupStartedAtMs"], start * 1000)
        self.assertEqual(lease["backupSucceededAtMs"], (start + 30) * 1000)
        self.assertEqual(lease["conservativeRecoveryWindowMs"], 30000)
        self.assertTrue(guard.record["dirty"])
        self.assertIsNone(guard.record["unchangedVersion"])

    def test_bad_report_and_actual_bad_snapshot_never_publish_lease(self):
        def bad_backup(*args, **kwargs):
            report = module.backup_module.create_backup(*args, **kwargs)
            report["sha256"] = "0" * 64
            return report

        guard = self.guard(bad_backup)
        guard.tick()
        self.assertFalse(guard.query()["fresh"])

    def test_real_online_api_timeout_is_bounded(self):
        with self.assertRaises(TimeoutError):
            module.backup_module.create_backup(self.database, self.backups, timeout=-1)

    def test_full_backup_operation_lock_timeout_cannot_stack_snapshots(self):
        key = hashlib.sha256(str(self.database.resolve()).encode()).hexdigest()[:24]
        lock_path = self.database.parent / f".full-snapshot-{key}.lock"
        with module.backup_module.FileLock(lock_path):
            child_code = (
                "import importlib.util,pathlib;"
                f"s=importlib.util.spec_from_file_location('b',{str(Path(module.__file__).with_name('backup-sqlite.py'))!r});"
                "b=importlib.util.module_from_spec(s);s.loader.exec_module(b);"
                f"b.create_backup(pathlib.Path({str(self.database)!r}),pathlib.Path({str(self.backups)!r}),timeout=0.1)"
            )
            child = subprocess.run([sys.executable, "-c", child_code],
                                   capture_output=True, timeout=5)
            self.assertNotEqual(child.returncode, 0)
            self.assertIn(b"lock unavailable", child.stderr)
            self.assertFalse(list(self.backups.glob("*-*/wewe-rss.db")))

    def test_actual_online_backup_handles_inflight_wal_writer(self):
        # A finite ~8MB fixture guarantees several online backup progress steps.
        with connect(self.database) as db:
            db.executemany("INSERT INTO articles VALUES (?,?)",
                           [(f"row-{i}", "x" * 4096) for i in range(2000)])
        real_connect = sqlite3.connect
        wrote = []

        class ConcurrentSource(sqlite3.Connection):
            def backup(source, target, **kwargs):
                original_progress = kwargs["progress"]

                def progress(status, remaining, total):
                    if remaining and not wrote:
                        with closing(real_connect(self.database)) as writer:
                            with writer:
                                writer.execute("INSERT INTO articles VALUES ('inflight','body')")
                        wrote.append(True)
                    original_progress(status, remaining, total)

                kwargs["progress"] = progress
                return super().backup(target, **kwargs)

        def concurrent_connect(*args, **kwargs):
            if kwargs.get("uri") and "mode=ro" in str(args[0]) and str(self.database.name) in str(args[0]):
                kwargs["factory"] = ConcurrentSource
            return real_connect(*args, **kwargs)

        with patch.object(module.backup_module.sqlite3, "connect", concurrent_connect):
            report = module.backup_module.create_backup(self.database, self.backups)
        self.assertTrue(wrote)
        with connect(report["backup"]) as saved:
            self.assertEqual(saved.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(saved.execute("SELECT body FROM articles WHERE id='old-article'").fetchone(),
                             ("Complete old body",))
            self.assertIn(saved.execute("SELECT COUNT(*) FROM articles").fetchone()[0], [2001, 2002])


if __name__ == "__main__":
    unittest.main()
