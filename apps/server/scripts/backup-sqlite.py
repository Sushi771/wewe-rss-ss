"""Create and verify a consistent SQLite backup before a collection write."""

import argparse
import hashlib
import json
import os
import sqlite3
import time
import uuid
import shutil
import struct
from itertools import zip_longest
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
            if str(file).endswith('-wal') and stat.st_size == 0:
                result.append(None); continue
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


def legacy_roots():
    if os.environ.get('SQLITE_BACKUP_KIND') == 'test':
        return []
    roots = json.loads(os.environ.get('SQLITE_PRODUCTION_LEGACY_ROOTS', '[]'))
    if not isinstance(roots, list) or any(not isinstance(value,str) or not Path(value).is_absolute() for value in roots):
        raise ValueError('Invalid SQLITE_PRODUCTION_LEGACY_ROOTS')
    return [Path(value).resolve(strict=True) for value in roots]


def managed_files(root):
    """Only explicitly listed historic roots may be traversed through links.

    Canonical paths are visited once; legacy targets are counted but never used
    as generation destinations. Unlisted links and cycles fail closed.
    """
    allowed = legacy_roots()
    seen_directories, seen_files, result = set(), set(), []
    def visit(directory):
        canonical = directory.resolve(strict=True)
        if canonical in seen_directories:
            raise ValueError('Nested or repeated backup directory refused')
        seen_directories.add(canonical)
        for file in directory.iterdir():
            linked = file.is_symlink() or (hasattr(file,'is_junction') and file.is_junction())
            if linked:
                target = file.resolve(strict=True)
                if not file.is_dir() or not any(target.is_relative_to(folder) for folder in allowed):
                    raise ValueError('SQLITE_BACKUP_LAYOUT_REQUIRES_REVIEW: unlisted link '+str(file))
            if file.is_dir():
                visit(file)
            elif file.is_file():
                canonical_file = file.resolve(strict=True)
                if canonical_file not in seen_files:
                    seen_files.add(canonical_file); result.append(canonical_file)
    if root.exists(): visit(root)
    return result


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
    max_bytes = positive(prefix + '_MAX_BYTES', (512 * 1024**2) if test else (32 * 1024**3))
    max_copies = positive(prefix + '_MAX_COPIES', 12 if test else 48)
    min_free = positive(prefix + '_MIN_FREE_BYTES', (256 * 1024**2) if test else (4 * 1024**3))
    files = managed_files(root)
    used = sum(file.stat().st_size for file in files)
    copies = sum(file.suffix.lower() in ('.db', '.sqlite', '.sqlite3') for file in files)
    expected = 2 * sum(file.stat().st_size for file in (database, Path(str(database) + '-wal')) if file.exists()) + 1024**2
    parent = root
    while not parent.exists():
        parent = parent.parent
    free = shutil.disk_usage(parent).free
    allowed = used+expected <= max_bytes and copies+1 <= max_copies and free-expected >= min_free
    if not test and root.exists():
        actual = max(database.stat().st_size,1)
        more = max(0,min(max_copies-copies,(max_bytes-used-expected)//actual+1,(free-min_free-expected)//actual+1))
        status = {'nextBackupAllowed':allowed,'warning':not allowed or used/max_bytes>=.5 or copies/max_copies>=.5 or more/96<1,'estimatedDaysAtContinuousChanges':round(more/96,2),'recordedAt':datetime.now(timezone.utc).isoformat()}
        temporary=root/('.space-budget-status-'+uuid.uuid4().hex+'.tmp')
        temporary.write_text(json.dumps(status),encoding='utf-8'); temporary.replace(root/'.space-budget-status.json')
    if used + expected > max_bytes or copies + 1 > max_copies or free - expected < min_free:
        raise ValueError(f'SQLITE_SPACE_BUDGET_EXCEEDED: root={root}, existingBytes={used}, existingCopies={copies}, requestedBytes={expected}, freeBytes={free}. Review recovery points manually; nothing was deleted.')
    return {'root': str(root), 'existingBytes': used, 'existingCopies': copies, 'requestedBytes': expected, 'freeBytes': free}


def snapshot_equal(source, copied):
    """Compare every schema object and typed row in two pinned read snapshots.

    Filesystem timestamps are NEVER evidence that committed DB/WAL content is
    unchanged. A WAL commit is included through SQLite's consistent read view.
    """
    query = "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
    if list(source.execute(query)) != list(copied.execute(query)):
        return False
    quote = lambda value: '"' + value.replace('"', '""') + '"'
    missing = object()
    for (table,) in source.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        info = list(source.execute(f'PRAGMA table_info({quote(table)})'))
        primary = [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]]
        columns = ','.join(quote(row[1]) for row in info)
        sql = f'SELECT {columns} FROM {quote(table)} ORDER BY ' + (','.join(map(quote, primary)) if primary else 'rowid')
        for left, right in zip_longest(source.execute(sql), copied.execute(sql), fillvalue=missing):
            if left is missing or right is missing or len(left) != len(right):
                return False
            for a, b in zip(left, right):
                if type(a) is not type(b):
                    return False
                if isinstance(a, float):
                    if struct.pack('>d', a) != struct.pack('>d', b):
                        return False
                elif a != b:
                    return False
    return True


def reusable(database, backup_root):
    receipt = backup_root / ('.latest-' + hashlib.sha256(str(database).encode()).hexdigest()[:24] + '.json')
    try:
        report = json.loads(receipt.read_text(encoding='utf-8'))
        backup = Path(report['backup']).resolve(strict=True)
        if report['source'] != str(database) or not backup.is_relative_to(backup_root) or sha256(backup) != report['sha256']:
            return None
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(backup.as_uri() + '?mode=ro', uri=True)) as copied:
            source.execute('PRAGMA query_only=ON'); source.execute('BEGIN')
            copied.execute('PRAGMA query_only=ON'); copied.execute('BEGIN')
            if list(copied.execute('PRAGMA integrity_check')) != [('ok',)] or not snapshot_equal(source, copied):
                return None
        if sha256(backup) != report['sha256']:
            return None
        return {**report, 'reused': True, 'reuseProof': 'all-schema-and-typed-rows-pinned-snapshot-v1'}
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
            lease = Path(space_preflight(database, backup_root)['root']) / '.space-budget.lock'
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
