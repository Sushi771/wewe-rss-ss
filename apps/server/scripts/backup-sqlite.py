"""Create and verify a consistent SQLite backup before a collection write."""

import argparse
import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--backup-root", type=Path, required=True)
    args = parser.parse_args()

    database = args.database.resolve(strict=True)
    backup_root = args.backup_root.resolve()
    if not database.is_file():
        raise SystemExit("SQLite source is not a file")
    backup_root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = backup_root / f"before-collection-{stamp}-{uuid.uuid4().hex[:8]}"
    directory.mkdir(exist_ok=False)
    backup = directory / "wewe-rss.db"

    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=30) as source:
        source.execute("PRAGMA query_only=ON")
        with sqlite3.connect(backup, timeout=30) as destination:
            source.backup(destination, pages=1000, sleep=0.1)

    with sqlite3.connect(backup.as_uri() + "?mode=ro", uri=True) as verify:
        verify.execute("PRAGMA query_only=ON")
        integrity = [row[0] for row in verify.execute("PRAGMA integrity_check")]
        feeds = verify.execute("SELECT COUNT(*) FROM feeds").fetchone()[0]
        articles = verify.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
    if integrity != ["ok"]:
        raise SystemExit("Backup integrity check failed; collection must not write")

    report = {
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
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
