import importlib.util, json, sqlite3, tempfile, unittest, sys
from pathlib import Path
from contextlib import closing
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('owned_state', Path(__file__).with_name('once-pair-state.py'))
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)

class StateProof(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wewe-state-proof-')
        self.database = Path(self.temporary.name) / 'synthetic.db'
        with closing(sqlite3.connect(self.database)) as db, db:
            db.executescript("CREATE TABLE articles(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO articles VALUES(1,'保留正文'); CREATE TABLE claims(id INTEGER PRIMARY KEY, attempted INTEGER, state TEXT); INSERT INTO claims VALUES(1,1,'unknown');")
        self.before = state.inspect(self.database)
    def tearDown(self): self.temporary.cleanup()
    def test_additive_schema_preserves_every_original_typed_row(self):
        with closing(sqlite3.connect(self.database)) as db, db: db.executescript('ALTER TABLE articles ADD COLUMN optional TEXT; CREATE TABLE new_claims(id TEXT);')
        after = state.inspect(self.database, self.before, ['new_claims'])
        self.assertEqual(after['tables']['claims'], self.before['tables']['claims'])
    def test_unknown_claim_mutation_is_refused(self):
        with closing(sqlite3.connect(self.database)) as db, db: db.execute("UPDATE claims SET attempted=0,state='queued'")
        with self.assertRaises(AssertionError): state.inspect(self.database, self.before)
    def test_unapproved_new_or_seeded_table_is_refused(self):
        with closing(sqlite3.connect(self.database)) as db, db: db.executescript('CREATE TABLE new_claims(id TEXT); INSERT INTO new_claims VALUES("seed");')
        with self.assertRaises(AssertionError): state.inspect(self.database, self.before, ['new_claims'])
    def test_duplicate_rows_and_binary_values_are_counted(self):
        with closing(sqlite3.connect(self.database)) as db, db: db.executescript("CREATE TABLE data(value BLOB); INSERT INTO data VALUES(X'0001'),(X'0001');")
        before = state.inspect(self.database)
        with closing(sqlite3.connect(self.database)) as db, db: db.execute('DELETE FROM data WHERE rowid=1')
        with self.assertRaises(AssertionError): state.inspect(self.database, before)

if __name__ == '__main__': unittest.main()
