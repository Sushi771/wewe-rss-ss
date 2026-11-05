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
        injected = []
        def concurrent(connection, database, *args, **kwargs):
            result = original(connection, database, *args, **kwargs)
            if Path(database).samefile(self.database):
                injected.append(True)
                with closing(sqlite3.connect(self.database)) as writer, writer:
                    writer.execute("UPDATE articles SET body='concurrent' WHERE id='a'")
            return result
        with patch.object(startup.audit, "inspect_connection", concurrent):
            with self.assertRaisesRegex(ValueError, "source changed"):
                self.prepare()
        self.assertEqual(injected, [True])
        self.assertFalse((self.root / "baseline.json").exists())

    def test_frozen_metadata_wal_commit_cannot_publish_a_stale_baseline(self):
        self.migrate()
        writer = sqlite3.connect(self.database)
        self.addCleanup(writer.close)
        writer.execute('PRAGMA journal_mode=WAL')
        identity = startup.source_identity(self.database)
        api_identity = startup.backup_api.source_identity(self.database)
        original = startup.compare_tables
        def commit_after_copy(*args):
            original(*args)
            writer.execute("UPDATE articles SET body='changed under frozen metadata' WHERE id='a'")
            writer.commit()
        with patch.object(startup, 'source_identity', return_value=identity), patch.object(startup.backup_api, 'source_identity', return_value=api_identity), patch.object(startup, 'compare_tables', side_effect=commit_after_copy):
            with self.assertRaisesRegex(ValueError, 'source changed'):
                self.prepare()
        self.assertFalse((self.root/'baseline.json').exists())
        self.assertFalse(list((self.root/'backups').glob('.latest-*.json')))
        self.assertFalse(list((self.root/'backups').rglob('verification.json')))
        self.assertTrue(list((self.root/'backups').rglob('wewe-rss.db')))

    def test_reuse_wal_commit_after_pinned_comparison_is_rejected_with_frozen_metadata(self):
        self.migrate()
        first = self.prepare()
        (self.root/'baseline.json').unlink()
        writer = sqlite3.connect(self.database)
        self.addCleanup(writer.close)
        writer.execute('PRAGMA journal_mode=WAL')
        identity = startup.source_identity(self.database)
        original = startup.compare_tables
        injected = []
        def commit_after_reuse(*args):
            original(*args)
            writer.execute("UPDATE articles SET body='late reuse WAL commit' WHERE id='a'")
            writer.commit(); injected.append(True)
        with patch.object(startup, 'source_identity', return_value=identity), patch.object(startup, 'compare_tables', side_effect=commit_after_reuse):
            with self.assertRaisesRegex(ValueError, 'source changed'):
                self.prepare()
        self.assertEqual(injected, [True])
        self.assertFalse((self.root/'baseline.json').exists())
        self.assertEqual(len(list((self.root/'backups').rglob('wewe-rss.db'))), 1)
        self.assertEqual(startup.backup_api.sha256(Path(first['backup']['backup'])), first['backup']['sha256'])

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
