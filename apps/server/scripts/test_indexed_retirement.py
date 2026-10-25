"""Read-only indexed-plan proof tests. Never invokes a retirement executor."""
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('indexed_review_tests',Path(__file__).with_name('sqlite-retention-plan.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)


class TypedProofTests(unittest.TestCase):
    def compare(self,change):
        sql="""CREATE TABLE feeds(id INTEGER PRIMARY KEY,sync_time INTEGER,update_time INTEGER,
            updated_at INTEGER,last_collection_result TEXT,provider_refresh_attempt_time INTEGER,has_history INTEGER);
            CREATE TABLE articles(id INTEGER PRIMARY KEY,body TEXT,media TEXT);
            INSERT INTO feeds VALUES(1,1,2,3,'old',4,1);
            INSERT INTO articles VALUES(1,'complete body','local://image');"""
        with closing(sqlite3.connect(':memory:')) as old,closing(sqlite3.connect(':memory:')) as new:
            for db in (old,new):db.executescript(sql)
            new.executescript(change)
            old.execute("ATTACH ':memory:' AS witness")
            old.deserialize(new.serialize(),name='witness')
            before=old.serialize()
            out=r.indexed_typed_coverage(old)
            self.assertEqual(old.serialize(),before)
            return out

    def test_five_exact_columns_and_extra_rows_pass_without_returning_values(self):
        out=self.compare("UPDATE feeds SET sync_time=9,update_time=8,updated_at=7,last_collection_result='new',provider_refresh_attempt_time=6; INSERT INTO articles VALUES(2,'new body','local://new')")
        self.assertTrue(out['covers']);self.assertFalse(out['credentialValuesReturned'])
        self.assertNotIn('complete body',json.dumps(out))

    def test_all_other_content_schema_and_types_stay_strict(self):
        for change in ("UPDATE feeds SET has_history=0", "UPDATE articles SET body='changed'",
            "UPDATE articles SET media='other'", "UPDATE articles SET id=2", "DELETE FROM articles",
            "ALTER TABLE articles ADD COLUMN extra TEXT", "UPDATE articles SET body=x'626f6479'"):
            with self.subTest(change=change):self.assertFalse(self.compare(change)['covers'])

    def test_ambiguous_real_bit_comparison_stays_held(self):
        with closing(sqlite3.connect(':memory:')) as old,closing(sqlite3.connect(':memory:')) as new:
            for db in (old,new):db.executescript('CREATE TABLE measurements(id INTEGER PRIMARY KEY,value REAL); INSERT INTO measurements VALUES(1,1.25)')
            old.execute("ATTACH ':memory:' AS witness");old.deserialize(new.serialize(),name='witness')
            out=r.indexed_typed_coverage(old)
            self.assertFalse(out['covers']);self.assertEqual(out['tables'][0]['realRows'],1)


class ReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='indexed-reference-test-');self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name).resolve();self.root=self.base/'managed';self.archive=self.base/'archive'
        self.root.mkdir();self.archive.mkdir();self.target=self.root/'point'/'wewe-rss.db'
        self.target.parent.mkdir();self.target.write_bytes(b'fixture data never read by reference review')
        self.write(self.archive/'verification.json',{'backup':str(self.archive/'old.db'),'integrityCheck':'ok','sha256':'a'*64})
        self.write(self.root/'retention-protected.json',{'format':'sqlite-retention-protected-v1','paths':[]})
        self.write(self.target.parent/'unknown.json',{'mustNotBeRead':True})
        self.registration=patch.object(r.backup,'legacy_registration',return_value={'roots':[self.archive],'record':None})
        self.registration.start();self.addCleanup(self.registration.stop)

    def write(self,file,value):file.write_text(json.dumps(value),encoding='utf-8')
    def review(self):return r.indexed_reference_review(self.root,self.target,r.ReadBudget())

    def test_registered_root_metadata_is_bound_without_database_descent(self):
        out=self.review();self.assertTrue(out['complete']);self.assertEqual(out['recursiveDatabaseReads'],0)
        self.assertEqual(len(out['roots']),2)
        self.assertFalse(any(x['path'].endswith('unknown.json') for x in out['records']))

    def test_unknown_metadata_and_live_protection_hold_the_candidate(self):
        self.write(self.archive/'unknown.json',{'target':str(self.target)})
        budget=r.ReadBudget();read=budget.json
        def known_only(file):
            self.assertNotEqual(file.name,'unknown.json','unknown contents must never be extracted')
            return read(file)
        budget.json=known_only
        out=r.indexed_reference_review(self.root,self.target,budget)
        self.assertFalse(out['complete']);self.assertEqual(out['unknown'][0]['reason'],'unknown-reference-metadata')
        self.write(self.root/'snapshot-owner-test.json',{'backup':str(self.target)})
        self.assertTrue(self.review()['candidateReferenced'])

    def test_archive_receipt_must_be_self_contained(self):
        self.write(self.archive/'verification.json',{'backup':str(self.target),'integrityCheck':'ok','sha256':'a'*64})
        self.assertFalse(self.review()['complete'])


if __name__=='__main__':unittest.main()
