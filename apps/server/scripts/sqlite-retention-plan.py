"""Bounded data-read-only maintenance planning and explicit batch validation.

Default planning/validation never deletes data. Explicit Windows execution is
limited to approved, pinned old periodic snapshots in this managed root.
"""
import argparse
from contextlib import closing, ExitStack
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import time
import uuid

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('backup-sqlite.py'))
backup = importlib.util.module_from_spec(spec); spec.loader.exec_module(backup)
FORMAT = 'sqlite-retention-review-v1'
MAX_REPORT_BYTES = 256 * 1024
MAX_REPORTS = 3
POLICY_DEFAULTS = {'maxOrdinaryCopies':48,'maxOrdinaryBytes':32*1024**3,'keepLatest':2,'minimumAgeHours':1,
                   'roundDays':7,'recentHours':24,'bucketHours':2,'dailyDays':7,
                   'weeklyWeeks':4,'maximumAgeDays':28,'warningPercent':80,
                   'reserveCopies':16,'expectedGenerationsPerDay':6}

class MaintenanceError(ValueError):
    pass

def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()

def digest(value):
    return hashlib.sha256(canonical_json(value)).hexdigest()

def identity(file):
    stat = file.stat()
    if not file.is_file() or not stat.st_ino:
        raise MaintenanceError('FILE_IDENTITY_UNPROVED')
    return [str(stat.st_dev), str(stat.st_ino), str(stat.st_size), str(stat.st_mtime_ns), str(stat.st_ctime_ns)]

def directory_identity(directory):
    info=directory.stat()
    if not directory.is_dir() or not info.st_ino:raise MaintenanceError('DIRECTORY_IDENTITY_UNPROVED')
    return [str(info.st_dev),str(info.st_ino)]

def generation_clear(root, owned_lease=None):
    lease=root/'.space-budget.lock'
    if owned_lease is None:return not lease.exists()
    return lease.exists() and identity(lease)==owned_lease

def periodic_artifacts(entry,root,retired,budget):
    file=Path(entry['path']);receipt=Path(entry['receipt']);folder=file.parent
    if (file!=local_path(str(file)) or folder.parent!=root or str(file) not in retired
        or not re.fullmatch(r'periodic-snapshot-\d{8}T\d{6}Z-[a-f0-9]{8}',folder.name)
        or receipt!=folder/'verification.json' or set(folder.iterdir())!={file,receipt}
        or directory_identity(folder)!=entry['directoryIdentity'] or str(folder)!=entry['directory']):
        raise MaintenanceError('PERIODIC_ARTIFACT_SCOPE_CHANGED')
    for path in (root,folder,file,receipt):
        if path.is_symlink() or (hasattr(path,'is_junction') and path.is_junction()):raise MaintenanceError('PERIODIC_LINK_REFUSED')
    if (entry['receipt']!=retired[str(file)]['receipt'] or entry['sha256']!=retired[str(file)]['sha256']
        or entry['createdAtEpoch']!=retired[str(file)]['at'] or entry['bytes']!=file.stat().st_size
        or identity(receipt)!=entry['receiptIdentity']
        or budget.sha(receipt)!=entry['receiptSha256']):raise MaintenanceError('PERIODIC_RECEIPT_CHANGED')

def local_path(value):
    if not isinstance(value, str) or not Path(value).is_absolute() or value.startswith(('\\\\', '//')) or any(c in value for c in '\0\r\n'):
        raise MaintenanceError('INVALID_LOCAL_PATH')
    return Path(value).resolve()

def finite(value, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise MaintenanceError('INVALID_FINITE_POLICY')
    return value


def retention_policy(value):
    """Explicit opt-in. A count is a target, never permission to discard a protected window."""
    if value is None:return None
    if not isinstance(value,dict) or set(value)-set(POLICY_DEFAULTS):raise MaintenanceError('INVALID_RETENTION_POLICY')
    result={**POLICY_DEFAULTS,**value}
    limits={'maxOrdinaryCopies':(2,256),'maxOrdinaryBytes':(1,128*1024**3),'keepLatest':(2,16),'minimumAgeHours':(1,168),
            'roundDays':(1,31),'recentHours':(1,168),'bucketHours':(1,24),'dailyDays':(1,90),
            'weeklyWeeks':(0,52),'maximumAgeDays':(1,365),'warningPercent':(10,99),
            'reserveCopies':(2,128),'expectedGenerationsPerDay':(1,96)}
    for key,(low,high) in limits.items():finite(result[key],low,high)
    if (result['keepLatest']>result['maxOrdinaryCopies'] or result['bucketHours']>result['recentHours']
        or result['maximumAgeDays']<max(result['roundDays'],result['dailyDays'],result['weeklyWeeks']*7)
        or result['minimumAgeHours']>result['maximumAgeDays']*24):raise MaintenanceError('INCONSISTENT_RETENTION_POLICY')
    return result


def policy_refs(database,root,files,databases,refs,records,budget,now,policy,periodic_only=False):
    if policy is None:return {},{}
    points={};inventory=[]
    for p in databases:inventory.append({'path':str(p),'identity':identity(p)})
    for p in files:
        if p.name!='verification.json':continue
        try:
            r=budget.json(p);target=local_path(r['backup']);origin=r.get('recoveryOrigin',{})
            if (target not in databases or target.parent!=p.parent.resolve() or not target.is_relative_to(root)
                or str(local_path(r['source']))!=str(database) or r.get('integrityCheck')!='ok'
                or not re.fullmatch('[a-f0-9]{64}',r.get('sha256',''))
                or origin.get('format')!='sqlite-recovery-origin-v1' or origin.get('kind') not in ('write-before','periodic')):continue
            if periodic_only and (origin['kind']!='periodic' or target.parent.parent!=root):continue
            expected='before-collection' if origin['kind']=='write-before' else 'periodic-snapshot'
            if not re.fullmatch(expected+r'-\d{8}T\d{6}Z-[a-f0-9]{8}',target.parent.name):continue
            date=datetime.fromisoformat(r['createdAtUtc'].replace('Z','+00:00'))
            if date.tzinfo is None or int(date.timestamp())>now:continue
            at=int(date.timestamp());path=str(target)
            inventory.append({'receipt':str(p),'identity':identity(p),'contentDigest':digest(r)})
            if periodic_only or path not in refs:points[path]={'at':at,'kind':origin['kind'],'receipt':str(p),
                                            'receiptIdentity':identity(p),'sha256':r['sha256']}
        except MaintenanceError:raise
        except (KeyError,ValueError,OSError):continue
    ordered=sorted(points,key=lambda p:(points[p]['at'],p),reverse=True);keep={}
    if periodic_only:keep.update({p:refs[p] for p in points if p in refs})
    def retain(path,reason):keep.setdefault(path,reason)
    for path in ordered[:policy['keepLatest']]:retain(path,'latest ordinary recovery points')
    buckets=set()
    for path in ordered:
        r=points[path];age=now-r['at']
        if age<policy['minimumAgeHours']*3600:retain(path,'minimum recovery age')
        if r['kind']=='write-before' and age<policy['roundDays']*86400:retain(path,'write-before recovery window')
        for tier,horizon,width in (('recent',policy['recentHours']*3600,policy['bucketHours']*3600),
                                   ('daily',policy['dailyDays']*86400,86400),
                                   ('weekly',policy['weeklyWeeks']*7*86400,7*86400)):
            if age<horizon:
                key=(tier,age//width)
                if key not in buckets:retain(path,tier+' recovery representative');buckets.add(key)
    # Fill unused slots with the newest remaining ordinary points, within maximum age.
    # Mandatory windows may exceed the target; warn rather than silently weaken recovery.
    for path in ordered:
        used=sum(Path(p).stat().st_size for p in keep)
        if (len(keep)<policy['maxOrdinaryCopies'] and used+Path(path).stat().st_size<=policy['maxOrdinaryBytes']
            and now-points[path]['at']<policy['maximumAgeDays']*86400):retain(path,'ordinary count/byte allowance')
    retired={p:r for p,r in points.items() if p not in keep}
    refs.update(keep)
    records.append({'retentionPolicy':policy,'inventoryDigest':digest(sorted(inventory,key=lambda x:canonical_json(x))),
                    'retained':sorted(keep),'retirement':sorted(retired)})
    retained_bytes=sum(Path(p).stat().st_size for p in keep)
    return retired,{'ordinaryCopies':len(points),'retainedOrdinaryCopies':len(keep),'retainedOrdinaryBytes':retained_bytes,
                    'ordinaryTargetExceeded':len(keep)>policy['maxOrdinaryCopies'],
                    'ordinaryByteTargetExceeded':retained_bytes>policy['maxOrdinaryBytes'],
                    'retirementCount':len(retired),'requiresExactUniqueHistoryApproval':bool(retired)}

class ReadBudget:
    def __init__(self, maximum=64*1024**2, seconds=10, ceiling=4*1024**3):
        self.maximum = finite(maximum, 1, ceiling)
        self.used = 0
        self.deadline = time.monotonic() + finite(seconds, 1, 20)
        self.hashes = {}
    def tick(self):
        if time.monotonic() > self.deadline:
            raise MaintenanceError('SCAN_DEADLINE')
    def json(self, path):
        self.tick()
        size = path.stat().st_size
        if size > 128*1024 or self.used + size > self.maximum:
            raise MaintenanceError('READ_BUDGET_EXCEEDED')
        self.used += size
        return json.loads(path.read_text(encoding='utf-8-sig'))
    def sha(self, path):
        self.tick()
        before = identity(path)
        key = (str(path), tuple(before))
        if key in self.hashes: return self.hashes[key]
        if self.used + path.stat().st_size > self.maximum:
            return None
        result = hashlib.sha256()
        with path.open('rb') as stream:
            while chunk := stream.read(1024**2):
                self.tick(); self.used += len(chunk); result.update(chunk)
                if self.used > self.maximum: raise MaintenanceError('READ_BUDGET_EXCEEDED')
        if identity(path) != before: raise MaintenanceError('FILE_CHANGED_DURING_READ')
        self.hashes[key] = result.hexdigest()
        return result.hexdigest()

def bounded_files(root, budget):
    registration=backup.legacy_registration(root);allowed=registration['roots'];files=[];seen=set();active=set()
    def visit(directory):
        budget.tick();canonical=directory.resolve(strict=True)
        if canonical in active:raise MaintenanceError('CYCLIC_DIRECTORY')
        if canonical in seen:return
        seen.add(canonical);active.add(canonical)
        if len(seen)>4096:raise MaintenanceError('SCAN_DIRECTORY_LIMIT')
        for file in directory.iterdir():
            budget.tick()
            linked=file.is_symlink() or (hasattr(file,'is_junction') and file.is_junction())
            if linked and (not file.is_dir() or not backup.legacy_link_allowed(file.resolve(strict=True),registration)):
                raise MaintenanceError('UNLISTED_LINK')
            if file.is_dir():visit(file)
            elif file.is_file():
                files.append(file.resolve(strict=True))
                if len(files)>4096:raise MaintenanceError('SCAN_FILE_LIMIT')
        active.remove(canonical)
    if root.exists():visit(root)
    for folder in allowed:
        if folder not in seen:visit(folder)
    if backup.legacy_registration(root)!=registration:raise MaintenanceError('LEGACY_REGISTRATION_CHANGED')
    return list(dict.fromkeys(files))

def files_and_refs(root, budget, protected_paths=()):
    files = bounded_files(root,budget)
    state = root / '.retention-review'
    data_files = [p for p in files if p.suffix.lower() in ('.db', '.sqlite', '.sqlite3')]
    refs = {str(local_path(p)): 'explicit deployment/migration/identity protection' for p in protected_paths}
    reference_roots={root.resolve(),*backup.legacy_roots()}
    reference_records = [{'declaredRoots':sorted(str(p) for p in reference_roots)}]
    registration=backup.legacy_registration(root)
    if registration['record']:reference_records.append(registration['record'])
    for p in files:
        budget.tick()
        if p.parent in reference_roots and (p.name.startswith(('snapshot-owner-','refresh-recovery-owner-','.latest-'))) and p.suffix.lower() == '.json':
            r = budget.json(p)
            target = local_path(r.get('backup'))
            refs[str(target)] = 'current owner/latest receipt'
            reference_records.append({'file':str(p), 'backup':str(target), 'sha256':r.get('sha256'), 'source':r.get('source') or r.get('databasePath')})
    for p in data_files:
        if re.search(r'identity|migration|rollback|release|deploy|manual|protected|人工|发布|迁移|回退', p.parent.name, re.I):
            refs[str(p)] = 'conservative boundary-name protection'
    for p in files:
        if p.parent in reference_roots and p.name=='retention-protected.json':
            r=budget.json(p)
            if r.get('format')!='sqlite-retention-protected-v1' or not isinstance(r.get('paths'),list) or len(r['paths'])>256:
                raise MaintenanceError('INVALID_PROTECTION_MANIFEST')
            targets=[local_path(x) for x in r['paths']]
            if any(not any(x.is_relative_to(folder) for folder in reference_roots) for x in targets):raise MaintenanceError('PROTECTION_OUTSIDE_ROOTS')
            for x in targets:refs[str(x)]='explicit manual/release protection manifest'
            reference_records.append({'protectionManifest':str(p),'identity':identity(p),'contentDigest':digest(r)})
    # Re-read trustworthy same-source receipts every time references are checked.
    # This also covers an old producer that does not yet publish .latest files.
    newest = {}
    for p in files:
        if p.name != 'verification.json': continue
        try:
            r=budget.json(p);target=local_path(r['backup'])
            if target not in data_files or target.parent!=p.parent.resolve() or r.get('integrityCheck')!='ok' or not re.fullmatch('[a-f0-9]{64}',r.get('sha256','')):continue
            if r.get('recoveryOrigin',{}).get('format')=='sqlite-recovery-origin-v1' and r['recoveryOrigin'].get('kind')=='protected':
                refs[str(target)]='explicit high-risk recovery boundary'
                reference_records.append({'protectedReceipt':str(p),'identity':identity(p),'contentDigest':digest(r)})
            source=str(local_path(r['source']))
            stamp=datetime.fromisoformat(r['createdAtUtc'].replace('Z','+00:00'))
            if stamp.tzinfo is None:continue
            key=(stamp.timestamp(),str(target))
            if source not in newest or key>newest[source][0]:newest[source]=(key,target)
        except MaintenanceError:raise
        except (KeyError,ValueError,OSError):continue
    for source,(_key,target) in newest.items():
        refs[str(target)]='latest verified receipt per source'
        reference_records.append({'source':source,'latestReceiptBackup':str(target)})
    reference_records.sort(key=lambda r:canonical_json(r))
    return files, data_files, refs, reference_records, state

def make_plan(database, root, now=None, protected_paths=(), read_bytes=64*1024**2, seconds=10, age_days=7, policy=None, periodic_only=False, owned_lease=None):
    database, root = local_path(str(database)), local_path(str(root))
    if database.is_relative_to(root): raise MaintenanceError('NESTED_SOURCE_DESTINATION')
    if any(database.is_relative_to(p) for p in backup.legacy_roots()):raise MaintenanceError('NESTED_SOURCE_LEGACY_ROOT')
    now = int(time.time()) if now is None else finite(now, 1, 2**53)
    age_days = finite(age_days, 1, 365)
    policy=retention_policy(policy)
    if periodic_only and policy is None:raise MaintenanceError('EXPLICIT_PERIODIC_POLICY_REQUIRED')
    budget = ReadBudget(read_bytes, seconds)
    files, databases, refs, records, _state = files_and_refs(root, budget, protected_paths)
    paused = not generation_clear(root,owned_lease)
    receipt_by_backup = {}
    for p in files:
        if p.name != 'verification.json': continue
        try:
            r = budget.json(p)
            target = local_path(r['backup'])
            if target not in databases or target.parent != p.parent.resolve() or not re.fullmatch('[a-f0-9]{64}', r.get('sha256','')) or r.get('integrityCheck') != 'ok':
                continue
            source = str(local_path(r['source']))
            date = datetime.fromisoformat(r['createdAtUtc'].replace('Z','+00:00'))
            if date.tzinfo is None or int(date.timestamp()) > now: continue
            receipt_by_backup[str(target)] = {'source':source,'sha256':r['sha256'],'at':int(date.timestamp()),'receipt':str(p),
                                            'origin':r.get('recoveryOrigin',{}).get('kind')}
        except MaintenanceError:raise
        except (KeyError, ValueError, OSError):
            continue
    newest = {}
    for path, receipt in receipt_by_backup.items():
        if receipt['source'] not in newest or receipt['at'] > newest[receipt['source']][0]:
            newest[receipt['source']] = (receipt['at'], path)
    for _at, path in newest.values(): refs[path] = 'latest verified receipt per source'
    retired,tier_summary=policy_refs(database,root,files,databases,refs,records,budget,now,policy,periodic_only)
    ref_digest = digest({'records':records, 'protected':sorted(refs)})
    candidates, held = [], []
    groups = {}
    for p in databases:
        r = receipt_by_backup.get(str(p))
        if r: groups.setdefault((r['source'],r['sha256'],p.stat().st_size),[]).append(p)
    representatives = {}
    for key, group in groups.items():
        representative = next((p for p in group if str(p) in refs), max(group, key=lambda p:receipt_by_backup[str(p)]['at']))
        representatives[key] = representative
    for p in sorted(databases):
        budget.tick(); stamp = identity(p); size = p.stat().st_size; path = str(p)
        if len(candidates) >= 128: held.append({'path':path,'reason':'batch-size-limit'});continue
        if paused or path in refs:
            held.append({'path':path,'reason':'generation-in-progress' if paused else refs[path]});continue
        if any(Path(path+suffix).exists() for suffix in ('-wal','-shm','-journal')):
            held.append({'path':path,'reason':'SQLite sidecar present; retained'});continue
        r = receipt_by_backup.get(path)
        if periodic_only:
            if path not in retired:
                held.append({'path':path,'reason':'not an eligible old managed periodic point'});continue
            receipt=Path(retired[path]['receipt'])
            if set(p.parent.iterdir())!={p,receipt}:
                held.append({'path':path,'reason':'unknown sibling artifacts; retained'});continue
            keepers=[Path(k) for k,v in receipt_by_backup.items() if k in refs and v['source']==str(database)
                     and v['origin']=='periodic' and Path(k).parent.parent==root]
            if not keepers:raise MaintenanceError('PERIODIC_RECOVERY_REPRESENTATIVE_UNPROVED')
            keeper=max(keepers,key=lambda k:receipt_by_backup[str(k)]['at']);keeper_receipt=receipt_by_backup[str(keeper)]
            receipt_sha=budget.sha(receipt)
            if receipt_sha is None:raise MaintenanceError('READ_BUDGET_EXCEEDED')
            candidates.append({'path':path,'identity':stamp,'bytes':size,'kind':'retention-expired',
                               'sha256':r['sha256'],'source':r['source'],'createdAtEpoch':r['at'],
                               'receipt':str(receipt),'receiptIdentity':identity(receipt),'receiptSha256':receipt_sha,
                               'directory':str(p.parent),'directoryIdentity':directory_identity(p.parent),
                               'representative':str(keeper),'representativeIdentity':identity(keeper),
                               'representativeSha256':keeper_receipt['sha256'],
                               'evidence':'old managed periodic point outside configured count/byte/time retention; exact history-loss approval required'})
        elif size == 0:
            if now - p.stat().st_mtime < 3600 or list(x for x in p.parent.iterdir() if x != p):
                held.append({'path':path,'reason':'fresh or sibling artifacts'});continue
            candidates.append({'path':path,'identity':stamp,'bytes':0,'kind':'empty','sha256':hashlib.sha256(b'').hexdigest(),
                               'representative':None,'evidence':'empty file; resource and reference recheck still required'})
        elif not r:
            held.append({'path':path,'reason':'unknown provenance/verification; retained'})
        else:
            key = (r['source'],r['sha256'],size)
            keeper = representatives[key]
            if keeper != p:
                a = budget.sha(p); b = budget.sha(keeper)
                if a is not None and b is not None and (a != r['sha256'] or b != a):
                    held.append({'path':path,'reason':'receipt checksum mismatch; retained'});continue
                candidates.append({'path':path,'identity':stamp,'bytes':size,'kind':'duplicate','sha256':r['sha256'],
                                   'representative':str(keeper),'representativeIdentity':identity(keeper),
                                   'evidence':'sha-checked' if a is not None and b is not None else 'requires-bounded-sha-check'})
            elif path in retired:
                keeper=Path(newest[r['source']][1]);keeper_receipt=receipt_by_backup[str(keeper)]
                candidates.append({'path':path,'identity':stamp,'bytes':size,'kind':'retention-expired',
                                   'sha256':r['sha256'],'source':r['source'],'createdAtEpoch':r['at'],
                                   'receipt':retired[path]['receipt'],'receiptIdentity':retired[path]['receiptIdentity'],
                                   'representative':str(keeper),'representativeIdentity':identity(keeper),
                                   'representativeSha256':keeper_receipt['sha256'],
                                   'evidence':'outside configured count/time tiers; UNIQUE historical state may be lost'})
            elif now-r['at'] >= age_days*86400:
                held.append({'path':path,'identity':stamp,'bytes':size,'kind':'expired-review','sha256':r['sha256'],
                             'representative':newest[r['source']][1],
                             'reason':'age is not proof of invalidity; unique-state loss needs separate specific review'})
            else:
                held.append({'path':path,'reason':'within recovery window'})
    # Changed live references or a new generation lease invalidate this scan.
    _f, _d, new_refs, new_records, _s = files_and_refs(root, budget, protected_paths)
    for _at,path in newest.values(): new_refs[path]='latest verified receipt per source'
    policy_refs(database,root,_f,_d,new_refs,new_records,budget,now,policy,periodic_only)
    if digest({'records':new_records,'protected':sorted(new_refs)}) != ref_digest or (not generation_clear(root,owned_lease)) != paused:
        raise MaintenanceError('REFERENCES_CHANGED_DURING_SCAN')
    prefix = 'SQLITE_TEST' if os.environ.get('SQLITE_BACKUP_KIND') == 'test' else 'SQLITE_PRODUCTION'
    maximum = backup.positive(prefix+'_MAX_BYTES', 512*1024**2 if prefix=='SQLITE_TEST' else 32*1024**3)
    copies = backup.positive(prefix+'_MAX_COPIES',12 if prefix=='SQLITE_TEST' else 48)
    used = sum(p.stat().st_size for p in files)
    source_bytes=database.stat().st_size if database.exists() else max((x.stat().st_size for x in databases),default=1)
    wal=Path(str(database)+'-wal');reserved=2*(source_bytes+(wal.stat().st_size if wal.exists() else 0))+1024**2
    free=shutil.disk_usage(root).free
    minimum=backup.positive(prefix+'_MIN_FREE_BYTES',256*1024**2 if prefix=='SQLITE_TEST' else 4*1024**3)
    headroom=max(0,min(copies-len(databases),(maximum-used-reserved)//max(source_bytes,1)+1,
                       (free-minimum-reserved)//max(source_bytes,1)+1))
    alarms=[];threshold=policy['warningPercent']/100 if policy else .5
    if used>=maximum*threshold or len(databases)>=copies*threshold:alarms.append('capacity-threshold')
    if headroom<=(policy['reserveCopies'] if policy else 2):alarms.append('generation-reserve')
    if tier_summary.get('ordinaryTargetExceeded'):alarms.append('protected-time-windows-exceed-count-target')
    if tier_summary.get('ordinaryByteTargetExceeded'):alarms.append('protected-time-windows-exceed-byte-target')
    rate=policy['expectedGenerationsPerDay'] if policy else 96
    if headroom/rate<3:alarms.append('less-than-three-days-at-configured-rate')
    payload = {'format':FORMAT,'root':str(root),'database':str(database),'createdAtEpoch':now,'expiresAtEpoch':now+86400,
               'referenceDigest':ref_digest,'referenceRecords':records,'protected':refs,'candidates':candidates,'held':held,
                'policy':{'maxBytes':maximum,'maxCopies':copies,'ageDays':age_days,'retention':policy,
                          **({'periodicOnly':True,'referenceConcurrency':'current-publishers-and-pinned-manifests-v1'} if periodic_only else {})},
               'summary':{'existingBytes':used,'existingCopies':len(databases),'readBytes':budget.used,
                          'candidateCount':len(candidates),'candidateBytes':sum(x['bytes'] for x in candidates),
                          'generationInProgress':paused,'warning':bool(alarms),'warningReasons':alarms,
                          'headroomGenerations':headroom,'estimatedDaysAtConfiguredRate':round(headroom/rate,2),
                          'configuredGenerationsPerDay':rate,'nextReservedBytes':reserved,**tier_summary,
                          'automaticDeletion':False}}
    if periodic_only:payload['rootIdentity']=directory_identity(root)
    checksum = digest(payload)
    return {'batchId':f'retention-{now}-{checksum[:16]}','digest':checksum,'payload':payload}

def write_owned_json(path, value):
    encoded = canonical_json(value)
    if len(encoded) > MAX_REPORT_BYTES: raise MaintenanceError('REPORT_BYTE_LIMIT')
    temporary = path.parent / ('.planner-'+uuid.uuid4().hex+'.tmp')
    handle = os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
    stat = os.fstat(handle); key = (stat.st_dev,stat.st_ino)
    try:
        with os.fdopen(handle,'wb') as stream: stream.write(encoded)
        temporary.replace(path)
    finally:
        if temporary.exists() and (temporary.stat().st_dev,temporary.stat().st_ino)==key:
            temporary.unlink()  # Only this attempt's registered metadata temp.

def persist_plan(plan):
    root = local_path(plan['payload']['root']); state = root/'.retention-review'
    if state.exists() and (state.is_symlink() or (hasattr(state,'is_junction') and state.is_junction())):
        raise MaintenanceError('REPORT_DIRECTORY_LINK')
    state.mkdir(exist_ok=True)
    with backup.FileLock(state/'.planner.lock',timeout=0):
        index_path=state/'owned-index.json'
        if index_path.exists() and index_path.stat().st_size>MAX_REPORT_BYTES:raise MaintenanceError('REPORT_BYTE_LIMIT')
        index=json.loads(index_path.read_text(encoding='utf-8')) if index_path.exists() else {'format':'sqlite-retention-owned-v1','files':[]}
        if index.get('format')!='sqlite-retention-owned-v1':raise MaintenanceError('REPORT_OWNERSHIP_UNPROVED')
        if len(index['files'])>MAX_REPORTS:raise MaintenanceError('INVALID_REPORT_INDEX')
        # Never evict unknown files, operator approvals or data recovery points.
        known=[]
        for entry in index['files']:
            name=entry['name']
            if not re.fullmatch(r'retention-\d+-[a-f0-9]{16}\.json',name): raise MaintenanceError('INVALID_REPORT_INDEX')
            p=state/name
            if p.exists():
                stamp=identity(p)
                if stamp[:2] != entry['identity'][:2]: raise MaintenanceError('REPORT_IDENTITY_CHANGED')
                if p.stat().st_size>MAX_REPORT_BYTES:raise MaintenanceError('REPORT_BYTE_LIMIT')
                data=json.loads(p.read_text(encoding='utf-8'))
                if data.get('digest') != digest(data.get('payload')) or data['payload'].get('format')!=FORMAT:
                    raise MaintenanceError('REPORT_OWNERSHIP_UNPROVED')
                known.append(entry)
        status_path=state/'latest-status.json'
        if status_path.exists():
            if status_path.stat().st_size>MAX_REPORT_BYTES:raise MaintenanceError('REPORT_BYTE_LIMIT')
            status=json.loads(status_path.read_text(encoding='utf-8'))
            if status.get('format')!='sqlite-retention-status-v1' or not any(x['name']==status.get('batchId','')+'.json' for x in known):
                raise MaintenanceError('REPORT_OWNERSHIP_UNPROVED')
        output=state/(plan['batchId']+'.json')
        if any(x['name']==output.name for x in known):
            if json.loads(output.read_text(encoding='utf-8')) != plan:raise MaintenanceError('REPORT_COLLISION')
            return output
        while len(known) >= MAX_REPORTS:
            entry=known.pop(0)
            (state/entry['name']).unlink()  # Owned review metadata only, never .db.
        write_owned_json(output,plan)
        known.append({'name':output.name,'identity':identity(output)})
        write_owned_json(index_path,{'format':'sqlite-retention-owned-v1','files':known})
        write_owned_json(status_path,{'format':'sqlite-retention-status-v1','batchId':plan['batchId'],'digest':plan['digest'],**plan['payload']['summary']})
    return output

def validate_batch(plan, approval, resource_report, now=None, read_bytes=64*1024**2, protected_paths=(), policy=None, owned_lease=None):
    now=int(time.time()) if now is None else now
    p=plan.get('payload',{})
    if p.get('format')!=FORMAT or plan.get('digest')!=digest(p): raise MaintenanceError('BATCH_DIGEST_MISMATCH')
    policy=retention_policy(policy)
    if p.get('policy',{}).get('retention')!=policy:raise MaintenanceError('RETENTION_POLICY_CHANGED')
    periodic_only=p.get('policy',{}).get('periodicOnly') is True
    if periodic_only and policy is None:raise MaintenanceError('EXPLICIT_PERIODIC_POLICY_REQUIRED')
    action='rotate-exact-periodic-backups' if periodic_only else 'permanent-delete-exact-files'
    if approval.get('batchId')!=plan['batchId'] or approval.get('digest')!=plan['digest'] or approval.get('action')!=action:
        raise MaintenanceError('EXACT_ACTION_TIME_APPROVAL_REQUIRED')
    approved_at=approval.get('approvedAtEpoch')
    if not isinstance(approved_at,int) or isinstance(approved_at,bool) or not p['createdAtEpoch']<=approved_at<=now or now-approved_at>300 or now>p['expiresAtEpoch']:
        raise MaintenanceError('APPROVAL_EXPIRED_OR_INVALID')
    paths=[x['path'] for x in p['candidates']]
    if len(paths)>128 or len(paths)!=len(set(paths)) or sorted(approval.get('paths',[]))!=sorted(paths): raise MaintenanceError('APPROVAL_SCOPE_MISMATCH')
    if periodic_only and (sorted(approval.get('metadataPaths',[]))!=sorted(x['receipt'] for x in p['candidates'])
        or sorted(approval.get('directories',[]))!=sorted(x['directory'] for x in p['candidates'])):
        raise MaintenanceError('EXACT_PERIODIC_METADATA_APPROVAL_REQUIRED')
    unique=[x['path'] for x in p['candidates'] if x['kind']=='retention-expired']
    if unique and sorted(approval.get('uniqueHistoryPaths',[]))!=sorted(unique):
        raise MaintenanceError('EXACT_UNIQUE_HISTORY_LOSS_APPROVAL_REQUIRED')
    if resource_report.get('batchId')!=plan['batchId'] or resource_report.get('digest')!=plan['digest'] or not 0<=now-resource_report.get('checkedAtEpoch',0)<=60:
        raise MaintenanceError('FRESH_BOUND_RESOURCE_CHECK_REQUIRED')
    root=local_path(p['root']);budget=ReadBudget(read_bytes,20)
    if periodic_only and directory_identity(root)!=p.get('rootIdentity'):raise MaintenanceError('ROOT_IDENTITY_CHANGED')
    database=local_path(p['database'])
    if database.is_relative_to(root) or any(database.is_relative_to(x) for x in backup.legacy_roots()):
        raise MaintenanceError('NESTED_SOURCE_DESTINATION')
    _files,_db,refs,records,_state=files_and_refs(root,budget,protected_paths)
    retired,_tier=policy_refs(database,root,_files,_db,refs,records,budget,now,policy,periodic_only)
    # Latest same-source protections established by the plan are also retained.
    refs.update(p['protected'])
    if periodic_only and records!=p.get('referenceRecords'):raise MaintenanceError('BOUND_REFERENCE_RECORDS_CHANGED')
    if digest({'records':records,'protected':sorted(refs)})!=p['referenceDigest'] or not generation_clear(root,owned_lease):
        raise MaintenanceError('LIVE_REFERENCES_OR_GENERATION_CHANGED')
    resource_files=resource_report.get('files',[])
    resources={x['path']:x for x in resource_files}
    if len(resources)!=len(resource_files):raise MaintenanceError('AMBIGUOUS_RESOURCE_PROOF')
    valid=[];skipped=[]
    for entry in p['candidates']:
        try:
            file=local_path(entry['path'])
            if periodic_only:
                if entry['kind']!='retention-expired' or entry['representative'] in paths:raise MaintenanceError('PERIODIC_SCOPE_REQUIRED')
                periodic_artifacts(entry,root,retired,budget)
                keep=local_path(entry['representative'])
                if str(keep) not in refs or keep.parent.parent!=root:raise MaintenanceError('PERIODIC_RECOVERY_REPRESENTATIVE_UNPROVED')
                proof=budget.json(keep.parent/'verification.json')
                if (proof.get('recoveryOrigin')!={'format':'sqlite-recovery-origin-v1','kind':'periodic'}
                    or local_path(proof['source'])!=database or local_path(proof['backup'])!=keep
                    or proof.get('integrityCheck')!='ok' or proof.get('sha256')!=entry['representativeSha256']):
                    raise MaintenanceError('PERIODIC_RECOVERY_REPRESENTATIVE_UNPROVED')
            if not (file.is_relative_to(root) or any(file.is_relative_to(x) for x in backup.legacy_roots())): raise MaintenanceError('PATH_OUTSIDE_ROOT')
            if str(file) in refs or identity(file)!=entry['identity']:raise MaintenanceError('FILE_CHANGED_OR_PROTECTED')
            if any(Path(str(file)+s).exists() for s in ('-wal','-shm','-journal')):raise MaintenanceError('SQLITE_SIDECAR_PRESENT')
            check=resources.get(str(file),{})
            if check.get('querySucceeded') is not True or check.get('users')!=[]:raise MaintenanceError('RESOURCE_CHECK_UNPROVED')
            actual=budget.sha(file)
            if actual is None or actual!=entry['sha256']:raise MaintenanceError('CHECKSUM_UNPROVED')
            if entry['kind']=='empty':
                if file.stat().st_size or list(x for x in file.parent.iterdir() if x!=file):raise MaintenanceError('EMPTY_ARTIFACT_CHANGED')
            elif entry['kind'] in ('duplicate','retention-expired'):
                if entry['kind']=='retention-expired':
                    if str(file) not in retired or identity(local_path(entry['receipt']))!=entry['receiptIdentity']:
                        raise MaintenanceError('RETENTION_ELIGIBILITY_CHANGED')
                keep=local_path(entry['representative']);check=resources.get(str(keep),{})
                if not (keep.is_relative_to(root) or any(keep.is_relative_to(x) for x in backup.legacy_roots())) or keep==file:raise MaintenanceError('INVALID_REPRESENTATIVE')
                if identity(keep)!=entry['representativeIdentity'] or check.get('querySucceeded') is not True or check.get('users')!=[]:raise MaintenanceError('REPRESENTATIVE_CHANGED_OR_OCCUPIED')
                if any(Path(str(keep)+s).exists() for s in ('-wal','-shm','-journal')):raise MaintenanceError('SQLITE_SIDECAR_PRESENT')
                expected=actual if entry['kind']=='duplicate' else entry['representativeSha256']
                if budget.sha(keep)!=expected:raise MaintenanceError('REPRESENTATIVE_CHECKSUM_UNPROVED')
                # Reserve another file-size pass before SQLite's bounded check.
                if budget.used+keep.stat().st_size>budget.maximum:raise MaintenanceError('QUICK_CHECK_BUDGET_EXCEEDED')
                budget.used+=keep.stat().st_size
                with closing(sqlite3.connect(keep.as_uri()+'?mode=ro&immutable=1',uri=True,timeout=.1)) as db:
                    db.execute('PRAGMA query_only=ON');db.set_progress_handler(lambda:int(time.monotonic()>budget.deadline),1000)
                    if list(db.execute('PRAGMA quick_check'))!=[('ok',)]:raise MaintenanceError('REPRESENTATIVE_INVALID')
                if identity(keep)!=entry['representativeIdentity']:raise MaintenanceError('REPRESENTATIVE_CHANGED_DURING_CHECK')
            else:raise MaintenanceError('UNIQUE_HISTORY_LOSS_REQUIRES_SEPARATE_REVIEW')
            if identity(file)!=entry['identity']:raise MaintenanceError('FILE_CHANGED_DURING_CHECK')
            valid.append(entry)
        except (ValueError,OSError,sqlite3.Error) as error:
            skipped.append({'path':entry['path'],'reason':str(error) if isinstance(error,MaintenanceError) else 'CHECK_FAILED'})
    _f,_d,final_refs,final_records,_s=files_and_refs(root,budget,protected_paths)
    policy_refs(database,root,_f,_d,final_refs,final_records,budget,now,policy,periodic_only)
    final_refs.update(p['protected'])
    if digest({'records':final_records,'protected':sorted(final_refs)})!=p['referenceDigest'] or not generation_clear(root,owned_lease):
        raise MaintenanceError('LIVE_REFERENCES_OR_GENERATION_CHANGED')
    return {'batchId':plan['batchId'],'validated':valid,'skipped':skipped,'permanentDeletionPerformed':False,
            'executorMustRecheckVerifiedHandles':True}

class WindowsPin:
    """Delete the verified object by handle, never by a re-resolved pathname."""
    def __init__(self,path,expected,directory=False,delete=False,sharing=0):
        if os.name!='nt':raise MaintenanceError('VERIFIED_ROTATION_REQUIRES_WINDOWS')
        import ctypes
        from ctypes import wintypes
        import msvcrt
        self.api=ctypes.WinDLL('kernel32',use_last_error=True);self.fd=None
        create=self.api.CreateFileW
        create.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,wintypes.LPVOID,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
        create.restype=wintypes.HANDLE
        # Directories deny rename. Selected data is exclusive; reference readers
        # and existing OS lock streams use explicit non-delete sharing modes.
        access=(0 if directory else 0x80000000)|(0x10000 if delete else 0)
        if sharing not in (0,1,3):raise MaintenanceError('UNSAFE_PIN_SHARING')
        handle=create(str(path),access,3 if directory else sharing,None,3,0x00200000|(0x02000000 if directory else 0),None)
        if handle==wintypes.HANDLE(-1).value:raise MaintenanceError('EXCLUSIVE_OBJECT_PIN_FAILED')
        try:self.fd=msvcrt.open_osfhandle(handle,os.O_RDONLY|os.O_BINARY)
        except BaseException:
            self.api.CloseHandle.argtypes=[wintypes.HANDLE];self.api.CloseHandle(handle);raise
        try:
            info=os.fstat(self.fd)
            actual=[str(info.st_dev),str(info.st_ino)]
            # Windows pathname stat keeps creation time in its legacy ctime
            # field; fstat can expose change time there. Bind creation explicitly.
            if not directory:actual += [str(info.st_size),str(info.st_mtime_ns),str(getattr(info,'st_birthtime_ns',info.st_ctime_ns))]
            if (actual!=expected or info.st_file_attributes&0x400 or (not directory and info.st_nlink!=1)):
                raise MaintenanceError('PINNED_OBJECT_CHANGED_OR_LINKED')
        except BaseException:self.close();raise

    def sha(self,budget):
        budget.tick();info=os.fstat(self.fd)
        if budget.used+info.st_size>budget.maximum:raise MaintenanceError('READ_BUDGET_EXCEEDED')
        checksum=hashlib.sha256();os.lseek(self.fd,0,os.SEEK_SET)
        while chunk:=os.read(self.fd,1024**2):
            budget.tick();budget.used+=len(chunk);checksum.update(chunk)
        return checksum.hexdigest()

    def delete(self):
        import ctypes
        from ctypes import wintypes
        import msvcrt
        dispose=self.api.SetFileInformationByHandle
        dispose.argtypes=[wintypes.HANDLE,ctypes.c_int,wintypes.LPVOID,wintypes.DWORD];dispose.restype=wintypes.BOOL
        flag=ctypes.c_ubyte(1)  # FILE_DISPOSITION_INFO.DeleteFile is BOOLEAN.
        if not dispose(msvcrt.get_osfhandle(self.fd),4,ctypes.byref(flag),ctypes.sizeof(flag)):
            raise MaintenanceError('VERIFIED_OBJECT_DELETE_FAILED')
        self.close()  # Deletion applies to this exact handle on close.

    def close(self):
        if self.fd is not None:
            fd,self.fd=self.fd,None;os.close(fd)

    def __enter__(self):return self
    def __exit__(self,*_args):self.close()


def pin_rotation_references(stack,plan):
    """Freeze supported manual publishers; producer publication is OS-locked.

    No missing-file placeholder is created: absence cannot be pinned. A real
    protection manifest must already exist in every scanned reference root.
    """
    p=plan['payload'];roots={local_path(p['root']),*backup.legacy_roots()}
    records=p['referenceRecords'];manifests={r['protectionManifest']:r for r in records if 'protectionManifest' in r}
    paths={r[key] for r in records for key in ('file','protectedReceipt','registrationManifest') if key in r}
    if len(paths)+len(manifests)>256:raise MaintenanceError('REFERENCE_PIN_LIMIT')
    key=hashlib.sha256(p['database'].encode()).hexdigest()[:24]
    publisher_names={f'.latest-{key}.json',f'snapshot-owner-{key}.json'}
    for record in records:
        if (record.get('source') not in (None,p['database'])
            or ('file' in record and (Path(record['file']).name not in publisher_names or record.get('source')!=p['database']))):
            raise MaintenanceError('UNSUPPORTED_REFERENCE_PUBLISHER')
    for root in roots:
        manifest=root/'retention-protected.json';record=manifests.get(str(manifest))
        if record is None:raise MaintenanceError('PREEXISTING_PROTECTION_MANIFEST_REQUIRED')
        stack.enter_context(WindowsPin(manifest,record['identity'],sharing=1))
    # Existing diagnostics/references remain readable for validation but cannot
    # be edited, replaced or removed for the lifetime of this critical section.
    for path in sorted(paths):stack.enter_context(WindowsPin(Path(path),identity(Path(path)),sharing=1))


def _delete_pinned_points(plan,entries,stack,budget,check,extra_pins=()):
    """Shared irreversible boundary; every caller must establish its own authority."""
    output={'batchId':plan['batchId'],'deleted':[],'deletedMetadata':[],'removedDirectories':[],
            'attempted':[],'permanentDeletionPerformed':False,'status':'complete'}
    pins=[];keepers={}
    def keep(file,stamp,checksum):
        if file not in keepers:
            stack.enter_context(WindowsPin(Path(file).parent,directory_identity(Path(file).parent),directory=True))
            keepers[file]=stack.enter_context(WindowsPin(Path(file),stamp))
            if keepers[file].sha(budget)!=checksum:raise MaintenanceError('PINNED_RECOVERY_CHECKSUM_CHANGED')
    for file,stamp,checksum in extra_pins:keep(file,stamp,checksum)
    for entry in entries:
        keep(entry['representative'],entry['representativeIdentity'],entry['representativeSha256'])
        folder=stack.enter_context(WindowsPin(Path(entry['directory']),entry['directoryIdentity'],directory=True,delete=True))
        data=stack.enter_context(WindowsPin(Path(entry['path']),entry['identity'],delete=True))
        receipt=stack.enter_context(WindowsPin(Path(entry['receipt']),entry['receiptIdentity'],delete=True))
        if data.sha(budget)!=entry['sha256'] or receipt.sha(budget)!=entry['receiptSha256']:
            raise MaintenanceError('PINNED_PERIODIC_CHECKSUM_CHANGED')
        if any(Path(entry['path']+s).exists() for s in ('-wal','-shm','-journal')):
            raise MaintenanceError('SQLITE_SIDECAR_PRESENT')
        pins.append((entry,data,receipt,folder))
    check()
    for entry,data,receipt,folder in pins:
        try:
            budget.tick();check()
            for key,path,pin in (('deleted',entry['path'],data),('deletedMetadata',entry['receipt'],receipt),
                                 ('removedDirectories',entry['directory'],folder)):
                output['attempted'].append(path);pin.delete();output[key].append(path)
                output['permanentDeletionPerformed']=True
        except (OSError,ValueError):
            completed=sum(len(output[k]) for k in ('deleted','deletedMetadata','removedDirectories'))
            uncertain=len(output['attempted'])>completed
            output.update(status='partial-failed',deletionOutcomeUncertain=uncertain)
            if uncertain and not output['permanentDeletionPerformed']:output['permanentDeletionPerformed']=None
            break
    return output


def automatic_after_snapshot(owner):
    """Private actual-owner continuation, not a CLI/approval bypass.

    The enabled policy permits ONLY covered periodic points. Manual unique-state
    retirement still requires its existing exact human approval and resource proof.
    """
    settings=backup.periodic_retention_policy()
    if settings is None:return {'status':'disabled','code':'DISABLED','deletedCopies':0}
    record=owner.record
    if not record:raise MaintenanceError('AUTO_VERIFIED_OWNER_REQUIRED')
    generation=record['snapshotGeneration']
    if getattr(owner,'retention_attempted_generation',None)==generation:
        return record.get('automaticRetention',{'status':'held','code':'ALREADY_ATTEMPTED','deletedCopies':0})
    owner.retention_attempted_generation=generation
    result={'status':'held','code':'AUTO_RETENTION_HELD','deletedCopies':0,'heldUnique':0,'heldOther':0}
    root=local_path(str(owner.backup_root));database=local_path(str(owner.database));current=local_path(record['backup'])
    owned=None
    try:
        if os.name!='nt':raise MaintenanceError('VERIFIED_ROTATION_REQUIRES_WINDOWS')
        if os.environ.get('SQLITE_ARTICLE_HISTORY_MAINTENANCE_WINDOW')=='1':raise MaintenanceError('HISTORY_MAINTENANCE_ACTIVE')
        protected=json.loads(os.environ.get('SQLITE_RETENTION_PROTECTED_PATHS','[]'))
        if not isinstance(protected,list):raise MaintenanceError('INVALID_PROTECTED_PATHS')
        protected=[*protected,str(current),str(database)]
        owner.lock.check()
        if owner.lock.stream.closed or local_path(owner.source.execute('PRAGMA database_list').fetchone()[2])!=database:
            raise MaintenanceError('AUTO_VERIFIED_OWNER_REQUIRED')
        policy=retention_policy({'maxOrdinaryCopies':settings['copies'],'maxOrdinaryBytes':settings['bytes'],
                                 'keepLatest':2,'minimumAgeHours':1,'roundDays':1,'recentHours':1,'bucketHours':1,
                                 'dailyDays':1,'weeklyWeeks':0,'maximumAgeDays':1,'reserveCopies':2,'expectedGenerationsPerDay':96})
        budget=ReadBudget(settings['readBytes'],20,ceiling=16*1024**3)
        with ExitStack() as stack:
            key=hashlib.sha256(str(database).encode()).hexdigest()[:24]
            full=stack.enter_context(backup.FileLock(database.parent/f'.full-snapshot-{key}.lock',timeout=0))
            lease=root/'.space-budget.lock'
            if not lease.exists():
                if getattr(owner,'retention_lease_identity',None) is not None:raise MaintenanceError('AUTO_LEASE_CHANGED')
                with lease.open('x',encoding='utf-8') as stream:
                    json.dump({'format':'sqlite-periodic-retention-lease-v1','pid':os.getpid(),'source':str(database)},stream)
                    stream.flush();os.fsync(stream.fileno())
            elif identity(lease)!=getattr(owner,'retention_lease_identity',None):
                raise MaintenanceError('AUTO_LEASE_CHANGED')
            if lease.stat().st_size>8192:raise MaintenanceError('AUTO_LEASE_INVALID')
            saved=json.loads(lease.read_text(encoding='utf-8'))
            if saved.get('format')!='sqlite-periodic-retention-lease-v1' or saved.get('source')!=str(database) or saved.get('pid')!=os.getpid():
                raise MaintenanceError('AUTO_LEASE_INVALID')
            owned=identity(lease)
            plan=make_plan(database,root,protected_paths=protected,policy=policy,periodic_only=True,owned_lease=owned,seconds=5)
            p=plan['payload']
            result['protectedOrUnknown']=len(p['held'])
            registrations=[Path(r['registrationManifest']).parent for r in p['referenceRecords'] if 'registrationManifest' in r]
            directories={d for r in (root,database.parent,*backup.legacy_roots(),*registrations) for d in (r,*r.parents)}
            for folder in sorted(directories,key=lambda d:(len(d.parts),str(d))):
                stack.enter_context(WindowsPin(folder,directory_identity(folder),directory=True))
            for held in (full,owner.lock):stack.enter_context(WindowsPin(held.path,identity(held.path),sharing=3))
            pin_rotation_references(stack,plan)
            files,databases,refs,records,_=files_and_refs(root,budget,protected)
            retired,_summary=policy_refs(database,root,files,databases,refs,records,budget,int(time.time()),policy,True)
            refs.update(p['protected'])
            if records!=p['referenceRecords'] or digest({'records':records,'protected':sorted(refs)})!=p['referenceDigest']:
                raise MaintenanceError('BOUND_REFERENCE_RECORDS_CHANGED')
            current_stamp=identity(current)
            if list(map(str,record['backupFingerprint']))!=current_stamp:raise MaintenanceError('AUTO_OWNER_POINT_CHANGED')
            if any(Path(str(current)+s).exists() for s in ('-wal','-shm','-journal')):raise MaintenanceError('AUTO_OWNER_POINT_CHANGED')
            # Two distinct, independently checked recovery files before ANY deletion.
            previous=None
            if p['candidates']:
                for receipt in files:
                    if receipt.name!='verification.json':continue
                    try:proof=budget.json(receipt);target=local_path(proof.get('backup',''))
                    except (OSError,ValueError):continue
                    if (target==current or str(target) not in refs or target.parent!=receipt.parent
                        or proof.get('source')!=str(database) or proof.get('integrityCheck')!='ok'):continue
                    if any(Path(str(target)+s).exists() for s in ('-wal','-shm','-journal')):continue
                    try:
                        stamp=identity(target)
                        with WindowsPin(target,stamp,sharing=1) as pin:
                            if pin.sha(budget)!=proof.get('sha256'):continue
                            if budget.used+target.stat().st_size>budget.maximum:raise MaintenanceError('READ_BUDGET_EXCEEDED')
                            budget.used+=target.stat().st_size
                            with closing(sqlite3.connect(target.as_uri()+'?mode=ro&immutable=1',uri=True)) as db:
                                db.set_progress_handler(lambda:int(time.monotonic()>budget.deadline),1000)
                                if list(db.execute('PRAGMA integrity_check'))!=[('ok',)]:continue
                                schema=list(db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name'))
                                if hashlib.sha256(json.dumps(schema,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()!=record['schemaSha256']:continue
                        previous=(str(target),stamp,proof['sha256']);break
                    except (OSError,ValueError,sqlite3.Error):continue
                if previous is None:raise MaintenanceError('TWO_VERIFIED_RECOVERY_POINTS_REQUIRED')
            covered=[]
            result['heldOther']+=max(0,len(p['candidates'])-8)
            for entry in p['candidates'][:8]:
                # Leave enough of this SAME bounded budget to rehash every
                # deletion handle and both recovery points. Otherwise a late
                # proof must not consume the budget needed by the commit step.
                reserved=(2*current.stat().st_size+5*entry['bytes']
                          +(Path(previous[0]).stat().st_size if previous else 0)
                          +sum(e['bytes']+4096 for e in covered)+8192)
                if budget.used+reserved>budget.maximum:
                    result['heldOther']+=len(p['candidates'])-len(covered)-result['heldUnique']-result['heldOther'];break
                try:
                    periodic_artifacts(entry,root,retired,budget)
                    file=local_path(entry['path'])
                    if any(Path(str(file)+s).exists() for s in ('-wal','-shm','-journal')):raise MaintenanceError('SQLITE_SIDECAR_PRESENT')
                    with WindowsPin(current,current_stamp,sharing=1) as new_pin,WindowsPin(file,entry['identity'],sharing=1) as old_pin:
                        if new_pin.sha(budget)!=record['sha256'] or old_pin.sha(budget)!=entry['sha256']:
                            raise MaintenanceError('CHECKSUM_UNPROVED')
                        with closing(sqlite3.connect(current.as_uri()+'?mode=ro&immutable=1',uri=True)) as new,\
                             closing(sqlite3.connect(file.as_uri()+'?mode=ro&immutable=1',uri=True)) as old:
                            for db in (new,old):
                                db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH,32*1024**2)
                                db.set_progress_handler(lambda:int(time.monotonic()>budget.deadline),1000)
                                db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
                            if not backup.snapshot_covers(new,old,budget):
                                result['heldUnique']+=1;continue
                    covered.append({**entry,'representative':str(current),'representativeIdentity':current_stamp,
                                    'representativeSha256':record['sha256']})
                except (OSError,ValueError,sqlite3.Error):result['heldOther']+=1
            def check():
                budget.tick();full.check();owner.lock.check()
                if owner.record is not record or not generation_clear(root,owned):raise MaintenanceError('AUTO_OWNER_OR_LEASE_CHANGED')
            check()
            outcome=_delete_pinned_points(plan,covered,stack,budget,check,[previous] if previous and covered else ())
            result['deletedCopies']=len(outcome['deleted'])
            deleted_bytes=sum(e['bytes'] for e in covered if e['path'] in outcome['deleted'])
            result['targetExceeded']=(p['summary']['ordinaryCopies']-result['deletedCopies']>settings['copies']
                or p['summary']['retainedOrdinaryBytes']+sum(e['bytes'] for e in p['candidates'])-deleted_bytes>settings['bytes'])
            if outcome['status']!='complete':
                result.update(code='AUTO_DELETE_UNCERTAIN',deletionOutcomeUncertain=outcome.get('deletionOutcomeUncertain',True))
                return result
        # Close native data handles before counting. Return to the original hard
        # stored-data cap before releasing this one staging allocation. A future
        # copy may use one new slot only after this cycle restored the hard cap.
        with backup.FileLock(database.parent/f'.full-snapshot-{key}.lock',timeout=0) as full:
            files=backup.managed_files(root,budget.deadline)
            test=os.environ.get('SQLITE_BACKUP_KIND')=='test';prefix='SQLITE_TEST' if test else 'SQLITE_PRODUCTION'
            maximum=backup.positive(prefix+'_MAX_BYTES',512*1024**2 if test else 32*1024**3)
            copies=backup.positive(prefix+'_MAX_COPIES',12 if test else 48)
            minimum=backup.positive(prefix+'_MIN_FREE_BYTES',256*1024**2 if test else 4*1024**3)
            if (sum(f.stat().st_size for f in files)+8192>maximum
                or sum(f.suffix.lower() in ('.db','.sqlite','.sqlite3') for f in files)>copies
                or shutil.disk_usage(root).free-8192<minimum):raise MaintenanceError('SQLITE_SPACE_BUDGET_EXCEEDED')
            full.check();owner.lock.check()
            if not generation_clear(root,owned):raise MaintenanceError('AUTO_OWNER_OR_LEASE_CHANGED')
            lease.unlink()
        result.update(status='held' if result['heldUnique'] or result['heldOther'] or result['targetExceeded'] else 'complete',
                      code='UNIQUE_HISTORY_RETAINED' if result['heldUnique'] else 'CANDIDATES_HELD' if result['heldOther']
                      else 'PROTECTED_WINDOWS_RETAINED' if result['targetExceeded'] else 'COMPLETE')
        return result
    except (OSError,ValueError,sqlite3.Error) as error:
        code=str(error) if isinstance(error,MaintenanceError) else backup.safe_backup_failure(error,'rotation')['code']
        result['code']=code if re.fullmatch('[A-Z_]{1,80}',code) else 'AUTO_RETENTION_HELD'
        return result


def execute_periodic_batch(plan,approval,resource_report,now=None,read_bytes=64*1024**2,protected_paths=(),policy=None):
    if plan.get('payload',{}).get('policy',{}).get('periodicOnly') is not True:
        raise MaintenanceError('PERIODIC_ROTATION_PLAN_REQUIRED')
    if plan['payload']['policy'].get('referenceConcurrency')!='current-publishers-and-pinned-manifests-v1':
        raise MaintenanceError('REFERENCE_CONCURRENCY_PLAN_REQUIRED')
    result=validate_batch(plan,approval,resource_report,now,read_bytes,protected_paths,policy)
    if result['skipped']:raise MaintenanceError('ROTATION_BATCH_NOT_FULLY_PROVED')
    if os.name!='nt':raise MaintenanceError('VERIFIED_ROTATION_REQUIRES_WINDOWS')
    p=plan['payload'];root=local_path(p['root']);database=local_path(p['database'])
    if not database.is_file():raise MaintenanceError('ACTIVE_SOURCE_MISSING')
    output={'batchId':plan['batchId'],'deleted':[],'deletedMetadata':[],'removedDirectories':[],
            'attempted':[],'permanentDeletionPerformed':False,'status':'complete'}
    with ExitStack() as stack:
        # Pin all ancestor directories before locks or deletions; no junctions.
        registrations=[Path(r['registrationManifest']).parent for r in p['referenceRecords'] if 'registrationManifest' in r]
        directories={d for r in (root,database.parent,*backup.legacy_roots(),*registrations) for d in (r,*r.parents)}
        for directory in sorted(directories,key=lambda d:(len(d.parts),str(d))):
            stack.enter_context(WindowsPin(directory,directory_identity(directory),directory=True))
        lock_name=hashlib.sha256(str(database).encode()).hexdigest()[:24]
        lock=stack.enter_context(backup.FileLock(database.parent/f'.full-snapshot-{lock_name}.lock',timeout=0))
        # The guard publishes after create_backup returns and can renew an
        # unchanged owner without a new copy. Its lifetime lock must be ours too.
        owner_lock=stack.enter_context(backup.FileLock(database.parent/f'.snapshot-{lock_name}.lock',timeout=0))
        for held_lock in (lock,owner_lock):
            stack.enter_context(WindowsPin(held_lock.path,identity(held_lock.path),sharing=3))
        pin_rotation_references(stack,plan)
        lease=root/'.space-budget.lock'
        with lease.open('x',encoding='utf-8') as stream:
            json.dump({'kind':'explicit-periodic-rotation','batchId':plan['batchId'],'pid':os.getpid()},stream)
            stream.flush();os.fsync(stream.fileno())
        owned=identity(lease)
        try:
            checked=validate_batch(plan,approval,resource_report,now,read_bytes,protected_paths,policy,owned_lease=owned)
            if checked['skipped']:raise MaintenanceError('ROTATION_BATCH_NOT_FULLY_PROVED')
            def check():
                lock.check();owner_lock.check()
                if not generation_clear(root,owned):raise MaintenanceError('ROTATION_LEASE_CHANGED')
                action_now=int(time.time()) if now is None else now
                if not 0<=action_now-approval['approvedAtEpoch']<=300 or action_now>p['expiresAtEpoch']:
                    raise MaintenanceError('APPROVAL_EXPIRED_OR_INVALID')
                if not 0<=action_now-resource_report['checkedAtEpoch']<=60:raise MaintenanceError('FRESH_BOUND_RESOURCE_CHECK_REQUIRED')
            output=_delete_pinned_points(plan,checked['validated'],stack,ReadBudget(read_bytes,20),check)
        finally:
            if generation_clear(root,owned):lease.unlink()  # This invocation's control lease only.
    return output

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',type=Path,required=True)
    parser.add_argument('--backup-root',type=Path,required=True)
    parser.add_argument('--max-read-bytes',type=int,default=64*1024**2)
    parser.add_argument('--batch',type=Path)
    parser.add_argument('--approval',type=Path)
    parser.add_argument('--resources',type=Path)
    parser.add_argument('--periodic-only',action='store_true',help='preview only managed periodic rotation')
    parser.add_argument('--execute-periodic',action='store_true',help='irreversibly execute an exact approved periodic batch (Windows)')
    parser.add_argument('--preview-layout',action='store_true',help='read-only exact physical-directory registration proposal; never follows historical links')
    args=parser.parse_args()
    try:
        if args.preview_layout:
            if any((args.batch,args.approval,args.resources,args.execute_periodic,args.periodic_only)):raise MaintenanceError('LAYOUT_PREVIEW_MODE_CONFLICT')
            print(json.dumps(backup.preview_legacy_roots(args.backup_root,args.database),ensure_ascii=False))
            return
        protected=json.loads(os.environ.get('SQLITE_RETENTION_PROTECTED_PATHS','[]'))
        if not isinstance(protected,list):raise MaintenanceError('INVALID_PROTECTED_PATHS')
        policy=retention_policy(json.loads(os.environ['SQLITE_RETENTION_POLICY']) if 'SQLITE_RETENTION_POLICY' in os.environ else None)
        if args.batch or args.approval or args.resources or args.execute_periodic:
            if not all((args.batch,args.approval,args.resources)):raise MaintenanceError('APPROVAL_INPUTS_REQUIRED')
            if any(p.stat().st_size>MAX_REPORT_BYTES for p in (args.batch,args.approval,args.resources)):
                raise MaintenanceError('APPROVAL_INPUT_BYTE_LIMIT')
            inputs=[json.loads(p.read_text(encoding='utf-8-sig')) for p in (args.batch,args.approval,args.resources)]
            if local_path(inputs[0]['payload']['root'])!=local_path(str(args.backup_root)) or local_path(inputs[0]['payload']['database'])!=local_path(str(args.database)):
                raise MaintenanceError('CLI_ROOT_SOURCE_MISMATCH')
            if args.periodic_only and inputs[0]['payload']['policy'].get('periodicOnly') is not True:raise MaintenanceError('PERIODIC_ROTATION_PLAN_REQUIRED')
            if args.execute_periodic:
                result=execute_periodic_batch(*inputs,read_bytes=args.max_read_bytes,protected_paths=protected,policy=policy)
                print(json.dumps(result))
                if result['status']!='complete':raise SystemExit(2)
                return
            result=validate_batch(*inputs,read_bytes=args.max_read_bytes,protected_paths=protected,policy=policy)
            print(json.dumps({'batchId':result['batchId'],'validatedCount':len(result['validated']),'skippedCount':len(result['skipped']),
                              'permanentDeletionPerformed':False}))
            if result['skipped']:raise SystemExit(2)
        else:
            plan=make_plan(args.database,args.backup_root,protected_paths=protected,read_bytes=args.max_read_bytes,policy=policy,periodic_only=args.periodic_only)
            persist_plan(plan)
            print(json.dumps({'batchId':plan['batchId'],'digest':plan['digest'],**plan['payload']['summary']}))
    except Exception as error:
        code=str(error) if isinstance(error,MaintenanceError) else backup.safe_backup_failure(error)['code']
        print(json.dumps({'event':'sqlite-retention-scan','status':'failed','code':code}))
        raise SystemExit(1)

if __name__=='__main__': main()
