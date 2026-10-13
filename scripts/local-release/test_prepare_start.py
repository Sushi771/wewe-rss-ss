import importlib.util
import json
import sqlite3
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
import test_inspect_sqlite as fixtures

spec = importlib.util.spec_from_file_location("prepare_start", Path(__file__).with_name("prepare-start.py"))
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)


class PrepareTests(unittest.TestCase):
    setUp = fixtures.InspectTests.setUp
    migrate = fixtures.InspectTests.migrate

    def prepare(self):
        return startup.prepare(self.database, self.migrations, self.root / "backups", self.root / "baseline.json")

    def test_pinned_backup_preserves_every_field_and_is_read_only(self):
        self.migrate()
        before = self.database.read_bytes()
        result = self.prepare()
        backup = Path(result["backup"]["backup"])
        inspected = startup.audit.inspect(backup, self.migrations, result["inspection"], True)
        self.assertEqual(inspected["tables"], result["inspection"]["tables"])
        self.assertEqual(json.loads((self.root / "baseline.json").read_text(encoding="utf-8")), result["inspection"])
        self.assertEqual(self.database.read_bytes(), before)

    def test_pending_schema_cannot_prepare_or_write_baseline(self):
        with self.assertRaisesRegex(ValueError, "未迁移"):
            self.prepare()
        self.assertFalse((self.root / "baseline.json").exists())

    def test_changed_backup_fails_full_field_equivalence(self):
        self.migrate()
        original = startup.audit.inspect
        def altered(database, *args, **kwargs):
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("UPDATE articles SET body='changed' WHERE id='a'")
            return original(database, *args, **kwargs)
        with patch.object(startup.audit, "inspect", altered):
            with self.assertRaisesRegex(ValueError, "articles"):
                self.prepare()
        self.assertFalse((self.root / "baseline.json").exists())

    def test_concurrent_wal_writer_fails_closed(self):
        self.migrate()
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
        original = startup.audit.inspect_connection
        def concurrent(connection, database, *args, **kwargs):
            result = original(connection, database, *args, **kwargs)
            if database == self.database:
                with closing(sqlite3.connect(self.database)) as writer, writer:
                    writer.execute("UPDATE articles SET body='concurrent' WHERE id='a'")
            return result
        with patch.object(startup.audit, "inspect_connection", concurrent):
            with self.assertRaisesRegex(ValueError, "source changed"):
                self.prepare()
        self.assertFalse((self.root / "baseline.json").exists())

    def test_typed_values_and_signed_zero_are_distinct(self):
        self.assertFalse(startup.same_value(None, ""))
        self.assertFalse(startup.same_value(1, 1.0))
        self.assertFalse(startup.same_value(b"body", "body"))
        self.assertFalse(startup.same_value(-0.0, 0.0))
        self.assertTrue(startup.same_value("完整正文", "完整正文"))

    def test_removed_backup_row_is_rejected(self):
        self.migrate()
        original = startup.audit.inspect
        def removed(database, *args, **kwargs):
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("DELETE FROM articles WHERE id='a'")
            return original(database, *args, **kwargs)
        with patch.object(startup.audit, "inspect", removed):
            with self.assertRaisesRegex(ValueError, "articles"):
                self.prepare()
        self.assertFalse((self.root / "baseline.json").exists())


if __name__ == "__main__":
    unittest.main()
