"""Small real SQLite/process regressions; no production data or network."""
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("backup-sqlite.py")
spec = importlib.util.spec_from_file_location("backup", SCRIPT)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synthetic-backup-")
        self.addCleanup(self.temp.cleanup)
        self.database = Path(self.temp.name) / "source.db"
        self.backups = Path(self.temp.name) / "backups"
        with closing(sqlite3.connect(self.database)) as db:
            db.executescript("CREATE TABLE feeds(id INTEGER PRIMARY KEY, value INTEGER);"
                             "INSERT INTO feeds VALUES(1,0);"
                             "CREATE TABLE articles(id INTEGER PRIMARY KEY, body BLOB);")
            db.executemany("INSERT INTO articles(body) VALUES(?)", [(bytes(3500),)] * 1300)
            db.commit()

    def test_real_external_writer_and_consistent_copy_in_delete_and_wal(self):
        for mode in ("delete", "wal"):
            with self.subTest(mode=mode):
                with closing(sqlite3.connect(self.database)) as db:
                    db.execute("PRAGMA journal_mode=" + mode)
                    db.execute("UPDATE feeds SET value=0"); db.commit()
                worker = subprocess.Popen([
                    sys.executable, "-u", "-c",
                    "import sqlite3,sys; c=sqlite3.connect(sys.argv[1],timeout=2);"
                    "sys.stdin.readline(); c.execute('UPDATE feeds SET value=1');"
                    "print('updated',flush=True); c.commit(); print('committed',flush=True)",
                    str(self.database)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, text=True)
                real_connect = sqlite3.connect
                steps = []
                test = self

                class Source(sqlite3.Connection):
                    def backup(source, destination, **kwargs):
                        original = kwargs["progress"]

                        def progress(status, remaining, total):
                            steps.append((status, remaining, total))
                            if len(steps) == 1:
                                worker.stdin.write("go\n"); worker.stdin.flush()
                                test.assertEqual(worker.stdout.readline().strip(), "updated")
                                if mode == "delete":
                                    time.sleep(0.03)
                                    test.assertIsNone(worker.poll())  # commit waits on snapshot
                            original(status, remaining, total)

                        kwargs["progress"] = progress
                        return super().backup(destination, **kwargs)

                def connect(*args, **kwargs):
                    if str(args[0]) == self.database.as_uri() + "?mode=ro":
                        kwargs["factory"] = Source
                    return real_connect(*args, **kwargs)

                try:
                    with patch.object(backup.sqlite3, "connect", connect):
                        report = backup.create_backup(self.database, self.backups)
                    worker.stdin.close()
                    worker.wait(timeout=3)
                    self.assertEqual(worker.returncode, 0, worker.stderr.read())
                    self.assertEqual(worker.stdout.readline().strip(), "committed")
                    self.assertEqual(len(steps), 2)
                    self.assertEqual(steps[-1][0], sqlite3.SQLITE_DONE)
                    with closing(real_connect(report["backup"])) as saved:
                        self.assertEqual(saved.execute("PRAGMA integrity_check").fetchone(), ("ok",))
                        self.assertEqual(saved.execute("SELECT value FROM feeds").fetchone(), (0,))
                        self.assertEqual(saved.execute("SELECT COUNT(*) FROM articles").fetchone(), (1300,))
                    with closing(real_connect(self.database)) as source:
                        self.assertEqual(source.execute("SELECT value FROM feeds").fetchone(), (1,))
                    self.assertEqual(report["diagnostics"]["journalMode"], mode)
                    self.assertEqual(report["sha256"], backup.sha256(Path(report["backup"])))
                finally:
                    if worker.poll() is None:
                        worker.kill(); worker.wait(timeout=3)
                    worker.stdout.close(); worker.stderr.close()
                    if not worker.stdin.closed: worker.stdin.close()

    def test_copy_deadline_releases_sqlite_and_operation_locks_then_retry_succeeds(self):
        real_connect = sqlite3.connect

        class SlowSource(sqlite3.Connection):
            def backup(source, destination, **kwargs):
                original = kwargs["progress"]
                def progress(*args):
                    time.sleep(0.03)
                    original(*args)
                kwargs["progress"] = progress
                return super().backup(destination, **kwargs)

        def connect(*args, **kwargs):
            if str(args[0]) == self.database.as_uri() + "?mode=ro":
                kwargs["factory"] = SlowSource
            return real_connect(*args, **kwargs)

        diagnostics = backup.BackupDiagnostics()
        with patch.object(backup.sqlite3, "connect", connect):
            with self.assertRaises(TimeoutError):
                backup.create_backup(self.database, self.backups, copy_timeout=0.01,
                                     diagnostics=diagnostics)
        self.assertEqual(diagnostics.stage, "copy")
        self.assertFalse(list(self.backups.glob("*/verification.json")))
        # Same source is immediately writable; retry can acquire the operation lock.
        with closing(real_connect(self.database, timeout=0.1)) as db:
            db.execute("UPDATE feeds SET value=2"); db.commit()
        report = backup.create_backup(self.database, self.backups)
        self.assertEqual(report["integrityCheck"], "ok")
        with closing(real_connect(report["backup"])) as db:
            self.assertEqual(db.execute("SELECT value FROM feeds").fetchone(), (2,))

    def test_cli_failure_diagnostic_has_no_private_path_or_traceback(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--database",
                                 str(self.database.parent / "private-cookie-missing.db"),
                                 "--backup-root", str(self.backups)],
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        record = json.loads(result.stderr)
        self.assertEqual(record["event"], "sqlite-backup-failed")
        self.assertNotIn("private-cookie", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertLess(len(result.stderr), 4096)

    def test_hash_deadline_is_checked(self):
        with self.assertRaises(TimeoutError):
            backup.sha256(self.database, time.monotonic() - 1)

    def test_copy_budget_configuration_is_bounded_and_fails_closed(self):
        for value in ("nan", "inf", "0", "0.1", "-1", "16", "not-a-number"):
            with self.subTest(value=value), patch.dict(os.environ, {"SQLITE_BACKUP_COPY_TIMEOUT_SECONDS": value}):
                with self.assertRaises(ValueError):
                    backup.create_backup(self.database, self.backups)
                self.assertFalse(self.backups.exists())
        with patch.dict(os.environ, {"SQLITE_BACKUP_COPY_TIMEOUT_SECONDS": "1"}):
            self.assertEqual(backup.create_backup(self.database, self.backups)["integrityCheck"], "ok")

    def test_short_writer_timeout_rolls_back_and_retries_same_intent_after_snapshot(self):
        # A 50ms writer cannot commit while a rollback-journal snapshot is held.
        # Retrying MUST rollback the whole failed transaction before waiting;
        # this worker keeps one immutable intent and has an explicit retry bound.
        worker = subprocess.Popen([
            sys.executable, "-u", "-c",
            "import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1],timeout=.05);"
            "sys.stdin.readline();\n"
            "for attempt in range(8):\n"
            " try:\n"
            "  c.execute('UPDATE feeds SET value=value+1'); c.commit();"
            " print('committed',flush=True); break\n"
            " except sqlite3.OperationalError as error:\n"
            "  c.rollback()\n"
            "  if error.sqlite_errorcode not in (sqlite3.SQLITE_BUSY,sqlite3.SQLITE_LOCKED): raise\n"
            "  print('rolled-back',flush=True); time.sleep(.02)\n"
            "else: raise SystemExit('explicit retry exhaustion')\n",
            str(self.database)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)
        real_connect = sqlite3.connect
        test = self
        started = []

        class Source(sqlite3.Connection):
            def backup(source, destination, **kwargs):
                original = kwargs["progress"]
                def progress(status, remaining, total):
                    if not started:
                        started.append(True)
                        worker.stdin.write("go\n"); worker.stdin.flush()
                        test.assertEqual(worker.stdout.readline().strip(), "rolled-back")
                    original(status, remaining, total)
                kwargs["progress"] = progress
                return super().backup(destination, **kwargs)

        def connect(*args, **kwargs):
            if str(args[0]) == self.database.as_uri() + "?mode=ro":
                kwargs["factory"] = Source
            return real_connect(*args, **kwargs)
        try:
            with patch.object(backup.sqlite3, "connect", connect):
                report = backup.create_backup(self.database, self.backups)
            worker.stdin.close(); worker.wait(timeout=3)
            self.assertEqual(worker.returncode, 0, worker.stderr.read())
            self.assertIn("committed", worker.stdout.read())
            with closing(real_connect(self.database)) as db:
                self.assertEqual(db.execute("SELECT value FROM feeds").fetchone(), (1,))
            with closing(real_connect(report["backup"])) as db:
                self.assertEqual(db.execute("SELECT value FROM feeds").fetchone(), (0,))
        finally:
            if worker.poll() is None: worker.kill(); worker.wait(timeout=3)
            worker.stdout.close(); worker.stderr.close()
            if not worker.stdin.closed: worker.stdin.close()

    def test_autonomous_periodic_backup_allows_short_writer_to_commit_during_copy(self):
        worker = subprocess.Popen([
            sys.executable, "-u", "-c",
            "import sqlite3,sys; c=sqlite3.connect(sys.argv[1],timeout=.05);"
            "sys.stdin.readline(); c.execute('UPDATE feeds SET value=1');"
            "c.commit(); print('committed',flush=True)", str(self.database)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        real_connect = sqlite3.connect
        wrote = []
        test = self
        class Source(sqlite3.Connection):
            def backup(source, destination, **kwargs):
                original = kwargs["progress"]
                def progress(status, remaining, total):
                    if remaining and not wrote:
                        wrote.append(True)
                        worker.stdin.write("go\n"); worker.stdin.flush()
                        test.assertEqual(worker.stdout.readline().strip(), "committed")
                    original(status, remaining, total)
                kwargs["progress"] = progress
                return super().backup(destination, **kwargs)
        def connect(*args, **kwargs):
            if str(args[0]) == self.database.as_uri() + "?mode=ro": kwargs["factory"] = Source
            return real_connect(*args, **kwargs)
        try:
            with patch.object(backup.sqlite3, "connect", connect):
                report = backup.create_backup(self.database, self.backups, prefix="periodic-snapshot")
            worker.stdin.close(); worker.wait(timeout=3)
            self.assertEqual(worker.returncode, 0, worker.stderr.read())
            self.assertTrue(wrote)
            with closing(real_connect(report["backup"])) as saved:
                self.assertEqual(saved.execute("PRAGMA integrity_check").fetchone(), ("ok",))
                self.assertEqual(saved.execute("SELECT value FROM feeds").fetchone(), (1,))
        finally:
            if worker.poll() is None: worker.kill(); worker.wait(timeout=3)
            worker.stdout.close(); worker.stderr.close()
            if not worker.stdin.closed: worker.stdin.close()


if __name__ == "__main__":
    unittest.main()
