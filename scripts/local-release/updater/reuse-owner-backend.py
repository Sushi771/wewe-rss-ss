"""Private read-only reuse/OS-lock worker for the fixed maintenance owner.

Never copies, restores or deletes a database. A resume message is channel data,
not maintenance authority; only the JS owner's live opaque continuation admits it.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import time


def digest(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def plain(file):
    file = Path(file)
    if not file.is_absolute():
        raise ValueError('REUSE_PATH_INVALID')
    for at in (file, *file.parents):
        if at.is_symlink() or (hasattr(at, 'is_junction') and at.is_junction()):
            raise ValueError('REUSE_PATH_REDIRECTED')
    if file.resolve(strict=True) != file:
        raise ValueError('REUSE_PATH_REDIRECTED')
    return file


def pin(file):
    file = plain(file)
    a = file.stat()
    if not file.is_file() or a.st_nlink != 1:
        raise ValueError('REUSE_FILE_NOT_PLAIN')
    value = digest(file)
    b = file.stat()
    ident = lambda s: [str(s.st_dev), str(s.st_ino), str(s.st_size), str(s.st_mtime_ns), str(s.st_ctime_ns)]
    if ident(a) != ident(b):
        raise ValueError('REUSE_FILE_CHANGED')
    return {'path': str(file), 'sha256': value, 'identity': ident(a)}


def inventory(root):
    root = plain(root)
    result = []
    todo = [root]
    while todo:
        for file in todo.pop().iterdir():
            plain(file)
            if file.is_dir():
                todo.append(file)
            elif file.is_file():
                result.append(pin(file))
            else:
                raise ValueError('REUSE_UNKNOWN_BACKUP_ENTRY')
            if len(todo) + len(result) > 10000:
                raise ValueError('REUSE_INVENTORY_LIMIT')
    return sorted(result, key=lambda item: item['path'])


def main():
    profile_file, profile_sha = sys.argv[1:]
    if digest(plain(profile_file)) != profile_sha:
        raise ValueError('REUSE_PROFILE_CHANGED')
    p = json.loads(Path(profile_file).read_bytes())
    if p.get('kind') != 'fixed-held-same-schema-maintenance-v1' or p['backup']['mode'] != 'exact-protected-reuse-v1':
        raise ValueError('FIXED_REUSE_PROFILE_REQUIRED')
    helper = p['backup']['helper']
    if digest(plain(helper['path'])) != helper['sha256']:
        raise ValueError('REUSE_HELPER_CHANGED')
    spec = importlib.util.spec_from_file_location('fixed_backup', helper['path'])
    backup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backup)
    database, root, expected = map(plain, [p['database'], p['backupDataRoot'], p['backup']['path']])
    if not expected.is_relative_to(root) or database.is_relative_to(root):
        raise ValueError('REUSE_ROOT_CHANGED')
    first = json.loads(sys.stdin.readline())
    tx, nonce = first['transactionId'], first['nonce']
    if first['operation'] not in ('admit', 'resume') or len(nonce) != 64:
        raise ValueError('REUSE_CHANNEL_INVALID')
    source_identity = [str(database.stat().st_dev), str(database.stat().st_ino)]
    if source_identity != p['backup']['sourceIdentity']:
        raise ValueError('REUSE_SOURCE_IDENTITY_CHANGED')
    lock = database.parent / ('.full-snapshot-' + hashlib.sha256(str(database).encode()).hexdigest()[:24] + '.lock')

    def checked():
        if digest(profile_file) != profile_sha or digest(helper['path']) != helper['sha256']:
            raise ValueError('REUSE_CODE_OR_PROFILE_CHANGED')
        actual = inventory(root)
        if actual != p['backup']['inventory']:
            raise ValueError('REUSE_BACKUP_INVENTORY_CHANGED')
        if (root / '.space-budget.lock').exists() or list(database.parent.glob('.wewe-restore-stage-*')):
            raise ValueError('REUSE_UNSETTLED_BACKUP_STATE')
        limits = p['backup']['limits']
        if limits != [16 * 1024**3, 9, 4 * 1024**3]:
            raise ValueError('REUSE_BUDGET_CHANGED')
        copies = sum(Path(row['path']).suffix.lower() in ('.db', '.sqlite', '.sqlite3') for row in actual)
        reserve = expected.stat().st_size + 1024**2
        if not 1 <= copies <= 8 or copies + 1 > limits[1] or sum(int(row['identity'][2]) for row in actual) + reserve > limits[0]:
            raise ValueError('REUSE_RESTORE_CAPACITY_UNAVAILABLE')
        if any(shutil.disk_usage(at).free - reserve < limits[2] for at in (root, database.parent)):
            raise ValueError('REUSE_RESTORE_CAPACITY_UNAVAILABLE')
        if [str(database.stat().st_dev), str(database.stat().st_ino)] != source_identity:
            raise ValueError('REUSE_SOURCE_IDENTITY_CHANGED')
        if digest(expected) != p['backup']['sha256']:
            raise ValueError('REUSE_PROTECTED_BACKUP_CHANGED')
        lease.check()

    def equal():
        report = backup.reusable(database, root, time.monotonic() + 45, allow_periodic=False)
        return bool(report and report.get('backup') == str(expected) and report.get('sha256') == p['backup']['sha256'] and report.get('reused') is True)

    with backup.FileLock(lock, timeout=5) as lease:
        checked()
        if first['operation'] == 'admit' and not equal():
            raise ValueError('REQUIRED_REUSE_UNAVAILABLE')
        checked()
        print(json.dumps({'ready': True, 'transactionId': tx, 'reused': True, 'mode': first['operation']}), flush=True)
        sequence = 0
        for line in sys.stdin:
            request = json.loads(line)
            if request['nonce'] != nonce or request['transactionId'] != tx or request['sequence'] != sequence + 1:
                raise ValueError('REUSE_CHANNEL_REPLAY')
            sequence += 1
            checked()
            operation = request['operation']
            if operation not in ('check', 'same', 'close'):
                raise ValueError('REUSE_OPERATION_INVALID')
            response = {'sequence': sequence, 'ok': True}
            if operation == 'same':
                response['same'] = equal()
                checked()
            print(json.dumps(response), flush=True)
            if operation == 'close':
                return


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not print database paths, arbitrary exception details or channel nonce.
        code = str(error)
        print(json.dumps({'error': code if code.replace('_', '').isupper() else 'REUSE_OWNER_FAILED'}), flush=True)
        raise SystemExit(1)
