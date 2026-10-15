"""Read-only, streaming typed-row preservation proof; never opens a writer."""
import hashlib, json, sqlite3, sys, time
from pathlib import Path
from contextlib import closing

def inspect(database, baseline=None, allowed_new=()):
    until = time.monotonic() + 120
    with closing(sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        db.set_progress_handler(lambda: int(time.monotonic() > until), 1000)
        db.execute('BEGIN')
        assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
        assert not db.execute('PRAGMA foreign_key_check').fetchone()
        names = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='_prisma_migrations' ORDER BY name")]
        assert len(names) <= 1024
        result = {'integrity': 'ok', 'tables': {}}
        quote = lambda name: '"' + name.replace('"', '""') + '"'
        for name in names:
            columns = [r[1] for r in db.execute('PRAGMA table_info(' + quote(name) + ')')]
            selected = baseline['tables'][name]['columns'] if baseline and name in baseline['tables'] else columns
            assert len(columns) <= 1024 and set(selected) <= set(columns)
            count, total, xor = 0, 0, 0
            for row in db.execute('SELECT ' + ','.join(map(quote, selected)) + ' FROM ' + quote(name)):
                if time.monotonic() > until: raise TimeoutError('state-proof-timeout')
                value = hashlib.sha256(repr(row).encode('utf-8')).digest()
                total = (total + int.from_bytes(value, 'big')) % (1 << 256)
                xor ^= int.from_bytes(hashlib.sha256(b'second:' + value).digest(), 'big')
                count += 1
            state = {'columns': selected, 'rows': count, 'sum': f'{total:064x}', 'xor': f'{xor:064x}'}
            result['tables'][name] = state
        if baseline:
            assert set(baseline['tables']) <= set(result['tables']), 'old-table-removed'
            for name, state in baseline['tables'].items(): assert result['tables'][name] == state, 'old-row-changed'
            for name in set(names) - set(baseline['tables']):
                assert name in allowed_new and result['tables'][name]['rows'] == 0, 'unapproved-new-table'
        return result

if __name__ == '__main__':
    try:
        baseline = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8')) if len(sys.argv) > 2 else None
        result = inspect(sys.argv[1], baseline, json.loads(sys.argv[3]) if len(sys.argv) > 3 else [])
        print(json.dumps(result))
    except Exception:
        print('ONCE_PUBLICATION_STATE_PROOF_FAILED', file=sys.stderr)
        raise SystemExit(1)
