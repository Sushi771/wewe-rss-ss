"""Create and verify a consistent SQLite backup before a collection write."""

import argparse
import hashlib
import json
import os
import sqlite3
import time
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


class FileLock:
    """One local OS file lock; closes on crash without deleting its pathname."""

    def __init__(self, path, timeout=0):
        self.path = Path(path)
        self.stream = self.path.open("a+b")
        deadline = time.monotonic() + timeout
        try:
            if os.name == "nt" and self.path.stat().st_size == 0:
                self.stream.write(b"0")
                self.stream.flush()
            while True:
                try:
                    if os.name == "nt":
                        import msvcrt
                        self.stream.seek(0)
                        msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("SQLite backup lock unavailable")
                    time.sleep(min(0.05, max(0, deadline - time.monotonic())))
            stat = self.path.stat()
            if not stat.st_ino:
                raise ValueError("unprovable-file-identity")
            self.identity = [str(stat.st_dev), str(stat.st_ino)]
        except BaseException:
            self.stream.close()
            raise

    def check(self):
        stat = self.path.stat()
        if self.stream.closed or [str(stat.st_dev), str(stat.st_ino)] != self.identity:
            raise ValueError("owner-lock-replaced")

    def close(self):
        self.stream.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def create_backup(database, backup_root, prefix="before-collection", timeout=55):
    database = Path(database).resolve(strict=True)
    lock_name = hashlib.sha256(str(database).encode()).hexdigest()[:24]
    deadline = time.monotonic() + timeout
    # Periodic and original write-before backups share this operation lock.
    # Lock contention is bounded and failure never permits an unprotected write.
    with FileLock(database.parent / f".full-snapshot-{lock_name}.lock",
                  timeout=max(0, min(30, timeout))) as lock:
        report = _create_backup(database, backup_root, prefix,
                                deadline - time.monotonic())
        lock.check()
        return report


def _create_backup(database, backup_root, prefix, timeout):
    """Same online API and verification for periodic and write-before backups.

    The start is the conservative recovery bound, NOT verification completion:
    a concurrently-written online backup may represent an earlier point in time.
    """
    started = datetime.now(timezone.utc).isoformat()
    deadline = time.monotonic() + timeout
    database = Path(database).resolve(strict=True)
    backup_root = Path(backup_root).resolve()
    if not database.is_file():
        raise SystemExit("SQLite source is not a file")
    backup_root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = backup_root / f"{prefix}-{stamp}-{uuid.uuid4().hex[:8]}"
    directory.mkdir(exist_ok=False)
    backup = directory / "wewe-rss.db"

    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=30)) as source:
        source.execute("PRAGMA query_only=ON")
        with closing(sqlite3.connect(backup, timeout=30)) as destination:
            def progress(_status, _remaining, _total):
                if time.monotonic() > deadline:
                    raise TimeoutError("SQLite backup timed out")

            source.backup(destination, pages=1000, sleep=0.1, progress=progress)

    with closing(sqlite3.connect(backup.as_uri() + "?mode=ro", uri=True)) as verify:
        verify.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        verify.execute("PRAGMA query_only=ON")
        integrity = [row[0] for row in verify.execute("PRAGMA integrity_check")]
        feeds = verify.execute("SELECT COUNT(*) FROM feeds").fetchone()[0]
        articles = verify.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
    if integrity != ["ok"]:
        raise SystemExit("Backup integrity check failed; collection must not write")
    if time.monotonic() > deadline:
        raise TimeoutError("SQLite backup verification timed out")

    report = {
        "startedAtUtc": started,
        "createdAtUtc": datetime.now(timezone.utc).isoformat(),
        "source": str(database),
        "backup": str(backup),
        "integrityCheck": "ok",
        "sha256": sha256(backup),
        "feeds": feeds,
        "articles": articles,
    }
    (directory / "verification.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--backup-root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(create_backup(args.database, args.backup_root), ensure_ascii=False))


if __name__ == "__main__":
    main()
