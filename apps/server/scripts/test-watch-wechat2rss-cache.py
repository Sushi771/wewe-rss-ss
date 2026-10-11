"""Offline synthetic SQLite/WAL regression and latency reference."""
import importlib.util
import json
import os
import queue
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

SCRIPT = Path(__file__).with_name("watch-wechat2rss-cache.py")
spec = importlib.util.spec_from_file_location("cache_monitor", SCRIPT)
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


def fixture(database, count=1):
    connection = sqlite3.connect(database)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.executescript(
        "CREATE TABLE rsses(biz_id INTEGER);"
        "CREATE TABLE articles(id INTEGER PRIMARY KEY,biz_id INTEGER,o_id TEXT,"
        "url TEXT,title TEXT,created TEXT,pic_url TEXT,content TEXT);"
    )
    connection.execute("INSERT INTO rsses VALUES (1234567890)")
    connection.executemany(
        "INSERT INTO articles VALUES (?,1234567890,?,'url','title','time','','old')",
        [(i, str(i)) for i in range(1, count + 1)],
    )
    connection.commit()
    return connection


class CacheMonitorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(
            dir=os.environ.get("CACHE_MONITOR_TEST_ROOT") or os.getcwd())
        self.database = Path(self.directory.name) / "cache.db"
        self.writer = fixture(self.database)
        self.children = []
    def tearDown(self):
        self.writer.close()
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)
            child.stdout.close()
            child.stderr.close()
            child.stdin.close()
        self.directory.cleanup()
    def reader(self):
        return sqlite3.connect(self.database.as_uri() + "?mode=ro", uri=True)
    def start(self, hints=False):
        # Synthetic clock override applies to this fixture process only.
        code = ("import importlib.util,sys;"
                "s=importlib.util.spec_from_file_location('m',sys.argv[1]);"
                "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
                "m.daytime=lambda:True;sys.argv=['monitor','--database',sys.argv[2]]+sys.argv[3:];m.main()")
        child = subprocess.Popen([sys.executable, "-u", "-c", code, str(SCRIPT), str(self.database)] +
                                 (["--event-hints"] if hints else []), stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        events = queue.Queue()
        def read():
            for line in child.stdout:
                events.put((time.monotonic(), json.loads(line)))
        threading.Thread(target=read, daemon=True).start()
        self.children.append(child)
        return child, events
    def test_hints_confirm_commit_coalesce_and_poll_after_lost_event(self):
        child, events = self.start(hints=True)
        _, first = events.get(timeout=4)
        self.writer.execute("UPDATE articles SET content='new' WHERE id=1")
        child.stdin.write("1\n" * 10)
        child.stdin.flush()
        with self.assertRaises(queue.Empty):
            events.get(timeout=0.2)  # Events cannot expose an uncommitted row.
        self.writer.commit()
        child.stdin.write("1\n")
        child.stdin.flush()
        _, second = events.get(timeout=4)
        self.assertNotEqual(first, second)
        child.stdin.write("1\n" * 10)
        child.stdin.flush()
        with self.assertRaises(queue.Empty):
            events.get(timeout=0.2)
        self.writer.execute("UPDATE articles SET content='old' WHERE id=1")
        self.writer.commit()  # Deliberately no hint: the 1s reconciliation still works.
        _, third = events.get(timeout=4)
        self.assertEqual(first, third)
    def test_hint_supervisor_eof_closes_monitor(self):
        child, events = self.start(hints=True)
        events.get(timeout=4)
        child.stdin.close()
        self.assertEqual(child.wait(timeout=3), 0)
    def test_persistent_connection_wal_commit_checkpoint_and_readonly(self):
        with closing(self.reader()) as reader:
            before = reader.execute("PRAGMA data_version").fetchone()[0]
            old = monitor.fingerprints(reader)
            # Updating the body with unchanged time/size must still be detected.
            self.writer.execute("UPDATE articles SET content='new' WHERE id=1")
            self.writer.commit()
            after = reader.execute("PRAGMA data_version").fetchone()[0]
            self.assertNotEqual(before, after)
            self.assertNotEqual(old, monitor.fingerprints(reader))
            self.writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self.assertEqual(monitor.fingerprints(reader), monitor.fingerprints(self.writer))
            with self.assertRaises(sqlite3.OperationalError):
                reader.execute("UPDATE articles SET content='forbidden'")
    def test_daytime_boundaries(self):
        for instant, expected in [("2026-10-11T15:59:59+00:00", True),
                                  ("2026-10-11T16:00:00+00:00", False),
                                  ("2026-10-11T21:59:59+00:00", False),
                                  ("2026-10-11T22:00:00+00:00", True)]:
            self.assertEqual(monitor.daytime(datetime.fromisoformat(instant)), expected)
    def test_wal_notification_latency_and_no_unchanged_events(self):
        child, events = self.start()
        _, first = events.get(timeout=4)
        landed = time.monotonic()
        self.writer.execute("UPDATE articles SET content='new' WHERE id=1")
        self.writer.commit()
        commit = time.monotonic()
        detected, second = events.get(timeout=4)
        self.assertNotEqual(first, second)
        latency = detected - commit
        self.assertLess(latency, 2)
        with self.assertRaises(queue.Empty):
            events.get(timeout=1.15)
        print(json.dumps({"synthetic_cache_commit_to_signal_ms": round(latency * 1000, 3),
                          "fixture_write_commit_ms": round((commit - landed) * 1000, 3)}))
        child.kill()
        child.wait(timeout=3)
    def test_metadata_write_then_delayed_same_size_body_write(self):
        child, events = self.start()
        _, first = events.get(timeout=4)
        self.writer.execute("UPDATE rsses SET biz_id=biz_id")
        self.writer.commit()
        with self.assertRaises(queue.Empty):
            events.get(timeout=1.15)
        self.writer.execute("UPDATE articles SET content='new' WHERE id=1")
        self.writer.commit()
        _, second = events.get(timeout=4)
        self.assertNotEqual(first, second)
        child.kill()
        child.wait(timeout=3)
    def test_database_replacement_reopens_readonly_connection(self):
        child, events = self.start()
        _, first = events.get(timeout=4)
        replacement = Path(self.directory.name) / "replacement.db"
        writer = fixture(replacement)
        writer.execute("UPDATE articles SET content='replacement'")
        writer.commit()
        writer.close()
        # Close the fixture writer/checkpoint WAL before replacing the main DB.
        self.writer.close()
        os.replace(replacement, self.database)
        _, second = events.get(timeout=4)
        self.assertNotEqual(first, second)
        child.kill()
        child.wait(timeout=3)
    def test_idle_data_version_cpu_and_content_scan_reference(self):
        for biz in range(1234567891, 1234567904):
            self.writer.execute("INSERT INTO rsses VALUES (?)", (biz,))
            self.writer.executemany(
                "INSERT INTO articles(biz_id,o_id,url,title,created,pic_url,content)"
                "VALUES (?,?,'url','title','time','','body')",
                [(biz, str(i)) for i in range(100)],
            )
        self.writer.commit()
        with closing(self.reader()) as reader:
            cpu_start = time.process_time_ns()
            for _ in range(1000):
                reader.execute("PRAGMA data_version").fetchone()
            idle_ms = (time.process_time_ns() - cpu_start) / 1000000
            cpu_start = time.process_time_ns()
            wall_start = time.perf_counter()
            for _ in range(20):
                hashes = monitor.fingerprints(reader)
            scan_ms = (time.process_time_ns() - cpu_start) / 20000000
            scan_wall_ms = (time.perf_counter() - wall_start) * 1000 / 20
        self.assertEqual(len(hashes), 14)
        print(json.dumps({"fixture_feeds": 14, "fixture_articles": 1301,
                          "cpu_1000_data_version_checks_ms": round(idle_ms, 3),
                          "cpu_one_changed_snapshot_ms": round(scan_ms, 3),
                          "wall_one_changed_snapshot_ms": round(scan_wall_ms, 3)}))


if __name__ == "__main__":
    unittest.main()
