"""One bounded periodic allocation; saved cadence is never a freshness lease.

All mutations require the existing full-snapshot OS lock. Retirement additionally
requires the owner lock and the existing exact, time-bound approval protocol.
An incomplete write/copy/delete stays held; there is deliberately no reset API.
"""
from contextlib import ExitStack, closing
from datetime import datetime
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sqlite3
import time
import uuid

FORMAT = 'sqlite-periodic-lifecycle-v1'
LIMIT = 128 * 1024
_retention = None


def retention():
    global _retention
    if _retention is None:
        spec = importlib.util.spec_from_file_location('daily_retention', Path(__file__).with_name('sqlite-retention-plan.py'))
        _retention = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_retention)
    return _retention


def fail(code='EVIDENCE_INVALID'):
    raise ValueError('SQLITE_PERIODIC_' + code)


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def interval(value=None):
    value = str(value if value is not None else os.environ.get('SQLITE_SNAPSHOT_INTERVAL_SECONDS', '900'))
    if not value.isascii() or not value.isdigit() or not 60 <= int(value) <= 86400:
        fail('POLICY_INVALID')
    return int(value)


def policy():
    # This version implements the approved three-point policy only. Increasing
    # a configuration value cannot silently issue a second staging allocation.
    if os.environ.get('SQLITE_PERIODIC_RETENTION_ENABLED', '0') != '0':
        fail('CONFIRMATION_REQUIRED')
    if os.environ.get('SQLITE_PERIODIC_RETENTION_COPIES', '3') != '3':
        fail('POLICY_INVALID')
    result = {'copies': 3, 'interval': interval()}
    for key, name, default, low, high in (
        ('bytes', 'SQLITE_PERIODIC_RETENTION_BYTES', 4*1024**3, 1, 32*1024**3),
        ('reserveBytes', 'SQLITE_PERIODIC_RETENTION_RESERVE_BYTES', 2*1024**3, 2*1024**2, 8*1024**3),
        ('readBytes', 'SQLITE_PERIODIC_RETENTION_READ_BYTES', 8*1024**3, 1, 16*1024**3)):
        raw = str(os.environ.get(name, default))
        if not raw.isascii() or not raw.isdigit() or not low <= int(raw) <= high:
            fail('POLICY_INVALID')
        result[key] = int(raw)
    return result


def paths(database, root):
    key = hashlib.sha256(str(database).encode()).hexdigest()[:24]
    base = root / ('.periodic-lifecycle-' + key)
    return Path(str(base) + '.init'), Path(str(base) + '.json')


def previously_enabled(database, root):
    if any(p.exists() for p in paths(database,root)):
        return True
    # Disabling configuration cannot turn a previously spent allocation into
    # legacy allowance, even after accidental removal of BOTH control files.
    for file in retention().backup.managed_files(root,time.monotonic()+5):
        if file.name=='verification.json':
            try:
                proof,_raw=bounded_json(file)
            except (ValueError,OSError):
                continue
            if proof.get('source')==str(database) and proof.get('periodicLifecycle'):
                return True
    return False


def bounded_json(file):
    r = retention()
    before = r.identity(file)
    if int(before[2]) > LIMIT or file.is_symlink() or file.stat().st_nlink != 1:
        fail()
    with file.open('rb') as stream:
        data = stream.read(LIMIT + 1)
    if len(data) > LIMIT or r.identity(file) != before:
        fail()
    return json.loads(data), data


def envelope(state):
    return encode({'payload': state, 'sha256': sha(encode(state))})


def point(receipt, database, root, budget):
    r = retention()
    proof = budget.json(receipt)
    if proof.get('integrityCheck')!='ok' or proof.get('source') != str(database) or proof.get('recoveryOrigin') != {
            'format': 'sqlite-recovery-origin-v1', 'kind': 'periodic'}:
        fail()
    file = r.local_path(proof['backup'])
    if (file.parent.parent != root or receipt != file.parent/'verification.json'
            or not r.re.fullmatch(r'periodic-snapshot-\d{8}T\d{6}Z-[a-f0-9]{8}', file.parent.name)
            or set(file.parent.iterdir()) != {file, receipt}):
        fail()
    for path in (file.parent, file, receipt):
        if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
            fail()
    if budget.sha(file) != proof.get('sha256'):
        fail()
    stamp=r.identity(file)
    if budget.used+file.stat().st_size>budget.maximum:
        fail('LIFECYCLE_HELD')
    budget.used+=file.stat().st_size
    with closing(sqlite3.connect(file.as_uri()+'?mode=ro&immutable=1',uri=True)) as db:
        db.set_progress_handler(lambda:int(time.monotonic()>budget.deadline),1000)
        if list(db.execute('PRAGMA integrity_check'))!=[('ok',)]:
            fail()
    if r.identity(file)!=stamp:
        fail()
    at = datetime.fromisoformat(proof['startedAtUtc'].replace('Z', '+00:00'))
    if at.tzinfo is None:
        fail()
    return {'path': str(file), 'identity': r.identity(file), 'sha256': proof['sha256'],
            'receipt': str(receipt), 'receiptIdentity': r.identity(receipt),
            'receiptSha256': budget.sha(receipt), 'at': at.timestamp()}


def inventory(database, root, budget):
    """Never infer origin from a folder name; incomplete legacy points stay held."""
    found = []
    for file in retention().backup.managed_files(root, budget.deadline):
        if file.name != 'verification.json':
            continue
        proof = budget.json(file)
        if (proof.get('source') == str(database) and proof.get('recoveryOrigin') == {
                'format': 'sqlite-recovery-origin-v1', 'kind': 'periodic'}):
            found.append(point(file, database, root, budget))
    return sorted(found, key=lambda x: (x['at'], x['path']))


class Store:
    """Fixed state object + immutable initialization identity, deny replacement.

    A short/partial state write fails its envelope on restart. Both control files
    and all copy artifacts remain in the same unchanged cumulative space budget.
    """
    def __init__(self, database, root, settings=None, create=False, writable=False):
        self.database, self.root = Path(database), Path(root)
        self.initfile, self.file = paths(self.database, self.root)
        self.stack = ExitStack()
        r = retention()
        try:
            if create and not self.initfile.exists() and not self.file.exists():
                budget = r.ReadBudget(settings['readBytes'], 20, ceiling=16*1024**3)
                points = inventory(self.database, self.root, budget)
                # Tagged copies prove an earlier lifecycle even if BOTH control
                # files were removed. They cannot be adopted as a new allowance.
                for p in points:
                    if budget.json(Path(p['receipt'])).get('periodicLifecycle'):
                        fail()
                sid = uuid.uuid4().hex
                fd = os.open(self.file, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    info = os.fstat(fd)
                    init = {'format': FORMAT, 'id': sid, 'source': str(self.database),
                            'sourceIdentity': r.directory_identity(self.database.parent) + r.identity(self.database)[:2],
                            'rootIdentity': r.directory_identity(self.root), 'policy': settings,
                            'stateObject': [str(info.st_dev), str(info.st_ino)]}
                    with self.initfile.open('xb') as stream:
                        stream.write(encode(init)); stream.flush(); os.fsync(stream.fileno())
                    state = {'format': FORMAT, 'id': sid, 'initSha256': sha(encode(init)),
                             'sequence': 0, 'status': 'ready', 'normal': points, 'pending': None,
                             'lastGenerationEpoch': max((p['at'] for p in points), default=0),
                             'allocation': None, 'lastRetirement': None}
                    raw = envelope(state)
                    if len(raw) > LIMIT:
                        fail()
                    os.write(fd, raw); os.fsync(fd)
                finally:
                    os.close(fd)
            init, initraw = bounded_json(self.initfile)
            value, raw = bounded_json(self.file)
            if (set(init) != {'format','id','source','sourceIdentity','rootIdentity','policy','stateObject'}
                    or init['format'] != FORMAT or init['source'] != str(self.database)
                    or init['rootIdentity'] != r.directory_identity(self.root)
                    or init['sourceIdentity'] != r.directory_identity(self.database.parent) + r.identity(self.database)[:2]
                    or init['stateObject'] != r.identity(self.file)[:2]
                    or (settings is not None and init['policy'] != settings)):
                fail()
            state = value['payload']
            if (set(value) != {'payload','sha256'} or value['sha256'] != sha(encode(state))
                    or set(state) != {'format','id','initSha256','sequence','status','normal','pending',
                                     'lastGenerationEpoch','allocation','lastRetirement'}
                    or state['format'] != FORMAT or state['id'] != init['id']
                    or state['initSha256'] != sha(initraw)
                    or type(state['sequence']) is not int or state['sequence'] < 0
                    or state['status'] not in ('ready','copy-intent','pending-confirmation','retirement-started','releasing')
                    or not isinstance(state['normal'], list) or len(state['normal']) > 48
                    or type(state['lastGenerationEpoch']) not in (int,float)
                    or not math.isfinite(state['lastGenerationEpoch'])):
                fail()
            if not isinstance(init['policy'],dict) or set(init['policy'])!={'copies','interval','bytes','reserveBytes','readBytes'} or init['policy']['copies']!=3:
                fail()
            interval(init['policy']['interval'])
            for name,maximum in (('bytes',32*1024**3),('reserveBytes',8*1024**3),('readBytes',16*1024**3)):
                if type(init['policy'][name]) is not int or not 1<=init['policy'][name]<=maximum:
                    fail()
            if state['pending'] is not None and not isinstance(state['pending'],dict):
                fail()
            for p in state['normal']+([state['pending']] if state['pending'] is not None else []):
                if (not isinstance(p,dict) or set(p)!={'path','identity','sha256','receipt','receiptIdentity','receiptSha256','at'}
                        or type(p['at']) not in (int,float) or not math.isfinite(p['at']) or p['at']<=0
                        or not all(isinstance(p[x],str) for x in ('path','receipt','sha256','receiptSha256'))
                        or not all(isinstance(p[x],list) and len(p[x])==5 and all(isinstance(v,str) and v.isdigit() for v in p[x])
                                   for x in ('identity','receiptIdentity'))):
                    fail()
            a=state['allocation']
            if a is not None and (not isinstance(a,dict) or set(a)!={'identity','sha256','sequence'}
                    or type(a['sequence']) is not int or a['sequence']!=state['sequence']
                    or not isinstance(a['identity'],list) or len(a['identity'])!=5
                    or not isinstance(a['sha256'],str) or not r.re.fullmatch('[a-f0-9]{64}',a['sha256'])):
                fail()
            if ((state['status']=='ready' and (a is not None or state['pending'] is not None))
                    or (state['status'] in ('pending-confirmation','retirement-started','releasing') and a is None)
                    or (state['status'] in ('pending-confirmation','retirement-started') and state['pending'] is None)):
                fail()
            last=state['lastRetirement']
            if last is not None and (not isinstance(last,dict) or set(last)!={'batchId','digest','approvalSha256','previous'}
                    or not isinstance(last['batchId'],str)
                    or not all(isinstance(last[x],str) and r.re.fullmatch('[a-f0-9]{64}',last[x]) for x in ('digest','approvalSha256'))
                    or (last['previous'] is not None and not r.re.fullmatch('[a-f0-9]{64}',str(last['previous'])))):
                fail()
            self.state, self.init, self.raw = state, init, raw
            self.writable = writable
            if os.name == 'nt':
                for directory in sorted({*self.root.parents, self.root, *self.database.parent.parents, self.database.parent},
                                        key=lambda p: (len(p.parts), str(p))):
                    self.stack.enter_context(r.WindowsPin(directory, r.directory_identity(directory), directory=True))
                self.stack.enter_context(r.WindowsPin(self.initfile, r.identity(self.initfile), sharing=1))
                self.pin = self.stack.enter_context(r.WindowsPin(self.file, r.identity(self.file),
                                                                sharing=0 if writable else 1, writable=writable))
                self.fd = self.pin.fd
            else:
                self.stream = self.stack.enter_context(self.file.open('r+b' if writable else 'rb'))
                import fcntl
                fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.fd = self.stream.fileno()
            if self.read() != raw or bounded_json(self.initfile)[1] != initraw:
                fail()
        except BaseException:
            self.stack.close()
            raise

    def read(self):
        if os.fstat(self.fd).st_size > LIMIT:
            fail()
        os.lseek(self.fd, 0, os.SEEK_SET)
        return os.read(self.fd, LIMIT + 1)

    def save(self):
        if not self.writable or self.read() != self.raw:
            fail()
        raw = envelope(self.state)
        if len(raw) > LIMIT:
            fail()
        # Truncate and durably invalidate BEFORE replacement bytes. Merely
        # overwriting a prefix can leave the previous valid JSON after a short
        # write (the canonical envelopes share a prefix), restoring old credit.
        os.ftruncate(self.fd, 0); os.fsync(self.fd)
        os.lseek(self.fd, 0, os.SEEK_SET)
        if os.write(self.fd, raw) != len(raw):
            fail()
        os.ftruncate(self.fd, len(raw)); os.fsync(self.fd)
        if self.read() != raw:
            fail()
        self.raw = raw

    def verify_points(self, budget):
        expected = self.state['normal'] + ([self.state['pending']] if self.state['pending'] else [])
        found = inventory(self.database, self.root, budget)
        if sorted(expected, key=lambda p: p['path']) != sorted(found, key=lambda p: p['path']):
            fail()
        if self.state['lastGenerationEpoch']!=max((p['at'] for p in expected),default=0):
            fail()

    def binding(self):
        return {'stateSha256': sha(self.raw), 'initSha256': self.state['initSha256'],
                'stateObject': self.init['stateObject'], 'id': self.state['id']}

    def status(self):
        s = self.state
        return {'status': s['status'], 'normalCopies': len(s['normal']),
                'pendingCopies': int(s['pending'] is not None), 'maximumNormalCopies': 3,
                'maximumPendingCopies': 1, 'intervalSeconds': self.init['policy']['interval'],
                'nextGenerationAtEpoch': s['lastGenerationEpoch'] + self.init['policy']['interval'],
                'automaticDeletion': False}

    def close(self):
        self.stack.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def marker(store):
    r = retention()
    a = store.state['allocation']
    file = store.root/'.space-budget.lock'
    value, raw = bounded_json(file)
    if (not a or r.identity(file) != a['identity'] or sha(raw) != a['sha256']
            or value != {'format': FORMAT, 'id': store.state['id'], 'sequence': a['sequence']}):
        fail()
    return file, a['identity']


def release_marker(store):
    file, stamp = marker(store)
    r = retention()
    if os.name != 'nt':
        # Creation/reuse works on POSIX, but irreversible release/retirement has
        # no pathname fallback. Conservative hold is safer than impersonation.
        fail('NATIVE_RELEASE_REQUIRED')
    with r.WindowsPin(file, stamp, delete=True) as pin:
        if pin.sha(r.ReadBudget(LIMIT, 2)) != store.state['allocation']['sha256']:
            fail()
        pin.delete()


def create(backup, database, root, timeout, diagnostics, copy_timeout, now=None):
    settings = policy()
    now = time.time() if now is None else now
    if not math.isfinite(now) or now <= 0:
        fail()
    deadline = time.monotonic() + timeout
    root.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(str(database).encode()).hexdigest()[:24]
    with backup.FileLock(database.parent/f'.full-snapshot-{key}.lock', timeout=min(timeout,30)) as lock:
        with Store(database, root, settings, create=True, writable=True) as store:
            budget = retention().ReadBudget(settings['readBytes'], 20, ceiling=16*1024**3)
            store.verify_points(budget)
            s = store.state
            if s['status'] not in ('ready','pending-confirmation'):
                fail('LIFECYCLE_HELD')
            if s['status'] == 'pending-confirmation':
                marker(store)
            elif s['allocation'] is not None or s['pending'] is not None or (root/'.space-budget.lock').exists():
                fail()
            if now < s['lastGenerationEpoch']:
                fail('LIFECYCLE_HELD')
            # A persistent timestamp never supplies proof. Even pending points
            # can be reused only after the independent complete existing proof.
            reused = backup.reusable(database, root, deadline, allow_periodic=True)
            if reused:
                return {**reused, 'periodicLifecycleStatus': store.status()}
            if s['pending'] or len(s['normal']) > 3:
                fail('PENDING_CONFIRMATION')
            if now < s['lastGenerationEpoch'] + settings['interval']:
                fail('NOT_DUE')
            # No reserve exemption: staging and protected/legacy points must
            # all fit the SAME original global byte/count/free-space ceilings.
            backup.space_preflight(database, root, deadline)
            s['sequence'] += 1
            s['status'] = 'copy-intent'
            store.save()  # Credit is spent BEFORE creating marker or copy.
            lease = root/'.space-budget.lock'
            raw = encode({'format': FORMAT, 'id': s['id'], 'sequence': s['sequence']})
            with lease.open('xb') as stream:
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
            s['allocation'] = {'identity': retention().identity(lease), 'sha256': sha(raw), 'sequence': s['sequence']}
            store.save()
            backup.space_preflight(database, root, deadline)
            report = backup._create_backup(database, root, 'periodic-snapshot', deadline-time.monotonic(), diagnostics,
                copy_timeout, max_bytes=settings['reserveBytes']-1024**2,
                periodic_metadata={'format': FORMAT, 'id': s['id'], 'sequence': s['sequence']})
            p = point(Path(report['backup']).parent/'verification.json', database, root,
                      retention().ReadBudget(settings['readBytes'],20,ceiling=16*1024**3))
            lock.check()
            s['lastGenerationEpoch'] = p['at']
            if len(s['normal']) < 3 and sum(int(x['identity'][2]) for x in s['normal']) + int(p['identity'][2]) <= settings['bytes']:
                s['normal'].append(p)
                s['status'] = 'releasing'
                store.save()
                release_marker(store)
                s['allocation'] = None
                s['status'] = 'ready'
            else:
                s['pending'] = p
                s['status'] = 'pending-confirmation'
            store.save()
            return {**report, 'diagnostics': diagnostics.report(), 'periodicLifecycleStatus': store.status()}


def read_status(database, root):
    first, second = paths(database, root)
    if not first.exists() and not second.exists():
        return None
    try:
        with Store(database, root) as store:
            return store.status()
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError):
        return {'status': 'held', 'automaticDeletion': False}


def plan_binding(database, root):
    with Store(database, root) as store:
        if store.state['status'] != 'pending-confirmation':
            fail('PENDING_CONFIRMATION')
        file, stamp = marker(store)
        return store.binding(), stamp, store.state['normal'][0]['path'], store.state['pending']


def execute(plan, approval, resources, now, read_bytes, protected_paths, policy, r):
    """Explicit exact action; all old native proofs remain mandatory."""
    if os.name != 'nt':
        fail('NATIVE_RELEASE_REQUIRED')
    p = plan['payload']; database = Path(p['database']); root = Path(p['root'])
    key = hashlib.sha256(str(database).encode()).hexdigest()[:24]
    with ExitStack() as stack:
        full = stack.enter_context(r.backup.FileLock(database.parent/f'.full-snapshot-{key}.lock'))
        owner = stack.enter_context(r.backup.FileLock(database.parent/f'.snapshot-{key}.lock'))
        store = stack.enter_context(Store(database,root,writable=True))
        if store.binding() != p['periodicLifecycle'] or store.state['status'] != 'pending-confirmation':
            fail()
        budget = r.ReadBudget(read_bytes,20)
        store.verify_points(budget)
        file, stamp = marker(store)
        pin = stack.enter_context(r.WindowsPin(file,stamp,delete=True))
        if pin.sha(budget) != store.state['allocation']['sha256']:
            fail()
        for lock in (full, owner):
            stack.enter_context(r.WindowsPin(lock.path,r.identity(lock.path),sharing=3))
        r.pin_rotation_references(stack,plan)
        checked = r.validate_batch(plan,approval,resources,now,read_bytes,protected_paths,policy,owned_lease=stamp)
        entries = checked['validated']; s = store.state
        if (checked['skipped'] or len(entries) != 1 or not s['normal']
                or entries[0]['path'] != s['normal'][0]['path']
                or entries[0]['representative'] != s['pending']['path']):
            fail()
        # Exact history-loss approval is necessary but does not waive preservation
        # of durable old typed rows, generated values, notes or metrics.
        old, new = Path(entries[0]['path']), Path(s['pending']['path'])
        with closing(sqlite3.connect(new.as_uri()+'?mode=ro&immutable=1',uri=True)) as a, \
             closing(sqlite3.connect(old.as_uri()+'?mode=ro&immutable=1',uri=True)) as b:
            for db in (a,b):
                db.set_progress_handler(lambda:int(time.monotonic()>budget.deadline),1000)
                db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
            if not r.backup.snapshot_covers(a,b,budget):
                fail('UNIQUE_HISTORY_HELD')
        other = next((x for x in reversed(s['normal']) if x['path'] != str(old)),None)
        if other is None:
            fail()
        with closing(sqlite3.connect(Path(other['path']).as_uri()+'?mode=ro&immutable=1',uri=True)) as db:
            db.set_progress_handler(lambda:int(time.monotonic()>budget.deadline),1000)
            if list(db.execute('PRAGMA integrity_check')) != [('ok',)]:
                fail()
        s['status'] = 'retirement-started'
        s['lastRetirement'] = {'batchId':plan['batchId'],'digest':plan['digest'],
                               'approvalSha256':sha(encode(approval)), 'previous':s['lastRetirement'] and sha(encode(s['lastRetirement']))}
        store.save()  # An unknown deletion outcome can never regain this credit.
        def check():
            full.check(); owner.check(); budget.tick()
            at = int(time.time()) if now is None else now
            if (not r.generation_clear(root,stamp) or store.read() != store.raw
                    or not 0 <= at-approval['approvedAtEpoch'] <= 300 or at > p['expiresAtEpoch']
                    or not 0 <= at-resources['checkedAtEpoch'] <= 60):
                fail()
        check()
        result = r._delete_pinned_points(plan,entries,stack,budget,check,
                                         [(other['path'],other['identity'],other['sha256'])])
        if result['status'] != 'complete':
            return result
        remaining=s['normal'][1:]
        combined=remaining+[s['pending']]
        if (len(combined)>3 or sum(int(x['identity'][2]) for x in combined)>store.init['policy']['bytes']):
            # A completed exact retirement need not resolve a byte overage.
            # Keep THIS pending allocation until another distinct exact review;
            # a new fourth copy is never a substitute for resolving the hold.
            s['normal']=remaining
            s['status']='pending-confirmation'
            store.save()
            return result
        s['normal'] = combined
        s['pending'] = None
        s['status'] = 'releasing'
        store.save()
        check()
        pin.delete()  # The same pinned allocation, never a pathname fallback.
        s['allocation'] = None
        s['status'] = 'ready'
        store.save()
        return result
