import hashlib
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path
from contextlib import closing

spec = importlib.util.spec_from_file_location("inspect_sqlite", Path(__file__).with_name("inspect-sqlite.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class InspectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wewe-release-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.database = self.root / "fixture.db"
        self.migrations = self.root / "migrations"
        self.initial = 'CREATE TABLE feeds(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE articles(id TEXT PRIMARY KEY,body TEXT,metric INT);'
        self.additive = 'ALTER TABLE feeds ADD COLUMN collection_channel TEXT; ALTER TABLE articles ADD COLUMN last_body_status TEXT; ALTER TABLE articles ADD COLUMN verified_source_url TEXT; ALTER TABLE articles ADD COLUMN last_body_retry TEXT;'
        for name, sql in (("001", self.initial), ("002", self.additive)):
            folder = self.migrations / name
            folder.mkdir(parents=True)
            (folder / "migration.sql").write_text(sql, encoding="utf-8")
        with closing(sqlite3.connect(self.database)) as conn, conn:
            conn.executescript(self.initial)
            conn.execute("CREATE TABLE _prisma_migrations(migration_name TEXT,checksum TEXT,finished_at INT,rolled_back_at INT)")
            conn.execute("INSERT INTO _prisma_migrations VALUES(?,?,1,NULL)", ("001", hashlib.sha256(self.initial.encode()).hexdigest()))
            conn.execute("INSERT INTO feeds VALUES('f','旧名')")
            conn.execute("INSERT INTO articles VALUES('a','旧正文',NULL)")
            conn.execute("INSERT INTO articles VALUES('b','',0)")

    def migrate(self):
        with closing(sqlite3.connect(self.database)) as conn, conn:
            conn.executescript(self.additive)
            conn.execute("INSERT INTO _prisma_migrations VALUES(?,?,1,NULL)", ("002", hashlib.sha256(self.additive.encode()).hexdigest()))

    def test_additive_and_null_preservation(self):
        before = audit.inspect(self.database, self.migrations)
        self.assertEqual(before["pending"], ["002"])
        self.migrate()
        after = audit.inspect(self.database, self.migrations, before, True)
        self.assertEqual(before["tables"], after["tables"])

    def test_old_schema_rejected(self):
        with self.assertRaisesRegex(ValueError, "尚未迁移"):
            audit.inspect(self.database, self.migrations, require_current=True)

    def test_old_body_and_null_metric_change_rejected(self):
        before = audit.inspect(self.database, self.migrations)
        self.migrate()
        with closing(sqlite3.connect(self.database)) as conn, conn:
            conn.execute("UPDATE articles SET metric=0 WHERE id='a'")
        with self.assertRaisesRegex(ValueError, "已有字段"):
            audit.inspect(self.database, self.migrations, before, True)

    def test_new_column_backfill_rejected(self):
        before = audit.inspect(self.database, self.migrations)
        self.migrate()
        with closing(sqlite3.connect(self.database)) as conn, conn:
            conn.execute("UPDATE feeds SET collection_channel='desktop-wechat'")
        with self.assertRaisesRegex(ValueError, "非 null"):
            audit.inspect(self.database, self.migrations, before, True)

    def test_history_drift_and_failed_migration_rejected(self):
        with closing(sqlite3.connect(self.database)) as conn, conn:
            conn.execute("UPDATE _prisma_migrations SET finished_at=NULL")
        with self.assertRaisesRegex(ValueError, "迁移记录"):
            audit.inspect(self.database, self.migrations)
        with closing(sqlite3.connect(self.database)) as conn, conn:
            conn.execute("UPDATE _prisma_migrations SET finished_at=1,checksum='changed'")
        with self.assertRaisesRegex(ValueError, "校验和"):
            audit.inspect(self.database, self.migrations)

    def test_missing_database_never_created(self):
        missing = self.root / "missing.db"
        with self.assertRaises(FileNotFoundError):
            audit.inspect(missing, self.migrations)
        self.assertFalse(missing.exists())

    def test_schema_only_keeps_integrity_and_migration_checks(self):
        with self.assertRaises(ValueError):
            audit.inspect(self.database, self.migrations, require_current=True, schema_only=True)
        self.migrate()
        full = audit.inspect(self.database, self.migrations, require_current=True)
        quick = audit.inspect(self.database, self.migrations, require_current=True, schema_only=True)
        self.assertEqual(quick["pending"], [])
        self.assertEqual(quick["tables"]["articles"], {"columns": full["tables"]["articles"]["columns"]})
        with self.assertRaises(ValueError):
            audit.inspect(self.database, self.migrations, full, True, True)
        with closing(sqlite3.connect(self.database)) as conn, conn:
            conn.execute("UPDATE _prisma_migrations SET checksum='changed'")
        with self.assertRaises(ValueError):
            audit.inspect(self.database, self.migrations, require_current=True, schema_only=True)

    def test_schema_only_rejects_missing_current_columns(self):
        self.migrate()
        with closing(sqlite3.connect(self.database)) as conn, conn:
            conn.execute("ALTER TABLE articles DROP COLUMN last_body_retry")
        with self.assertRaises(ValueError):
            audit.inspect(self.database, self.migrations, require_current=True, schema_only=True)


if __name__ == "__main__":
    unittest.main()
