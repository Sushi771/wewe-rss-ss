"""Create and verify a consistent SQLite backup before a collection write."""

import argparse
import hashlib
import json
import os
import math
import sqlite3
import sys
import time
import uuid
import shutil
import struct
from itertools import zip_longest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


class FileLock:
    """One local OS file lock; closes on crash without deleting its pathname."""

    def __init__(self, path, timeout=0):
        self.path = Path(path)
        self.stream = self.path.open("a+b")
        deadline = time.monotonic() + timeout
        try:
            if os.name == "nt" and self.path.stat().st_size == 0:
                self.stream.write(b"0")
                self.stream.flush()
            while True:
                try:
                    if os.name == "nt":
                        import msvcrt
                        self.stream.seek(0)
                        msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("SQLite backup lock unavailable")
                    time.sleep(min(0.05, max(0, deadline - time.monotonic())))
            stat = self.path.stat()
            if not stat.st_ino:
                raise ValueError("unprovable-file-identity")
            self.identity = [str(stat.st_dev), str(stat.st_ino)]
        except BaseException:
            self.stream.close()
            raise

    def check(self):
        stat = self.path.stat()
        if self.stream.closed or [str(stat.st_dev), str(stat.st_ino)] != self.identity:
            raise ValueError("owner-lock-replaced")

    def close(self):
        self.stream.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def sha256(path, deadline=None):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            if deadline is not None and time.monotonic() > deadline:
                raise TimeoutError("SQLite backup hash timed out")
            digest.update(chunk)
    return digest.hexdigest()


class BackupDiagnostics:
    """Bounded stage telemetry: never contains paths, SQL, or source content."""

    def __init__(self):
        self.started = self.changed = time.monotonic()
        self.stage = "lock"
        self.timings = {}
        self.copy_steps = self.busy_steps = 0
        self.journal = "unknown"

    def enter(self, stage):
        now = time.monotonic()
        self.timings[self.stage] = round((now - self.changed) * 1000)
        self.stage, self.changed = stage, now

    def report(self):
        timings = dict(self.timings)
        timings[self.stage] = round((time.monotonic() - self.changed) * 1000)
        return {"stage": self.stage, "milliseconds": timings,
                "copySteps": self.copy_steps, "busySteps": self.busy_steps,
                "journalMode": self.journal}


def source_identity(database):
    result = []
    for file in (database, Path(str(database) + '-wal')):
        try:
            stat = file.stat()
            if str(file).endswith('-wal') and stat.st_size == 0:
                result.append(None); continue
            result.append([str(value) for value in (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)])
        except FileNotFoundError:
            result.append(None)
    return result


def source_hashes(database):
    return [sha256(file) if file.exists() else None for file in (database, Path(str(database) + '-wal'))]


def positive(name, fallback):
    value = int(os.environ.get(name, fallback))
    if value <= 0:
        raise ValueError('Invalid ' + name)
    return value


MAX_LAYOUT_ENTRIES = 8192
MAX_LEGACY_ROOTS = 256
MAX_LEGACY_DOCUMENT = 256*1024

_lifecycle = None


def periodic_lifecycle():
    global _lifecycle
    if _lifecycle is None:
        import importlib.util
        file=Path(__file__).with_name('periodic-lifecycle.py').resolve()
        name='wewe_periodic_lifecycle_'+hashlib.sha256(str(file).encode()).hexdigest()[:24]
        if name in sys.modules:
            _lifecycle=sys.modules[name]
        else:
            spec = importlib.util.spec_from_file_location(name,file)
            module=importlib.util.module_from_spec(spec)
            sys.modules[name]=module
            try:spec.loader.exec_module(module)
            except BaseException:
                del sys.modules[name]
                raise
            _lifecycle=module
    return _lifecycle


def safe_backup_failure(error,stage='unknown'):
    """Finite diagnostic only: never return exception text, paths or argv."""
    text=str(error)
    if text in ('SQLITE_PERIODIC_NOT_DUE','SQLITE_PERIODIC_PENDING_CONFIRMATION',
                'SQLITE_PERIODIC_LIFECYCLE_HELD','SQLITE_PERIODIC_EVIDENCE_INVALID',
                'SQLITE_PERIODIC_CONFIRMATION_REQUIRED','SQLITE_PERIODIC_POLICY_INVALID',
                'SQLITE_PERIODIC_NATIVE_RELEASE_REQUIRED','SQLITE_PERIODIC_UNIQUE_HISTORY_HELD'):
        return {'code':text,'stage':'rotation'}
    for code in ('SQLITE_BACKUP_LAYOUT_REQUIRES_REVIEW','SQLITE_BACKUP_LAYOUT_REGISTRATION_INVALID',
                 'SQLITE_BACKUP_LAYOUT_REGISTRATION_CHANGED','SQLITE_BACKUP_LAYOUT_AMBIGUOUS_REGISTRATION',
                 'SQLITE_BACKUP_LAYOUT_IDENTITY_UNPROVED','SQLITE_BACKUP_LAYOUT_SCAN_LIMIT'):
        if text.startswith(code):return {'code':code,'stage':'layout'}
    if text.startswith('SQLITE_SPACE_BUDGET_EXCEEDED'):return {'code':'SQLITE_SPACE_BUDGET_EXCEEDED','stage':'budget'}
    if text in ('SQLITE_PERIODIC_RETENTION_HELD','SQLITE_PERIODIC_RETENTION_PROOF_LIMIT','SQLITE_PERIODIC_RETENTION_RESERVE_EXCEEDED'):
        return {'code':text,'stage':'rotation'}
    if text=='SQLITE_PERIODIC_RETENTION_POLICY_INVALID':return {'code':text,'stage':'budget'}
    if text in ('snapshot-checksum-failed','snapshot-verification-failed','snapshot-integrity-failed','snapshot-schema-mismatch'):
        return {'code':'SQLITE_BACKUP_VERIFICATION_FAILED','stage':'hash' if text=='snapshot-checksum-failed' else 'verify'}
    if text in ('database-replaced','database-schema-changed'):return {'code':'SQLITE_BACKUP_SOURCE_CHANGED','stage':'verify'}
    if text.startswith(('Cyclic backup directory','Nested source/','Source inside legacy')):
        return {'code':'SQLITE_BACKUP_LAYOUT_REQUIRES_REVIEW','stage':'layout'}
    if isinstance(error,TimeoutError) and 'lock' in text.lower():return {'code':'SQLITE_BACKUP_BUSY','stage':'lock'}
    allowed={'lock','snapshot','copy','verify','hash','rotation','unknown'}
    return {'code':'SQLITE_BACKUP_TIMEOUT' if isinstance(error,TimeoutError) else 'SQLITE_BACKUP_FAILED',
            'stage':stage if stage in allowed else 'unknown'}


def directory_identity(path):
    info=path.stat()
    if not path.is_dir() or not info.st_ino:raise ValueError('SQLITE_BACKUP_LAYOUT_IDENTITY_UNPROVED')
    return [str(info.st_dev),str(info.st_ino)]


def local_directory(value):
    if not isinstance(value,str) or not Path(value).is_absolute() or value.startswith(('\\\\','//')) or any(x in value for x in '\0\r\n'):
        raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_INVALID')
    path=Path(value)
    if path.resolve(strict=True)!=path:raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_INVALID')
    directory_identity(path)
    return path


def _legacy_registration(root=None):
    if os.environ.get('SQLITE_BACKUP_KIND') == 'test':
        return {'roots':[],'exact':False,'record':None}
    raw=os.environ.get('SQLITE_PRODUCTION_LEGACY_ROOTS','[]')
    filename=os.environ.get('SQLITE_PRODUCTION_LEGACY_ROOTS_FILE')
    if len(raw.encode())>MAX_LEGACY_DOCUMENT:raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_INVALID')
    roots=json.loads(raw)
    if not isinstance(roots,list) or len(roots)>MAX_LEGACY_ROOTS:raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_INVALID')
    if not filename:
        if any(not isinstance(value,str) or not Path(value).is_absolute() for value in roots):
            raise ValueError('Invalid SQLITE_PRODUCTION_LEGACY_ROOTS')
        return {'roots':list(dict.fromkeys(Path(value).resolve(strict=True) for value in roots)),'exact':False,'record':None}
    if roots:raise ValueError('SQLITE_BACKUP_LAYOUT_AMBIGUOUS_REGISTRATION')
    file=Path(filename)
    if not file.is_absolute() or str(file).startswith(('\\\\','//')) or file.is_symlink() or (hasattr(file,'is_junction') and file.is_junction()):
        raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_INVALID')
    before=file.stat()
    if not file.is_file() or not before.st_ino or before.st_size>MAX_LEGACY_DOCUMENT:raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_INVALID')
    with file.open('rb') as stream:
        opened=os.fstat(stream.fileno())
        if (opened.st_dev,opened.st_ino)!=(before.st_dev,before.st_ino):raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_CHANGED')
        data=stream.read(MAX_LEGACY_DOCUMENT+1)
    after=file.stat()
    stamp=lambda info:[str(info.st_dev),str(info.st_ino),str(info.st_size),str(info.st_mtime_ns),str(info.st_ctime_ns)]
    if len(data)>MAX_LEGACY_DOCUMENT or stamp(before)!=stamp(after):raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_CHANGED')
    document=json.loads(data.decode('utf-8-sig'))
    if (not isinstance(document,dict) or set(document)!={'format','confirmed','backupRoot','backupRootIdentity','roots'}
        or document['format']!='sqlite-legacy-roots-v1' or document['confirmed'] is not True
        or not isinstance(document['roots'],list) or len(document['roots'])>MAX_LEGACY_ROOTS):
        raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_INVALID')
    managed=local_directory(document['backupRoot'])
    if directory_identity(managed)!=document['backupRootIdentity'] or (root is not None and Path(root).resolve()!=managed):
        raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_CHANGED')
    physical=[]
    for entry in document['roots']:
        if not isinstance(entry,dict) or set(entry)!={'path','identity'}:raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_INVALID')
        target=local_directory(entry['path'])
        if directory_identity(target)!=entry['identity']:raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_CHANGED')
        physical.append(target)
    if len(set(physical))!=len(physical):raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_INVALID')
    return {'roots':physical,'exact':True,'record':{'registrationManifest':str(file.resolve()),'identity':stamp(after),
                                                 'sha256':hashlib.sha256(data).hexdigest()}}


def legacy_registration(root=None):
    try:return _legacy_registration(root)
    except (OSError,json.JSONDecodeError,UnicodeError,KeyError,TypeError):
        raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_INVALID') from None


def legacy_roots():
    return legacy_registration()['roots']


def legacy_link_allowed(target, registration):
    return target in registration['roots'] if registration['exact'] else any(target.is_relative_to(p) for p in registration['roots'])


def preview_legacy_roots(root, database=None):
    """No target traversal or DB content read; this proposal grants no authority."""
    root=local_directory(str(Path(root).resolve(strict=True)));targets={};aliases=[];deadline=time.monotonic()+10;entries=0
    if database is not None and Path(database).resolve().is_relative_to(root):raise ValueError('Nested source/destination refused')
    def visit(folder,depth=0):
        nonlocal entries
        if depth>64:raise ValueError('SQLITE_BACKUP_LAYOUT_SCAN_LIMIT')
        for file in folder.iterdir():
            entries+=1
            if entries>MAX_LAYOUT_ENTRIES or time.monotonic()>deadline:raise ValueError('SQLITE_BACKUP_LAYOUT_SCAN_LIMIT')
            if file.is_symlink() or (hasattr(file,'is_junction') and file.is_junction()):
                target=local_directory(str(file.resolve(strict=True)));stamp=directory_identity(target)
                if database is not None and Path(database).resolve().is_relative_to(target):raise ValueError('Source inside legacy backup root refused')
                aliases.append({'path':str(file.absolute()),'target':str(target),'targetIdentity':stamp})
                targets[str(target)]=stamp
                if len(targets)>MAX_LEGACY_ROOTS:raise ValueError('SQLITE_BACKUP_LAYOUT_SCAN_LIMIT')
            elif file.is_dir():visit(file,depth+1)
    visit(root)
    result={'format':'sqlite-legacy-roots-proposal-v1','inventoryComplete':False,'aliases':aliases,
            'registration':{'format':'sqlite-legacy-roots-v1','confirmed':False,'backupRoot':str(root),
                            'backupRootIdentity':directory_identity(root),
                            'roots':[{'path':p,'identity':targets[p]} for p in sorted(targets)]},
            'note':'Metadata only; review exact physical roots. Registration neither changes quotas nor authorizes deletion.'}
    if len(json.dumps(result,ensure_ascii=False).encode())>MAX_LEGACY_DOCUMENT:raise ValueError('SQLITE_BACKUP_LAYOUT_SCAN_LIMIT')
    return result


def managed_files(root, deadline=None):
    """Only explicitly listed historic roots may be traversed through links.

    Canonical paths are visited once; legacy targets are counted but never used
    as generation destinations. Unlisted links and cycles fail closed.
    """
    registration=legacy_registration(root);allowed=registration['roots']
    root_stamp=directory_identity(root) if root.exists() else None
    physical_stamps=[directory_identity(p) for p in allowed]
    stop=min(time.monotonic()+10,deadline) if deadline is not None else time.monotonic()+10
    entries=0;links=[]
    seen_directories, active_directories, seen_files, result = set(), set(), set(), []
    def visit(directory):
        nonlocal entries
        if time.monotonic()>stop:
            if deadline is not None and time.monotonic()>deadline:raise TimeoutError('SQLite backup deadline exhausted')
            raise ValueError('SQLITE_BACKUP_LAYOUT_SCAN_LIMIT')
        canonical = directory.resolve(strict=True)
        if len(active_directories)>64:raise ValueError('SQLITE_BACKUP_LAYOUT_SCAN_LIMIT')
        if canonical in active_directories:
            raise ValueError('Cyclic backup directory refused')
        if canonical in seen_directories: return
        seen_directories.add(canonical)
        active_directories.add(canonical)
        for file in directory.iterdir():
            entries+=1
            if entries>MAX_LAYOUT_ENTRIES or time.monotonic()>stop:raise ValueError('SQLITE_BACKUP_LAYOUT_SCAN_LIMIT')
            linked = file.is_symlink() or (hasattr(file,'is_junction') and file.is_junction())
            if linked:
                target = file.resolve(strict=True)
                if not file.is_dir() or not legacy_link_allowed(target,registration):
                    raise ValueError('SQLITE_BACKUP_LAYOUT_REQUIRES_REVIEW: unlisted link '+str(file))
                links.append((file,target,directory_identity(target)))
            if file.is_dir():
                visit(file)
            elif file.is_file():
                canonical_file = file.resolve(strict=True)
                if canonical_file not in seen_files:
                    seen_files.add(canonical_file); result.append(canonical_file)
        active_directories.remove(canonical)
    if root.exists(): visit(root)
    # Explicit physical historic roots count even without a junction alias.
    # A target already traversed through a declared link is counted once.
    for folder in allowed:
        if folder not in seen_directories: visit(folder)
    if (legacy_registration(root)!=registration or [directory_identity(p) for p in allowed]!=physical_stamps
        or (directory_identity(root) if root.exists() else None)!=root_stamp
        or any(file.resolve(strict=True)!=target or directory_identity(target)!=stamp for file,target,stamp in links)):
        raise ValueError('SQLITE_BACKUP_LAYOUT_REGISTRATION_CHANGED')
    return result


def periodic_retention_policy():
    if os.environ.get('SQLITE_PERIODIC_RETENTION_ENABLED')!='1':return None
    limits={'copies':('SQLITE_PERIODIC_RETENTION_COPIES',4,2,16),
            'bytes':('SQLITE_PERIODIC_RETENTION_BYTES',4*1024**3,1,32*1024**3),
            'reserveBytes':('SQLITE_PERIODIC_RETENTION_RESERVE_BYTES',2*1024**3,2*1024**2,8*1024**3),
            'readBytes':('SQLITE_PERIODIC_RETENTION_READ_BYTES',8*1024**3,1,16*1024**3)}
    result={}
    for key,(name,default,low,high) in limits.items():
        try:value=int(os.environ.get(name,default))
        except ValueError:raise ValueError('SQLITE_PERIODIC_RETENTION_POLICY_INVALID') from None
        if not low<=value<=high:raise ValueError('SQLITE_PERIODIC_RETENTION_POLICY_INVALID')
        result[key]=value
    return result


def space_preflight(database, backup_root, deadline=None, reserve=None):
    """Count all existing files, including failed copies; never prune them."""
    database, backup_root = Path(database).resolve(), Path(backup_root).resolve()
    if database.is_relative_to(backup_root):
        raise ValueError('Nested source/destination refused')
    if any(database.is_relative_to(folder) for folder in legacy_roots()):
        raise ValueError('Source inside legacy backup root refused')
    test = os.environ.get('SQLITE_BACKUP_KIND') == 'test'
    root = Path(os.environ.get('SQLITE_TEST_BUDGET_ROOT', backup_root)).resolve() if test else backup_root
    if not backup_root.is_relative_to(root):
        raise ValueError('Backup destination escapes test budget root')
    prefix = 'SQLITE_TEST' if test else 'SQLITE_PRODUCTION'
    max_bytes = positive(prefix + '_MAX_BYTES', (512 * 1024**2) if test else (32 * 1024**3))
    max_copies = positive(prefix + '_MAX_COPIES', 12 if test else 48)
    min_free = positive(prefix + '_MIN_FREE_BYTES', (256 * 1024**2) if test else (4 * 1024**3))
    files = managed_files(root,deadline)
    used = sum(file.stat().st_size for file in files)
    copies = sum(file.suffix.lower() in ('.db', '.sqlite', '.sqlite3') for file in files)
    expected = 2 * sum(file.stat().st_size for file in (database, Path(str(database) + '-wal')) if file.exists()) + 1024**2
    parent = root
    while not parent.exists():
        parent = parent.parent
    free = shutil.disk_usage(parent).free
    allowed = used+expected <= max_bytes and copies+1 <= max_copies and free-expected >= min_free
    if not test and root.exists():
        actual = max(database.stat().st_size,1)
        more = max(0,min(max_copies-copies,(max_bytes-used-expected)//actual+1,(free-min_free-expected)//actual+1))
        interval=periodic_lifecycle().interval()
        days=more*interval/86400
        status = {'nextBackupAllowed':allowed,'warning':not allowed or used/max_bytes>=.5 or copies/max_copies>=.5 or days<1,
                  'estimatedDaysAtContinuousChanges':round(days,2),'continuousChangedSnapshotIntervalSeconds':interval,
                  'forecastBasis':'continuously-changing-source; unchanged snapshots may be reused',
                  'recordedAt':datetime.now(timezone.utc).isoformat()}
        temporary=root/('.space-budget-status-'+uuid.uuid4().hex+'.tmp')
        temporary.write_text(json.dumps(status),encoding='utf-8'); temporary.replace(root/'.space-budget-status.json')
    normal=used+expected<=max_bytes and copies+1<=max_copies and free-expected>=min_free
    overflow=False
    if not normal and reserve is not None:
        overflow=(expected<=reserve['reserveBytes'] and free-expected>=min_free
                  and copies<=reserve.get('baselineCopies',copies)
                  and used<=reserve.get('baselineBytes',used)+8192)
    if not normal and not overflow:
        raise ValueError(f'SQLITE_SPACE_BUDGET_EXCEEDED: root={root}, existingBytes={used}, existingCopies={copies}, requestedBytes={expected}, freeBytes={free}. Review recovery points manually; nothing was deleted.')
    return {'root': str(root), 'existingBytes': used, 'existingCopies': copies, 'requestedBytes': expected,
            'freeBytes': free,'overflow':overflow}


def stored_columns(connection, table):
    """Include STORED generated bytes; unknown/virtual forms are unproved."""
    quoted='"'+table.replace('"','""')+'"'
    info=list(connection.execute(f'PRAGMA table_xinfo({quoted})'))
    # table_info silently omits generated/hidden columns. Virtual values may
    # be recomputed by a changed function implementation, not read from disk.
    if not info or any(len(row)!=7 or row[6] not in (0,3) for row in info):return None
    return info


def snapshot_equal(source, copied):
    """Compare every schema object and typed row in two pinned read snapshots.

    Filesystem timestamps are NEVER evidence that committed DB/WAL content is
    unchanged. A WAL commit is included through SQLite's consistent read view.
    """
    query = "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
    if list(source.execute(query)) != list(copied.execute(query)):
        return False
    quote = lambda value: '"' + value.replace('"', '""') + '"'
    missing = object()
    for (table,) in source.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        info = stored_columns(source,table)
        if info is None:return False
        primary = [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]]
        columns = ','.join(quote(row[1]) for row in info)
        sql = f'SELECT {columns} FROM {quote(table)} ORDER BY ' + (','.join(map(quote, primary)) if primary else 'rowid')
        for left, right in zip_longest(source.execute(sql), copied.execute(sql), fillvalue=missing):
            if left is missing or right is missing or len(left) != len(right):
                return False
            for a, b in zip(left, right):
                if type(a) is not type(b):
                    return False
                if isinstance(a, float):
                    if struct.pack('>d', a) != struct.pack('>d', b):
                        return False
                elif a != b:
                    return False
    return True


def snapshot_covers(current, previous, budget):
    """All old typed durable rows survive; only derived feed summaries differ.

    No article field, note, metric, subscription identity or unknown table/column
    is discarded. A changed durable value or deleted row holds the old point.
    """
    schema="SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
    if list(current.execute(schema))!=list(previous.execute(schema)):return False
    quote=lambda value:'"'+value.replace('"','""')+'"'
    derived_feed={'sync_time','update_time','updated_at','has_history','last_collection_result','provider_refresh_attempt_time'}
    count=0
    for (table,) in previous.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        info=stored_columns(previous,table)
        if info is None:return False
        columns=[r[1] for r in info if table!='feeds' or r[1] not in derived_feed or r[6]!=0]
        primary=[r[1] for r in sorted(info,key=lambda r:r[5]) if r[5]]
        hidden=next((name for name in ('rowid','_rowid_','oid') if name not in [r[1].lower() for r in info]),None)
        if not primary and hidden is None:return False
        key=primary or [hidden];selected=list(dict.fromkeys(key+columns))
        query='SELECT '+','.join(map(quote,selected))+' FROM '+quote(table)
        lookup=query+' WHERE '+' AND '.join(quote(p)+' IS ?' for p in key)
        for old in previous.execute(query):
            budget.tick();count+=1
            if count>100000:raise ValueError('SQLITE_PERIODIC_RETENTION_PROOF_LIMIT')
            # SQLite permits duplicate NULL primary keys in ordinary tables.
            # A single lookup cannot prove their multiplicity survived.
            if any(v is None for v in old[:len(key)]):return False
            new=current.execute(lookup,old[:len(key)]).fetchone()
            if new is None:return False
            for values in (old,new):
                budget.used+=sum(len(v.encode()) if isinstance(v,str) else len(v) if isinstance(v,bytes) else 8 for v in values)
            if budget.used>budget.maximum:raise ValueError('SQLITE_PERIODIC_RETENTION_PROOF_LIMIT')
            if any(type(a) is not type(b) or (struct.pack('>d',a)!=struct.pack('>d',b) if isinstance(a,float) else a!=b)
                   for a,b in zip(old,new)):return False
    return True


def reusable(database, backup_root, deadline=None, allow_periodic=False):
    receipt = backup_root / ('.latest-' + hashlib.sha256(str(database).encode()).hexdigest()[:24] + '.json')
    try:
        report = json.loads(receipt.read_text(encoding='utf-8'))
        backup = Path(report['backup']).resolve(strict=True)
        kinds = ('protected', 'periodic') if allow_periodic else ('protected',)
        if report.get('recoveryOrigin',{}).get('kind') not in kinds or report['source'] != str(database) or not backup.is_relative_to(backup_root) or sha256(backup, deadline) != report['sha256']:
            return None
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(backup.as_uri() + '?mode=ro', uri=True)) as copied:
            if deadline is not None:
                for connection in (source, copied):
                    connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
            source.execute('PRAGMA query_only=ON'); source.execute('BEGIN')
            copied.execute('PRAGMA query_only=ON'); copied.execute('BEGIN')
            if list(copied.execute('PRAGMA integrity_check')) != [('ok',)] or not snapshot_equal(source, copied):
                return None
        if sha256(backup, deadline) != report['sha256']:
            return None
        return {**report, 'reused': True, 'reuseProof': 'all-schema-and-typed-rows-pinned-snapshot-v1'}
    except (OSError, ValueError, KeyError, sqlite3.Error):
        return None


def create_backup(database, backup_root, prefix="before-collection", timeout=55,
                  diagnostics=None, copy_timeout=None, periodic_now=None):
    if prefix != 'periodic-snapshot':
        return _create_backup_legacy(database, backup_root, prefix, timeout, diagnostics, copy_timeout)
    enabled=os.environ.get('SQLITE_PERIODIC_LIFECYCLE_ENABLED','0')
    if enabled not in ('0','1'):raise ValueError('SQLITE_PERIODIC_POLICY_INVALID')
    if enabled!='1':
        database,backup_root=Path(database).resolve(strict=True),Path(backup_root).resolve()
        if periodic_lifecycle().previously_enabled(database,backup_root):
            raise ValueError('SQLITE_PERIODIC_LIFECYCLE_HELD')
        return _create_backup_legacy(database, backup_root, prefix, timeout, diagnostics, copy_timeout)
    if os.name!='nt':raise ValueError('SQLITE_PERIODIC_NATIVE_RELEASE_REQUIRED')
    copy_timeout=float(os.environ.get('SQLITE_BACKUP_COPY_TIMEOUT_SECONDS','45')) if copy_timeout is None else copy_timeout
    if not math.isfinite(copy_timeout) or not 0 < copy_timeout <= 45:
        raise ValueError('SQLite backup copy budget invalid')
    return periodic_lifecycle().create(sys.modules.get(__name__) or _self_module(),
        Path(database).resolve(strict=True),Path(backup_root).resolve(),timeout,
        diagnostics or BackupDiagnostics(),copy_timeout,periodic_now)


def _self_module():
    # importlib callers need not insert this script in sys.modules.
    from types import SimpleNamespace
    return SimpleNamespace(**globals())


def _create_backup_legacy(database, backup_root, prefix="before-collection", timeout=55,
                  diagnostics=None, copy_timeout=None):
    database = Path(database).resolve(strict=True)
    lock_name = hashlib.sha256(str(database).encode()).hexdigest()[:24]
    deadline = time.monotonic() + timeout
    diagnostics = diagnostics or BackupDiagnostics()
    if copy_timeout is None:
        copy_timeout = float(os.environ.get("SQLITE_BACKUP_COPY_TIMEOUT_SECONDS", "45"))
        if not 1 <= copy_timeout <= 45:
            raise ValueError("SQLite backup copy budget invalid")
    if not math.isfinite(copy_timeout) or not 0 < copy_timeout <= 45:
        raise ValueError("SQLite backup copy budget invalid")
    # Periodic and original write-before backups share this operation lock.
    # Lock contention is bounded and failure never permits an unprotected write.
    with FileLock(database.parent / f".full-snapshot-{lock_name}.lock",
                  timeout=max(0, min(30, timeout))) as lock:
        backup_root = Path(backup_root).resolve()
        automatic=periodic_retention_policy() if prefix=='periodic-snapshot' else None
        if (automatic and os.environ.get('SQLITE_BACKUP_KIND')=='test'
            and Path(os.environ.get('SQLITE_TEST_BUDGET_ROOT',backup_root)).resolve()!=backup_root):
            raise ValueError('SQLITE_PERIODIC_RETENTION_POLICY_INVALID')
        lease=backup_root/'.space-budget.lock'
        lease_identity=None
        if automatic and lease.exists():raise ValueError('SQLITE_PERIODIC_RETENTION_HELD')
        # Restart still needs a new full proof, never authority from a saved
        # owner/token. Hash + integrity + every typed row can prove the existing
        # periodic bytes current without creating an identical physical copy.
        # High-risk callers retain their existing protected-origin requirement.
        report = reusable(database, backup_root, deadline,
                          allow_periodic=prefix == 'periodic-snapshot')
        if report is None:
            initial=space_preflight(database, backup_root,deadline,reserve=automatic)
            backup_root.mkdir(parents=True, exist_ok=True)
            # Shared with native startup preparation. A crash leaves an explicit
            # blocked lease for operator review, not an unbounded next copy.
            lease = Path(initial['root']) / '.space-budget.lock'
            reservation={**automatic,'baselineCopies':initial['existingCopies'],'baselineBytes':initial['existingBytes']} if automatic else None
            with lease.open('x', encoding='utf-8') as stream:
                json.dump({'pid': os.getpid(), 'startedAt': datetime.now(timezone.utc).isoformat(),
                           **({'format':'sqlite-periodic-retention-lease-v1','source':str(database),
                               'baselineCopies':initial['existingCopies'],'baselineBytes':initial['existingBytes'],
                               'reserveBytes':automatic['reserveBytes']} if automatic else {})}, stream)
                stream.flush();os.fsync(stream.fileno())
                info=os.fstat(stream.fileno())
                lease_identity=[str(v) for v in (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,
                                getattr(info,'st_birthtime_ns',info.st_ctime_ns))]
            try:
                space_preflight(database, backup_root,deadline,reserve=reservation)
                report = _create_backup(database, backup_root, prefix,
                                        deadline - time.monotonic(), diagnostics, copy_timeout,
                                        **({'max_bytes':automatic['reserveBytes']-1024**2} if automatic else {}))
            except BaseException as error:
                (backup_root / 'last-failure.json').write_text(json.dumps({'failure': type(error).__name__, 'message': str(error), 'existingFilesRetained': True}), encoding='utf-8')
                raise
            finally:
                if not automatic:lease.unlink()
        if time.monotonic() > deadline:
            raise TimeoutError('SQLite backup deadline exhausted')
        lock.check()
        return {**report, "diagnostics": diagnostics.report(),
                **({'retentionLeaseIdentity':lease_identity} if automatic else {})}


def _create_backup(database, backup_root, prefix, timeout, diagnostics=None,
                   copy_timeout=45, max_bytes=None, periodic_metadata=None):
    """Same online API and verification for periodic and write-before backups.

    The start is the conservative recovery bound, NOT verification completion:
    a concurrently-written online backup may represent an earlier point in time.
    """
    started = datetime.now(timezone.utc).isoformat()
    deadline = time.monotonic() + timeout
    diagnostics = diagnostics or BackupDiagnostics()
    if timeout <= 0 or copy_timeout <= 0:
        raise TimeoutError("SQLite backup deadline exhausted")
    database = Path(database).resolve(strict=True)
    identity = source_identity(database)
    backup_root = Path(backup_root).resolve()
    if not database.is_file():
        raise SystemExit("SQLite source is not a file")
    backup_root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = backup_root / f"{prefix}-{stamp}-{uuid.uuid4().hex[:8]}"
    directory.mkdir(exist_ok=False)
    backup = directory / "wewe-rss.db"

    # A pinned read snapshot prevents the online API from restarting on every
    # external commit. In rollback-journal mode its SHARED lock delays commits;
    # cap acquisition + copy at 45 seconds, within the 55-second total deadline,
    # and release BEFORE verification/hash. The app coordinator admits writers
    # before opening Prisma transactions, so their short clocks start afterward.
    # No journal-mode change, writer connection, or write transaction is used.
    diagnostics.enter("snapshot")
    copy_deadline = min(deadline, time.monotonic() + copy_timeout)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True,
                                 timeout=min(0.1, max(0.001, copy_deadline - time.monotonic())))) as source:
        source.execute("PRAGMA query_only=ON")
        source.set_progress_handler(lambda: int(time.monotonic() > copy_deadline), 1000)
        diagnostics.journal = source.execute("PRAGMA journal_mode").fetchone()[0]
        page_size=source.execute('PRAGMA page_size').fetchone()[0]
        if max_bytes is not None and source.execute('PRAGMA page_count').fetchone()[0]*page_size>max_bytes:
            raise ValueError('SQLITE_PERIODIC_RETENTION_RESERVE_EXCEEDED')
        if prefix != "periodic-snapshot":
            source.execute("BEGIN")
            # App admission happens before a connection/transaction opens.
            # Autonomous periodic copying must stay online, without a long read
            # lock that could conflict with short app transaction deadlines.
            source.execute("SELECT rootpage FROM sqlite_master LIMIT 1").fetchone()
        diagnostics.enter("copy")
        with closing(sqlite3.connect(backup, timeout=0.1)) as destination:
            def progress(status, _remaining, _total):
                diagnostics.copy_steps += 1
                diagnostics.busy_steps += int(status in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED))
                if time.monotonic() > copy_deadline:
                    raise TimeoutError("SQLite backup timed out")
                if max_bytes is not None and (_total*page_size>max_bytes or backup.stat().st_size>max_bytes):
                    raise ValueError('SQLITE_PERIODIC_RETENTION_RESERVE_EXCEEDED')

            source.backup(destination, pages=1000 if max_bytes is None else max(1,min(64,256*1024//page_size)), sleep=0.01, progress=progress)
    if max_bytes is not None and backup.stat().st_size>max_bytes:
        raise ValueError('SQLITE_PERIODIC_RETENTION_RESERVE_EXCEEDED')

    diagnostics.enter("verify")
    with closing(sqlite3.connect(backup.as_uri() + "?mode=ro", uri=True)) as verify:
        verify.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        verify.execute("PRAGMA query_only=ON")
        integrity = [row[0] for row in verify.execute("PRAGMA integrity_check")]
        feeds = verify.execute("SELECT COUNT(*) FROM feeds").fetchone()[0]
        articles = verify.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
    if integrity != ["ok"]:
        raise SystemExit("Backup integrity check failed; collection must not write")
    if time.monotonic() > deadline:
        raise TimeoutError("SQLite backup verification timed out")

    diagnostics.enter("hash")
    checksum = sha256(backup, deadline)
    if time.monotonic() > deadline:
        raise TimeoutError("SQLite backup hash timed out")
    diagnostics.enter("complete")
    report = {
        "startedAtUtc": started,
        "createdAtUtc": datetime.now(timezone.utc).isoformat(),
        "source": str(database),
        "backup": str(backup),
        "integrityCheck": "ok",
        "sha256": checksum,
        "feeds": feeds,
        "articles": articles,
        "diagnostics": diagnostics.report(),
        "sourceIdentity": identity if source_identity(database) == identity else None,
        "reused": False,
        "recoveryOrigin": {"format":"sqlite-recovery-origin-v1",
                           "kind":"periodic" if prefix == "periodic-snapshot" else "protected"},
    }
    if periodic_metadata is not None:
        if prefix != 'periodic-snapshot':raise ValueError('periodic metadata on protected copy')
        report['periodicLifecycle']=periodic_metadata
    (directory / "verification.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    receipt = backup_root / ('.latest-' + hashlib.sha256(str(database).encode()).hexdigest()[:24] + '.json')
    temporary = receipt.with_suffix('.tmp')
    temporary.write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
    temporary.replace(receipt)
    if periodic_metadata is not None:
        # State publication may only claim durable verified copy receipts.
        for file in (backup,directory/'verification.json',receipt):
            with file.open('r+b') as stream:os.fsync(stream.fileno())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--backup-root", type=Path, required=True)
    args = parser.parse_args()
    diagnostics = BackupDiagnostics()
    try:
        print(json.dumps(create_backup(args.database, args.backup_root,
                                       diagnostics=diagnostics), ensure_ascii=False))
    except Exception as error:
        # Raw exceptions/tracebacks can contain private paths or SQL. The caller
        # needs the failed stage, not those details. One bounded JSON record.
        print(json.dumps({"event": "sqlite-backup-failed",
                          "reason": ("timeout" if isinstance(error, TimeoutError) else
                                     "space-budget" if "SQLITE_SPACE_BUDGET_EXCEEDED" in str(error) else
                                     "layout-review" if "SQLITE_BACKUP_LAYOUT_REQUIRES_REVIEW" in str(error) else "failed"),
                          "diagnostics": diagnostics.report()}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
