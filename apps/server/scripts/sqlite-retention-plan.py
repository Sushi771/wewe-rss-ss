"""Bounded data-read-only maintenance planning and explicit batch validation.

This module has no database deletion/move or service-control operation.
Only its small registered review reports may be rotated in .retention-review.
"""
import argparse
from contextlib import closing
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
POLICY_DEFAULTS = {'maxOrdinaryCopies':48,'keepLatest':2,'minimumAgeHours':1,
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
    limits={'maxOrdinaryCopies':(2,256),'keepLatest':(2,16),'minimumAgeHours':(1,168),
            'roundDays':(1,31),'recentHours':(1,168),'bucketHours':(1,24),'dailyDays':(1,90),
            'weeklyWeeks':(0,52),'maximumAgeDays':(1,365),'warningPercent':(10,99),
            'reserveCopies':(2,128),'expectedGenerationsPerDay':(1,96)}
    for key,(low,high) in limits.items():finite(result[key],low,high)
    if (result['keepLatest']>result['maxOrdinaryCopies'] or result['bucketHours']>result['recentHours']
        or result['maximumAgeDays']<max(result['roundDays'],result['dailyDays'],result['weeklyWeeks']*7)
        or result['minimumAgeHours']>result['maximumAgeDays']*24):raise MaintenanceError('INCONSISTENT_RETENTION_POLICY')
    return result


def policy_refs(database,root,files,databases,refs,records,budget,now,policy):
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
            expected='before-collection' if origin['kind']=='write-before' else 'periodic-snapshot'
            if not re.fullmatch(expected+r'-\d{8}T\d{6}Z-[a-f0-9]{8}',target.parent.name):continue
            date=datetime.fromisoformat(r['createdAtUtc'].replace('Z','+00:00'))
            if date.tzinfo is None or date.timestamp()>now:continue
            at=int(date.timestamp());path=str(target)
            inventory.append({'receipt':str(p),'identity':identity(p),'contentDigest':digest(r)})
            if path not in refs:points[path]={'at':at,'kind':origin['kind'],'receipt':str(p),
                                            'receiptIdentity':identity(p),'sha256':r['sha256']}
        except MaintenanceError:raise
        except (KeyError,ValueError,OSError):continue
    ordered=sorted(points,key=lambda p:(points[p]['at'],p),reverse=True);keep={}
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
        if len(keep)<policy['maxOrdinaryCopies'] and now-points[path]['at']<policy['maximumAgeDays']*86400:retain(path,'ordinary count allowance')
    retired={p:r for p,r in points.items() if p not in keep}
    refs.update(keep)
    records.append({'retentionPolicy':policy,'inventoryDigest':digest(sorted(inventory,key=lambda x:canonical_json(x))),
                    'retained':sorted(keep),'retirement':sorted(retired)})
    return retired,{'ordinaryCopies':len(points),'retainedOrdinaryCopies':len(keep),
                    'ordinaryTargetExceeded':len(keep)>policy['maxOrdinaryCopies'],
                    'retirementCount':len(retired),'requiresExactUniqueHistoryApproval':bool(retired)}

class ReadBudget:
    def __init__(self, maximum=64*1024**2, seconds=10):
        self.maximum = finite(maximum, 1, 4*1024**3)
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
    allowed=backup.legacy_roots();files=[];seen=set();active=set()
    def visit(directory):
        budget.tick();canonical=directory.resolve(strict=True)
        if canonical in active:raise MaintenanceError('CYCLIC_DIRECTORY')
        if canonical in seen:return
        seen.add(canonical);active.add(canonical)
        if len(seen)>4096:raise MaintenanceError('SCAN_DIRECTORY_LIMIT')
        for file in directory.iterdir():
            budget.tick()
            linked=file.is_symlink() or (hasattr(file,'is_junction') and file.is_junction())
            if linked and (not file.is_dir() or not any(file.resolve(strict=True).is_relative_to(p) for p in allowed)):
                raise MaintenanceError('UNLISTED_LINK')
            if file.is_dir():visit(file)
            elif file.is_file():
                files.append(file.resolve(strict=True))
                if len(files)>4096:raise MaintenanceError('SCAN_FILE_LIMIT')
        active.remove(canonical)
    if root.exists():visit(root)
    for folder in allowed:
        if folder not in seen:visit(folder)
    return list(dict.fromkeys(files))

def files_and_refs(root, budget, protected_paths=()):
    files = bounded_files(root,budget)
    state = root / '.retention-review'
    data_files = [p for p in files if p.suffix.lower() in ('.db', '.sqlite', '.sqlite3')]
    refs = {str(local_path(p)): 'explicit deployment/migration/identity protection' for p in protected_paths}
    reference_roots={root.resolve(),*backup.legacy_roots()}
    reference_records = [{'declaredRoots':sorted(str(p) for p in reference_roots)}]
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

def make_plan(database, root, now=None, protected_paths=(), read_bytes=64*1024**2, seconds=10, age_days=7, policy=None):
    database, root = local_path(str(database)), local_path(str(root))
    if database.is_relative_to(root): raise MaintenanceError('NESTED_SOURCE_DESTINATION')
    if any(database.is_relative_to(p) for p in backup.legacy_roots()):raise MaintenanceError('NESTED_SOURCE_LEGACY_ROOT')
    now = int(time.time()) if now is None else finite(now, 1, 2**53)
    age_days = finite(age_days, 1, 365)
    policy=retention_policy(policy)
    budget = ReadBudget(read_bytes, seconds)
    files, databases, refs, records, _state = files_and_refs(root, budget, protected_paths)
    paused = (root / '.space-budget.lock').exists()
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
            if date.tzinfo is None or date.timestamp() > now: continue
            receipt_by_backup[str(target)] = {'source':source,'sha256':r['sha256'],'at':int(date.timestamp()),'receipt':str(p)}
        except MaintenanceError:raise
        except (KeyError, ValueError, OSError):
            continue
    newest = {}
    for path, receipt in receipt_by_backup.items():
        if receipt['source'] not in newest or receipt['at'] > newest[receipt['source']][0]:
            newest[receipt['source']] = (receipt['at'], path)
    for _at, path in newest.values(): refs[path] = 'latest verified receipt per source'
    retired,tier_summary=policy_refs(database,root,files,databases,refs,records,budget,now,policy)
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
        if size == 0:
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
    policy_refs(database,root,_f,_d,new_refs,new_records,budget,now,policy)
    if digest({'records':new_records,'protected':sorted(new_refs)}) != ref_digest or (root/'.space-budget.lock').exists() != paused:
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
    rate=policy['expectedGenerationsPerDay'] if policy else 96
    if headroom/rate<3:alarms.append('less-than-three-days-at-configured-rate')
    payload = {'format':FORMAT,'root':str(root),'database':str(database),'createdAtEpoch':now,'expiresAtEpoch':now+86400,
               'referenceDigest':ref_digest,'referenceRecords':records,'protected':refs,'candidates':candidates,'held':held,
               'policy':{'maxBytes':maximum,'maxCopies':copies,'ageDays':age_days,'retention':policy},
               'summary':{'existingBytes':used,'existingCopies':len(databases),'readBytes':budget.used,
                          'candidateCount':len(candidates),'candidateBytes':sum(x['bytes'] for x in candidates),
                          'generationInProgress':paused,'warning':bool(alarms),'warningReasons':alarms,
                          'headroomGenerations':headroom,'estimatedDaysAtConfiguredRate':round(headroom/rate,2),
                          'configuredGenerationsPerDay':rate,'nextReservedBytes':reserved,**tier_summary,
                          'automaticDeletion':False}}
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

def validate_batch(plan, approval, resource_report, now=None, read_bytes=64*1024**2, protected_paths=(), policy=None):
    now=int(time.time()) if now is None else now
    p=plan.get('payload',{})
    if p.get('format')!=FORMAT or plan.get('digest')!=digest(p): raise MaintenanceError('BATCH_DIGEST_MISMATCH')
    policy=retention_policy(policy)
    if p.get('policy',{}).get('retention')!=policy:raise MaintenanceError('RETENTION_POLICY_CHANGED')
    if approval.get('batchId')!=plan['batchId'] or approval.get('digest')!=plan['digest'] or approval.get('action')!='permanent-delete-exact-files':
        raise MaintenanceError('EXACT_ACTION_TIME_APPROVAL_REQUIRED')
    approved_at=approval.get('approvedAtEpoch')
    if not isinstance(approved_at,int) or isinstance(approved_at,bool) or not p['createdAtEpoch']<=approved_at<=now or now-approved_at>300 or now>p['expiresAtEpoch']:
        raise MaintenanceError('APPROVAL_EXPIRED_OR_INVALID')
    paths=[x['path'] for x in p['candidates']]
    if len(paths)!=len(set(paths)) or sorted(approval.get('paths',[]))!=sorted(paths): raise MaintenanceError('APPROVAL_SCOPE_MISMATCH')
    unique=[x['path'] for x in p['candidates'] if x['kind']=='retention-expired']
    if unique and sorted(approval.get('uniqueHistoryPaths',[]))!=sorted(unique):
        raise MaintenanceError('EXACT_UNIQUE_HISTORY_LOSS_APPROVAL_REQUIRED')
    if resource_report.get('batchId')!=plan['batchId'] or resource_report.get('digest')!=plan['digest'] or not 0<=now-resource_report.get('checkedAtEpoch',0)<=60:
        raise MaintenanceError('FRESH_BOUND_RESOURCE_CHECK_REQUIRED')
    root=local_path(p['root']);budget=ReadBudget(read_bytes,20)
    database=local_path(p['database'])
    if database.is_relative_to(root) or any(database.is_relative_to(x) for x in backup.legacy_roots()):
        raise MaintenanceError('NESTED_SOURCE_DESTINATION')
    _files,_db,refs,records,_state=files_and_refs(root,budget,protected_paths)
    retired,_tier=policy_refs(database,root,_files,_db,refs,records,budget,now,policy)
    # Latest same-source protections established by the plan are also retained.
    refs.update(p['protected'])
    if digest({'records':records,'protected':sorted(refs)})!=p['referenceDigest'] or (root/'.space-budget.lock').exists():
        raise MaintenanceError('LIVE_REFERENCES_OR_GENERATION_CHANGED')
    resource_files=resource_report.get('files',[])
    resources={x['path']:x for x in resource_files}
    if len(resources)!=len(resource_files):raise MaintenanceError('AMBIGUOUS_RESOURCE_PROOF')
    valid=[];skipped=[]
    for entry in p['candidates']:
        try:
            file=local_path(entry['path'])
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
    policy_refs(database,root,_f,_d,final_refs,final_records,budget,now,policy)
    final_refs.update(p['protected'])
    if digest({'records':final_records,'protected':sorted(final_refs)})!=p['referenceDigest'] or (root/'.space-budget.lock').exists():
        raise MaintenanceError('LIVE_REFERENCES_OR_GENERATION_CHANGED')
    return {'batchId':plan['batchId'],'validated':valid,'skipped':skipped,'permanentDeletionPerformed':False,
            'executorMustRecheckVerifiedHandles':True}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',type=Path,required=True)
    parser.add_argument('--backup-root',type=Path,required=True)
    parser.add_argument('--max-read-bytes',type=int,default=64*1024**2)
    parser.add_argument('--batch',type=Path)
    parser.add_argument('--approval',type=Path)
    parser.add_argument('--resources',type=Path)
    args=parser.parse_args()
    try:
        protected=json.loads(os.environ.get('SQLITE_RETENTION_PROTECTED_PATHS','[]'))
        if not isinstance(protected,list):raise MaintenanceError('INVALID_PROTECTED_PATHS')
        policy=retention_policy(json.loads(os.environ['SQLITE_RETENTION_POLICY']) if 'SQLITE_RETENTION_POLICY' in os.environ else None)
        if args.batch or args.approval or args.resources:
            if not all((args.batch,args.approval,args.resources)):raise MaintenanceError('APPROVAL_INPUTS_REQUIRED')
            if any(p.stat().st_size>MAX_REPORT_BYTES for p in (args.batch,args.approval,args.resources)):
                raise MaintenanceError('APPROVAL_INPUT_BYTE_LIMIT')
            inputs=[json.loads(p.read_text(encoding='utf-8-sig')) for p in (args.batch,args.approval,args.resources)]
            if local_path(inputs[0]['payload']['root'])!=local_path(str(args.backup_root)) or local_path(inputs[0]['payload']['database'])!=local_path(str(args.database)):
                raise MaintenanceError('CLI_ROOT_SOURCE_MISMATCH')
            result=validate_batch(*inputs,read_bytes=args.max_read_bytes,protected_paths=protected,policy=policy)
            print(json.dumps({'batchId':result['batchId'],'validatedCount':len(result['validated']),'skippedCount':len(result['skipped']),
                              'permanentDeletionPerformed':False}))
            if result['skipped']:raise SystemExit(2)
        else:
            plan=make_plan(args.database,args.backup_root,protected_paths=protected,read_bytes=args.max_read_bytes,policy=policy)
            persist_plan(plan)
            print(json.dumps({'batchId':plan['batchId'],'digest':plan['digest'],**plan['payload']['summary']}))
    except Exception as error:
        print(json.dumps({'event':'sqlite-retention-scan','status':'failed','code':str(error) if isinstance(error,MaintenanceError) else 'SCAN_FAILED'}))
        raise SystemExit(1)

if __name__=='__main__': main()
