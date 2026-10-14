"""Create and verify a consistent SQLite backup before a collection write."""

import argparse
import hashlib
import json
import os
import math
import sqlite3
import sys
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


def sha256(path, deadline=None):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            if deadline is not None and time.monotonic() > deadline:
                raise TimeoutError("SQLite backup hash timed out")
            digest.update(chunk)
    return digest.hexdigest()


class BackupDiagnostics:
    """Bounded stage telemetry: never contains paths, SQL, or source content."""

    def __init__(self):
        self.started = self.changed = time.monotonic()
        self.stage = "lock"
        self.timings = {}
        self.copy_steps = self.busy_steps = 0
        self.journal = "unknown"

    def enter(self, stage):
        now = time.monotonic()
        self.timings[self.stage] = round((now - self.changed) * 1000)
        self.stage, self.changed = stage, now

    def report(self):
        timings = dict(self.timings)
        timings[self.stage] = round((time.monotonic() - self.changed) * 1000)
        return {"stage": self.stage, "milliseconds": timings,
                "copySteps": self.copy_steps, "busySteps": self.busy_steps,
                "journalMode": self.journal}


def create_backup(database, backup_root, prefix="before-collection", timeout=55,
                  diagnostics=None, copy_timeout=None):
    database = Path(database).resolve(strict=True)
    lock_name = hashlib.sha256(str(database).encode()).hexdigest()[:24]
    deadline = time.monotonic() + timeout
    diagnostics = diagnostics or BackupDiagnostics()
    if copy_timeout is None:
        copy_timeout = float(os.environ.get("SQLITE_BACKUP_COPY_TIMEOUT_SECONDS", "15"))
        if not 1 <= copy_timeout <= 15:
            raise ValueError("SQLite backup copy budget invalid")
    if not math.isfinite(copy_timeout) or not 0 < copy_timeout <= 15:
        raise ValueError("SQLite backup copy budget invalid")
    # Periodic and original write-before backups share this operation lock.
    # Lock contention is bounded and failure never permits an unprotected write.
    with FileLock(database.parent / f".full-snapshot-{lock_name}.lock",
                  timeout=max(0, min(30, timeout))) as lock:
        report = _create_backup(database, backup_root, prefix,
                                deadline - time.monotonic(), diagnostics,
                                copy_timeout)
        lock.check()
        return report


def _create_backup(database, backup_root, prefix, timeout, diagnostics=None,
                   copy_timeout=15):
    """Same online API and verification for periodic and write-before backups.

    The start is the conservative recovery bound, NOT verification completion:
    a concurrently-written online backup may represent an earlier point in time.
    """
    started = datetime.now(timezone.utc).isoformat()
    deadline = time.monotonic() + timeout
    diagnostics = diagnostics or BackupDiagnostics()
    if timeout <= 0 or copy_timeout <= 0:
        raise TimeoutError("SQLite backup deadline exhausted")
    database = Path(database).resolve(strict=True)
    backup_root = Path(backup_root).resolve()
    if not database.is_file():
        raise SystemExit("SQLite source is not a file")
    backup_root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = backup_root / f"{prefix}-{stamp}-{uuid.uuid4().hex[:8]}"
    directory.mkdir(exist_ok=False)
    backup = directory / "wewe-rss.db"

    # A pinned read snapshot prevents the online API from restarting on every
    # external commit. In rollback-journal mode its SHARED lock delays commits;
    # cap acquisition + copy at fifteen seconds and release BEFORE verification/hash.
    # No journal-mode change, writer connection, or write transaction is used.
    diagnostics.enter("snapshot")
    copy_deadline = min(deadline, time.monotonic() + copy_timeout)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True,
                                 timeout=min(0.1, max(0.001, copy_deadline - time.monotonic())))) as source:
        source.execute("PRAGMA query_only=ON")
        source.set_progress_handler(lambda: int(time.monotonic() > copy_deadline), 1000)
        diagnostics.journal = source.execute("PRAGMA journal_mode").fetchone()[0]
        if prefix != "periodic-snapshot":
            source.execute("BEGIN")
            # App admission happens before a connection/transaction opens.
            # Autonomous periodic copying must stay online, without a long read
            # lock that could conflict with short app transaction deadlines.
            source.execute("SELECT rootpage FROM sqlite_master LIMIT 1").fetchone()
        diagnostics.enter("copy")
        with closing(sqlite3.connect(backup, timeout=0.1)) as destination:
            def progress(status, _remaining, _total):
                diagnostics.copy_steps += 1
                diagnostics.busy_steps += int(status in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED))
                if time.monotonic() > copy_deadline:
                    raise TimeoutError("SQLite backup timed out")

            source.backup(destination, pages=1000, sleep=0.01, progress=progress)

    diagnostics.enter("verify")
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

    diagnostics.enter("hash")
    checksum = sha256(backup, deadline)
    if time.monotonic() > deadline:
        raise TimeoutError("SQLite backup hash timed out")
    diagnostics.enter("complete")
    report = {
        "startedAtUtc": started,
        "createdAtUtc": datetime.now(timezone.utc).isoformat(),
        "source": str(database),
        "backup": str(backup),
        "integrityCheck": "ok",
        "sha256": checksum,
        "feeds": feeds,
        "articles": articles,
        "diagnostics": diagnostics.report(),
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
    diagnostics = BackupDiagnostics()
    try:
        print(json.dumps(create_backup(args.database, args.backup_root,
                                       diagnostics=diagnostics), ensure_ascii=False))
    except Exception as error:
        # Raw exceptions/tracebacks can contain private paths or SQL. The caller
        # needs the failed stage, not those details. One bounded JSON record.
        print(json.dumps({"event": "sqlite-backup-failed",
                          "reason": "timeout" if isinstance(error, TimeoutError) else "failed",
                          "diagnostics": diagnostics.report()}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
