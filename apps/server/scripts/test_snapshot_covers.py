"""In-memory counterexamples for the single-column coverage exception.

No production data, credentials, filesystem deletion or retirement execution.
"""
from contextlib import closing
import importlib.util
from pathlib import Path
import sqlite3
import unittest

spec = importlib.util.spec_from_file_location('coverage_backup', Path(__file__).with_name('backup-sqlite.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class Budget:
    maximum = 1024**2
    def __init__(self): self.used = 0
    def tick(self): pass


SCHEMA = """
CREATE TABLE feeds(id TEXT PRIMARY KEY,sync_time INTEGER,update_time INTEGER,
 updated_at INTEGER,has_history INTEGER,last_collection_result TEXT,
 provider_refresh_attempt_time INTEGER,unknown_state TEXT);
CREATE TABLE articles(id TEXT PRIMARY KEY,body TEXT,media_ref TEXT,metric INTEGER);
CREATE TABLE notes(id TEXT PRIMARY KEY,body TEXT);
CREATE TABLE unknown_table(id TEXT PRIMARY KEY,sync_time INTEGER);
INSERT INTO feeds VALUES('feed',1,2,3,1,'saved',4,'strict');
INSERT INTO articles VALUES('article','complete original body','local://image-1',5);
INSERT INTO notes VALUES('note','original note');
INSERT INTO unknown_table VALUES('row',1);
"""


class CoverageTests(unittest.TestCase):
    def compare(self, change, schema=SCHEMA):
        with closing(sqlite3.connect(':memory:')) as old, closing(sqlite3.connect(':memory:')) as new:
            for db in (old,new): db.executescript(schema)
            old_before = old.serialize()
            new.executescript(change)
            new_before = new.serialize()
            result = backup.snapshot_covers(new,old,Budget())
            self.assertEqual(old.serialize(),old_before)
            self.assertEqual(new.serialize(),new_before)
            return result

    def test_only_ordinary_feed_sync_time_may_differ_without_mutation(self):
        self.assertTrue(self.compare("UPDATE feeds SET sync_time=99; INSERT INTO articles VALUES('new','new body','local://image-2',6);"))

    def test_other_previously_ignored_feed_fields_are_now_strict(self):
        for column in ('update_time','updated_at','has_history','last_collection_result','provider_refresh_attempt_time','unknown_state'):
            with self.subTest(column=column):
                self.assertFalse(self.compare(f"UPDATE feeds SET sync_time=99,{column}='changed';"))

    def test_content_media_identity_and_metrics_remain_strict(self):
        for sql in ("UPDATE articles SET body='changed'", "UPDATE articles SET media_ref='local://other'",
                    "UPDATE articles SET id='other'", "UPDATE articles SET metric=6",
                    "UPDATE notes SET body='changed'", "UPDATE unknown_table SET sync_time=99",
                    "UPDATE feeds SET id='other'"):
            with self.subTest(sql=sql):
                self.assertFalse(self.compare('UPDATE feeds SET sync_time=99;'+sql))

    def test_missing_rows_types_and_schema_drift_are_rejected(self):
        for sql in ("DELETE FROM articles", "UPDATE articles SET metric='changed-type'",
                    "ALTER TABLE articles ADD COLUMN unknown TEXT", "CREATE TABLE extra(id TEXT)"):
            with self.subTest(sql=sql): self.assertFalse(self.compare(sql))

    def test_generated_sync_time_is_not_exempt(self):
        schema = "CREATE TABLE feeds(id INTEGER PRIMARY KEY,value INTEGER,sync_time INTEGER GENERATED ALWAYS AS(value*2) STORED); INSERT INTO feeds(id,value) VALUES(1,5);"
        self.assertFalse(self.compare('UPDATE feeds SET value=6',schema))

    def test_sync_time_primary_key_still_binds_identity(self):
        schema = 'CREATE TABLE feeds(sync_time INTEGER PRIMARY KEY,body TEXT); INSERT INTO feeds VALUES(1,"strict");'
        self.assertFalse(self.compare('UPDATE feeds SET sync_time=2',schema))


if __name__ == '__main__': unittest.main()
