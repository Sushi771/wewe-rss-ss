"""只读核验 SQLite schema/迁移记录，以及 feeds/articles 的逐字段字节等价。"""

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from contextlib import closing

NEW_COLUMNS = {
    "feeds": ["collection_channel"],
    "articles": ["last_body_status", "verified_source_url", "last_body_retry"],
}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def inspect(database, migrations, baseline=None, require_current=False):
    database = database.resolve(strict=True)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=10)) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("SQLite integrity_check 未通过")
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("SQLite foreign_key_check 未通过")
        expected = {}
        for directory in sorted(migrations.iterdir()):
            if not directory.is_dir():
                continue
            content = (directory / "migration.sql").read_bytes()
            # Prisma 接受 Git 在 Windows checkout 中转换换行；内容改变仍拒绝。
            lf = content.replace(b"\r\n", b"\n")
            expected[directory.name] = {hashlib.sha256(data).hexdigest() for data in (content, lf, lf.replace(b"\n", b"\r\n"))}
        applied = set()
        for name, checksum, finished, rolled_back in connection.execute(
            "SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations"
        ):
            if rolled_back is not None:
                continue
            if finished is None or name not in expected or checksum not in expected[name] or name in applied:
                raise ValueError("迁移记录未完成、未知、重复或校验和不符: " + name)
            applied.add(name)
        pending = sorted(set(expected) - applied)
        if require_current and pending:
            raise ValueError("数据库尚未迁移: " + ", ".join(pending))
        tables = {}
        for table in ("feeds", "articles"):
            columns = [row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')]
            protected = baseline["tables"][table]["columns"] if baseline else columns
            if not set(protected).issubset(columns):
                raise ValueError("已有列缺失: " + table)
            # 列名只允许来自 PRAGMA 或已确认存在的基线，不执行基线内任意 SQL。
            selected = ",".join('"' + column.replace('"', '""') + '"' for column in protected)
            rows = connection.execute(f'SELECT {selected} FROM "{table}" ORDER BY id').fetchall()
            tables[table] = {"columns": protected, "rows": len(rows), "sha256": digest(rows)}
            if baseline and tables[table] != baseline["tables"][table]:
                raise ValueError("迁移改变了已有字段: " + table)
            for column in NEW_COLUMNS[table]:
                if require_current and column not in columns:
                    raise ValueError("缺少新列: " + column)
                if baseline and column not in protected and column in columns:
                    count = connection.execute(f'SELECT COUNT(*) FROM "{table}" WHERE "{column}" IS NOT NULL').fetchone()[0]
                    if count:
                        raise ValueError("迁移给旧行填入了非 null 值: " + column)
        return {"database": str(database), "integrity": "ok", "pending": pending, "applied": sorted(applied), "tables": tables}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--migrations", type=Path, required=True)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--require-current", action="store_true")
    args = parser.parse_args()
    baseline = json.loads(args.baseline.read_text(encoding="utf-8")) if args.baseline else None
    result = inspect(args.database, args.migrations, baseline, args.require_current)
    if args.output:
        with args.output.open("x", encoding="utf-8") as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
