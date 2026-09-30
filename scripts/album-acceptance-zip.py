"""Verify a real controller ZIP against its staged files; print counts only."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

archive, folder = Path(sys.argv[1]), Path(sys.argv[2])
expected = {p.relative_to(folder).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in folder.rglob('*') if p.is_file()}
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None, 'ZIP CRC failure'
    actual = {name: hashlib.sha256(bundle.read(name)).hexdigest()
              for name in bundle.namelist() if not name.endswith('/')}
    assert actual == expected, 'ZIP differs from offline directory'
    assert 'README.md' in actual
print(json.dumps({'files': len(actual), 'attachments': sum('/attachments/' in n for n in actual),
                  'bytes': archive.stat().st_size, 'crc': 'ok', 'stagedBytesEqual': True}))
