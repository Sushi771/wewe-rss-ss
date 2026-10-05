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


def source_identity(database):
    result = []
    for file in (database, Path(str(database) + "-wal")):
        try:
            stat = file.stat()
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


def prepare(database, migrations, backup_root, baseline_file):
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
