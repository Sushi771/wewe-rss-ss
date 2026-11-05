"""SQLite update snapshots. The updater must stop writers before restoring.

Uses SQLite's backup API, including committed WAL pages; never copies WAL files.
Only a fixed local application's data root is accepted by the installed adapter.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time


def checked(root, value):
    root = Path(root).resolve(strict=True)
    raw = Path(value).absolute()
    if not raw.is_relative_to(root):
        raise ValueError("PATH_OUTSIDE_DATA_ROOT")
    at = raw
    while at != root:
        if at.is_symlink() or (hasattr(at, "is_junction") and at.is_junction()):
            raise ValueError("LINKED_DATABASE_PATH")
        at = at.parent
    if not raw.resolve().is_relative_to(root):
        raise ValueError("PATH_OUTSIDE_DATA_ROOT")
    return raw


def readonly(file):
    return sqlite3.connect(file.as_uri() + "?mode=ro", uri=True, timeout=10)


def check(db):
    if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
        raise ValueError("SQLITE_CHECK_FAILED")
    if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise ValueError("SQLITE_FOREIGN_KEY_CHECK_FAILED")


def snapshot(root, source, target, restore=False):
    source, target = checked(root, source), checked(root, target)
    if source == target or not source.is_file():
        raise ValueError("INVALID_SNAPSHOT_PATH")
    if not restore and target.exists():
        raise ValueError("SNAPSHOT_ALREADY_EXISTS")
    target.parent.mkdir(parents=True, exist_ok=True)
    if not restore:
        # Reserve the name; a snapshot is never an overwrite operation.
        with target.open("xb"):
            pass
    deadline = time.monotonic() + 60
    def progress(status, remaining, total):
        if time.monotonic() > deadline:
            raise TimeoutError("SQLITE_BACKUP_TIMEOUT")
    with closing(readonly(source)) as src:
        check(src)
        with closing(sqlite3.connect(target, timeout=10)) as dst:
            src.backup(dst, pages=256, progress=progress, sleep=0.05)
            check(dst)
            dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    # A completed snapshot has no live connection. Hash is a recovery receipt.
    with target.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"format": 1, "operation": "restore" if restore else "backup",
            "sha256": digest, "bytes": target.stat().st_size}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("operation", choices=("backup", "restore", "check"))
    p.add_argument("--root", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--target")
    p.add_argument("--expected-sha256")
    args = p.parse_args()
    source = checked(args.root, args.source)
    if args.expected_sha256:
        with source.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != args.expected_sha256:
            raise ValueError("SNAPSHOT_HASH_MISMATCH")
    if args.operation == "check":
        with closing(readonly(source)) as db:
            check(db)
        result = {"format": 1, "passed": True}
    else:
        if not args.target:
            p.error("--target required")
        result = snapshot(args.root, source, args.target, args.operation == "restore")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
