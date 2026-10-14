"""One process: pinned SQLite snapshot, consistency backup and full-field equality."""

import argparse
import hashlib
import importlib.util
import json
import sqlite3
import uuid
import struct
from itertools import zip_longest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location("inspect_sqlite", Path(__file__).with_name("inspect-sqlite.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

# Resolve in both a checkout and the standalone local-release bundle.
backup_script = Path(__file__).parent / 'server/scripts/backup-sqlite.py'
if not backup_script.exists():
    backup_script = Path(__file__).parents[2] / 'apps/server/scripts/backup-sqlite.py'
backup_spec = importlib.util.spec_from_file_location('backup_sqlite', backup_script)
backup_api = importlib.util.module_from_spec(backup_spec)
backup_spec.loader.exec_module(backup_api)


def source_identity(database):
    result = []
    for file in (database, Path(str(database) + "-wal")):
        try:
            stat = file.stat()
            if str(file).endswith('-wal') and stat.st_size == 0:
                result.append(None); continue
            result.append((stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
        except FileNotFoundError:
            result.append(None)
    return result


def same_value(left, right):
    if type(left) is not type(right):
        return False
    if isinstance(left, float):
        return struct.pack(">d", left) == struct.pack(">d", right)
    return left == right


def compare_tables(source, backup, migrations, baseline):
    # Compare every typed value directly in deterministic row order. Avoid a
    # second JSON serialization of large bodies, while retaining NULL, integer/
    # real, byte/string and even signed-zero distinctions and row multiplicity.
    verified = audit.inspect(backup, migrations, require_current=True, schema_only=True)
    with closing(sqlite3.connect(backup.as_uri() + "?mode=ro", uri=True)) as copied:
        copied.execute("PRAGMA query_only=ON")
        for table, protected in baseline["tables"].items():
            if verified["tables"][table]["columns"] != protected["columns"]:
                raise ValueError("Backup columns changed: " + table)
            selected = ",".join('"' + column.replace('"', '""') + '"' for column in protected["columns"])
            query = f'SELECT {selected} FROM "{table}" ORDER BY id'
            missing = object()
            rows = 0
            for original, duplicate in zip_longest(source.execute(query), copied.execute(query), fillvalue=missing):
                if original is missing or duplicate is missing or not all(same_value(left, right) for left, right in zip(original, duplicate)):
                    raise ValueError("Startup backup changed protected fields: " + table)
                rows += 1
            if rows != protected["rows"]:
                raise ValueError("Startup backup changed protected row count: " + table)


def verify_current_snapshot(database, backup):
    """A fresh independent read view catches commits hidden by Windows metadata."""
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as observer, closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as current, closing(sqlite3.connect(backup.as_uri() + '?mode=ro', uri=True)) as copied:
        version = observer.execute('PRAGMA data_version').fetchone()
        current.execute('PRAGMA query_only=ON'); current.execute('BEGIN')
        copied.execute('PRAGMA query_only=ON'); copied.execute('BEGIN')
        if not backup_api.snapshot_equal(current, copied) or observer.execute('PRAGMA data_version').fetchone() != version:
            raise ValueError('SQLite source changed during startup backup; retry from a new snapshot')


def prepare(database, migrations, backup_root, baseline_file):
    database = database.resolve(strict=True)
    backup_root = backup_root.resolve()
    previous = backup_api.reusable(database, backup_root)
    if previous is not None:
        identity = source_identity(database)
        before = audit.inspect(database, migrations, require_current=True)
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as source:
            source.execute('PRAGMA query_only=ON;')
            source.execute('BEGIN')
            compare_tables(source, Path(previous['backup']), migrations, before)
        verify_current_snapshot(database, Path(previous['backup']))
        if identity != source_identity(database):
            raise ValueError('SQLite source changed during startup reuse')
        with baseline_file.open('x', encoding='utf-8') as stream:
            json.dump(before, stream, ensure_ascii=False)
        return {'backup': previous, 'inspection': before}
    backup_api.space_preflight(database, backup_root)
    backup_root.mkdir(parents=True, exist_ok=True)
    lease = Path(backup_api.space_preflight(database, backup_root)['root']) / '.space-budget.lock'
    with lease.open('x', encoding='utf-8') as stream:
        stream.write(str(__import__('os').getpid()))
    try:
        backup_api.space_preflight(database, backup_root)
        identity = backup_api.source_identity(database)
        result = fresh_prepare(database, migrations, backup_root, baseline_file)
        if identity != backup_api.source_identity(database):
            raise ValueError('SQLite source changed before backup receipt')
        result['backup']['sourceIdentity'] = identity
        receipt = backup_root / ('.latest-' + hashlib.sha256(str(database).encode()).hexdigest()[:24] + '.json')
        receipt.write_text(json.dumps(result['backup']), encoding='utf-8')
        return result
    finally:
        lease.unlink()


def fresh_prepare(database, migrations, backup_root, baseline_file):
    database = database.resolve(strict=True)
    identity = source_identity(database)
    directory = backup_root.resolve() / ("before-start-" + uuid.uuid4().hex)
    directory.mkdir(parents=True, exist_ok=False)
    backup = directory / "wewe-rss.db"
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=10)) as source:
        source.execute("PRAGMA query_only=ON")
        source.execute("BEGIN")
        before = audit.inspect_connection(source, database, migrations, require_current=True)
        with closing(sqlite3.connect(backup)) as destination:
            # Uses the very same pinned read snapshot as the full baseline.
            source.backup(destination, pages=1000, sleep=0.1)
        compare_tables(source, backup, migrations, before)
    verify_current_snapshot(database, backup)
    if source_identity(database) != identity:
        raise ValueError("SQLite source changed during startup backup; retry from a new snapshot")
    digest = hashlib.sha256()
    with backup.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    result = {
        "createdAtUtc": datetime.now(timezone.utc).isoformat(),
        "source": str(database),
        "backup": str(backup),
        "integrityCheck": "ok",
        "sha256": digest.hexdigest(),
        "feeds": before["tables"]["feeds"]["rows"],
        "articles": before["tables"]["articles"]["rows"],
    }
    with baseline_file.open("x", encoding="utf-8") as stream:
        json.dump(before, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    with (directory / "verification.json").open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return {"backup": result, "inspection": before}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--migrations", type=Path, required=True)
    parser.add_argument("--backup-root", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.database, args.migrations, args.backup_root, args.baseline), ensure_ascii=False))


if __name__ == "__main__":
    main()
