"""Create and verify a consistent SQLite backup before a collection write."""

import argparse
import hashlib
import json
import os
import sqlite3
import time
import uuid
import shutil
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


def source_identity(database):
    result = []
    for file in (database, Path(str(database) + '-wal')):
        try:
            stat = file.stat()
            result.append([str(value) for value in (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)])
        except FileNotFoundError:
            result.append(None)
    return result


def source_hashes(database):
    return [sha256(file) if file.exists() else None for file in (database, Path(str(database) + '-wal'))]


def positive(name, fallback):
    value = int(os.environ.get(name, fallback))
    if value <= 0:
        raise ValueError('Invalid ' + name)
    return value


def space_preflight(database, backup_root):
    """Count all existing files, including failed copies; never prune them."""
    database, backup_root = Path(database).resolve(), Path(backup_root).resolve()
    if database.is_relative_to(backup_root):
        raise ValueError('Nested source/destination refused')
    test = os.environ.get('SQLITE_BACKUP_KIND') == 'test'
    root = Path(os.environ.get('SQLITE_TEST_BUDGET_ROOT', backup_root)).resolve() if test else backup_root
    if not backup_root.is_relative_to(root):
        raise ValueError('Backup destination escapes test budget root')
    prefix = 'SQLITE_TEST' if test else 'SQLITE_PRODUCTION'
    max_bytes = positive(prefix + '_MAX_BYTES', (512 * 1024**2) if test else (64 * 1024**3))
    max_copies = positive(prefix + '_MAX_COPIES', 12 if test else 32)
    min_free = positive(prefix + '_MIN_FREE_BYTES', (256 * 1024**2) if test else (2 * 1024**3))
    files = []
    if root.exists():
        for file in root.rglob('*'):
            if file.is_symlink() or (hasattr(file, 'is_junction') and file.is_junction()):
                raise ValueError('Space budget refuses links: ' + str(file))
            if file.is_file():
                files.append(file)
    used = sum(file.stat().st_size for file in files)
    copies = sum(file.suffix.lower() in ('.db', '.sqlite', '.sqlite3') for file in files)
    expected = 2 * sum(file.stat().st_size for file in (database, Path(str(database) + '-wal')) if file.exists()) + 1024**2
    parent = root
    while not parent.exists():
        parent = parent.parent
    free = shutil.disk_usage(parent).free
    if used + expected > max_bytes or copies + 1 > max_copies or free - expected < min_free:
        raise ValueError(f'Space budget exceeded: root={root}, existingBytes={used}, existingCopies={copies}, requestedBytes={expected}, freeBytes={free}. Review recovery points manually; nothing was deleted.')
    return {'root': str(root), 'existingBytes': used, 'existingCopies': copies, 'requestedBytes': expected, 'freeBytes': free}


def reusable(database, backup_root):
    identity = source_identity(database)
    receipt = backup_root / ('.latest-' + hashlib.sha256(str(database).encode()).hexdigest()[:24] + '.json')
    try:
        report = json.loads(receipt.read_text(encoding='utf-8'))
        backup = Path(report['backup']).resolve(strict=True)
        if report['source'] != str(database) or not backup.is_relative_to(backup_root):
            return None
        if report.get('sourceIdentity') != identity:
            if not report.get('sourceFilesSha256') or source_hashes(database) != report['sourceFilesSha256']:
                return None
        if sha256(backup) != report['sha256'] or source_identity(database) != identity:
            return None
        with closing(sqlite3.connect(backup.as_uri() + '?mode=ro', uri=True)) as connection:
            if list(connection.execute('PRAGMA integrity_check')) != [('ok',)]:
                return None
        # Recovery freshness remains the original snapshot start, never this reuse time.
        return {**report, 'reused': True}
    except (OSError, ValueError, KeyError, sqlite3.Error):
        return None


def create_backup(database, backup_root, prefix="before-collection", timeout=55):
    database = Path(database).resolve(strict=True)
    lock_name = hashlib.sha256(str(database).encode()).hexdigest()[:24]
    deadline = time.monotonic() + timeout
    # Periodic and original write-before backups share this operation lock.
    # Lock contention is bounded and failure never permits an unprotected write.
    with FileLock(database.parent / f".full-snapshot-{lock_name}.lock",
                  timeout=max(0, min(30, timeout))) as lock:
        backup_root = Path(backup_root).resolve()
        # The periodic guard establishes a new trust generation on restart.
        # Its existing version-based unchanged-data logic owns that decision.
        report = None if prefix == 'periodic-snapshot' else reusable(database, backup_root)
        if report is None:
            space_preflight(database, backup_root)
            backup_root.mkdir(parents=True, exist_ok=True)
            # Shared with native startup preparation. A crash leaves an explicit
            # blocked lease for operator review, not an unbounded next copy.
            lease = backup_root / '.space-budget.lock'
            with lease.open('x', encoding='utf-8') as stream:
                json.dump({'pid': os.getpid(), 'startedAt': datetime.now(timezone.utc).isoformat()}, stream)
            try:
                space_preflight(database, backup_root)
                report = _create_backup(database, backup_root, prefix,
                                        deadline - time.monotonic())
            except BaseException as error:
                (backup_root / 'last-failure.json').write_text(json.dumps({'failure': type(error).__name__, 'message': str(error), 'existingFilesRetained': True}), encoding='utf-8')
                raise
            finally:
                lease.unlink()
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
    identity = source_identity(database)
    content = source_hashes(database)
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
        "sourceIdentity": identity if source_identity(database) == identity else None,
        "sourceFilesSha256": content if source_identity(database) == identity else None,
        "reused": False,
    }
    (directory / "verification.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    receipt = backup_root / ('.latest-' + hashlib.sha256(str(database).encode()).hexdigest()[:24] + '.json')
    temporary = receipt.with_suffix('.tmp')
    temporary.write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
    temporary.replace(receipt)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--backup-root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(create_backup(args.database, args.backup_root), ensure_ascii=False))


if __name__ == "__main__":
    main()
