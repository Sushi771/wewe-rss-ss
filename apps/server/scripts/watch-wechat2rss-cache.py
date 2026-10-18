"""Read-only local cache notification. Never reads configs, cookies or licenses."""
import argparse
import hashlib
import json
import os
import sqlite3
import time
import threading
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


def daytime(now=None):
    now = now or datetime.now(timezone.utc)
    return now.astimezone(timezone(timedelta(hours=8))).hour >= 6


def fingerprints(connection):
    # Include body/media bytes: updated_at and publication time alone cannot
    # detect a later fill of the same article. Only run on data_version changes.
    hashes = {}
    rows = connection.execute(
        "SELECT biz_id,o_id,url,title,created,pic_url,content FROM articles "
        "WHERE biz_id IN (SELECT biz_id FROM rsses) ORDER BY biz_id,id"
    )
    for row in rows:
        biz = str(row[0])
        if not biz.isdecimal() or not 5 <= len(biz) <= 15:
            raise ValueError("CACHE_ID_INVALID")
        digest = hashes.setdefault("MP_WXS_" + biz, hashlib.sha256())
        digest.update(json.dumps(row[1:], ensure_ascii=False,
                                 separators=(",", ":")).encode("utf-8"))
        digest.update(b"\n")
    # An empty subscription still has a fingerprint, for restart/new-feed checks.
    for (biz,) in connection.execute("SELECT biz_id FROM rsses"):
        biz = str(biz)
        if biz.isdecimal() and 5 <= len(biz) <= 15:
            hashes.setdefault("MP_WXS_" + biz, hashlib.sha256())
    return {key: value.hexdigest() for key, value in hashes.items()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--event-hints", action="store_true")
    args = parser.parse_args()
    database = Path(args.database)
    if not database.is_absolute() or not database.is_file():
        raise ValueError("CACHE_DATABASE_INVALID")
    def open_readonly():
        return sqlite3.connect(database.resolve().as_uri() + "?mode=ro",
                               uri=True, timeout=0.25)
    # Windows SQLite holds a file handle that prevents replacement for the
    # lifetime of a connection. Poll DB/WAL stat there, then open a short RO
    # snapshot only on changes. Unix can use the persistent data_version lane.
    connection = None if os.name == "nt" else open_readonly()
    file_identity = (os.stat(database).st_dev, os.stat(database).st_ino)
    previous_version = None
    previous = None
    hints = threading.Event()
    input_closed = threading.Event()
    if args.event_hints:
        def receive_hints():
            for line in sys.stdin:
                if line.strip() == "1":
                    hints.set()
            input_closed.set()
            hints.set()  # Do not leave an orphan after the supervisor exits.
        threading.Thread(target=receive_hints, daemon=True).start()
    while True:
        if input_closed.is_set():
            return
        started = time.monotonic()
        hinted = hints.is_set()
        hints.clear()  # Hints arriving during the snapshot remain for the next pass.
        # Also catches replacement/restart: fail closed, supervisor can reopen.
        current_file = os.stat(database)
        identity = (current_file.st_dev, current_file.st_ino)
        if connection and identity != file_identity:
            connection.close()
            connection = open_readonly()
            file_identity = identity
            previous_version = None
        if connection:
            version = connection.execute("PRAGMA data_version").fetchone()[0]
            marker = (version, current_file.st_ino, current_file.st_mtime_ns)
        else:
            def file_marker(file):
                try:
                    stat = os.stat(file)
                    return (stat.st_ino, stat.st_mtime_ns, stat.st_size)
                except FileNotFoundError:
                    return None
            marker = (file_marker(database), file_marker(str(database) + "-wal"))
        if not daytime():
            previous_version = None  # Reconcile latest content at 06:00.
        elif hinted or marker != previous_version:
            snapshot = connection or open_readonly()
            try:
                # Both tables are from the same committed snapshot. A filesystem
                # event can precede COMMIT; identical content emits nothing.
                snapshot.execute("BEGIN")
                current = fingerprints(snapshot)
            finally:
                snapshot.rollback()
                if snapshot is not connection:
                    snapshot.close()
            previous_version = marker
            if current != previous:
                print(json.dumps(current, separators=(",", ":")), flush=True)
                previous = current
        hints.wait(max(0.01, 1 - (time.monotonic() - started)))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # No paths, SQL values, connection strings or raw exceptions in logs.
        print("CACHE_MONITOR_UNAVAILABLE", file=__import__("sys").stderr)
        raise SystemExit(1)
