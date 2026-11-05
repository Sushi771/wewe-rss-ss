"""Explicit fixed-point adapter. No global scan, policy change or automatic mode.

Human authorization names an exact review hash. A newly issued technical token
lasts 300 seconds; its issuance time is never a fabricated human approval time.
The caller must have explicit authority for the named permanent action.
"""
from contextlib import ExitStack, closing
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid

spec=importlib.util.spec_from_file_location('fixed_retirement_helpers',Path(__file__).with_name('sqlite-retention-plan.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
HASH_COLUMNS={'feeds.sync_time','feeds.update_time','feeds.updated_at','feeds.last_collection_result','feeds.provider_refresh_attempt_time'}


def fail(code):raise r.MaintenanceError('FIXED_RETIREMENT_'+code)
def digest(value):return hashlib.sha256(r.canonical_json(value)).hexdigest()
def load(file):
    file=Path(file)
    if not file.is_file() or file.is_symlink() or file.stat().st_size>256*1024:fail('DOCUMENT_INVALID')
    raw=file.read_bytes();return json.loads(raw),hashlib.sha256(raw).hexdigest()


def issue_token(review_file, approved_plan_sha256, authorization_reference, now=None):
    """No deletion. Explicit caller-approved scope, independent technical clock."""
    p,sha=load(review_file);now=int(time.time()) if now is None else now
    if sha!=approved_plan_sha256 or not authorization_reference:fail('EXACT_AUTHORIZATION_REQUIRED')
    if p.get('format')!='sqlite-fixed-retirement-review-v1' or p.get('readyForHumanReview') is not True:fail('REVIEW_REQUIRED')
    if not p['createdAtEpoch']<=now<=p['expiresAtEpoch']:fail('REVIEW_EXPIRED')
    release=p['retainedReleaseRecovery'];receipt=Path(release['receipt'])
    stamp=r.identity(receipt)
    if hashlib.sha256(receipt.read_bytes()).hexdigest()!=release['receiptSha256'] or r.identity(receipt)!=stamp:fail('RELEASE_RECEIPT_CHANGED')
    if release.get('receiptIdentity',stamp)!=stamp:fail('RELEASE_RECEIPT_CHANGED')
    return {'format':'fixed-retirement-technical-token-v1','id':uuid.uuid4().hex,'planSha256':sha,
        'authorizationReference':authorization_reference,'technicalIssuedAtEpoch':now,
        'technicalExpiresAtEpoch':now+300,'technicalIssuedMonotonicNs':time.monotonic_ns(),
        'humanApprovalTimeRewritten':False,
        # The original review may lack this supplementary receipt-object field;
        # capture it explicitly at technical preparation, never pretend it was
        # recorded at the earlier human approval or rewrite the approved review.
        'preparedReleaseReceiptIdentity':stamp}


class Budget:
    def __init__(self,maximum,seconds=180):
        if not isinstance(maximum,int) or not 1<=maximum<=8*1024**3:fail('READ_LIMIT')
        self.maximum=maximum;self.used=0;self.deadline=time.monotonic()+seconds;self.handles={}
    def tick(self):
        if time.monotonic()>self.deadline:fail('READ_DEADLINE')
    def reserve(self,n):
        self.tick();self.used+=n
        if self.used>self.maximum:fail('READ_LIMIT')
    def bytes(self,file):
        if str(file) in self.handles:
            fd=self.handles[str(file)];os.lseek(fd,0,os.SEEK_SET);raw=os.read(fd,128*1024+1)
        else:raw=file.read_bytes()
        if len(raw)>128*1024:fail('METADATA_LIMIT')
        self.reserve(len(raw));return raw
    def json(self,file):return json.loads(self.bytes(file).decode('utf-8-sig'))
    def sha(self,file):return hashlib.sha256(self.bytes(file)).hexdigest()


class Journal:
    def __init__(self,file,value):
        self.file=Path(file);self.stream=self.file.open('x+b');self.raw=b'';self.value=value;self.save()
    def save(self):
        self.stream.seek(0)
        if self.stream.read()!=self.raw:fail('JOURNAL_CHANGED')
        raw=r.canonical_json(self.value)
        self.stream.seek(0);self.stream.truncate();self.stream.flush();os.fsync(self.stream.fileno())
        if self.stream.write(raw)!=len(raw):fail('JOURNAL_SHORT_WRITE')
        self.stream.flush();os.fsync(self.stream.fileno());self.raw=raw
    def close(self):self.stream.close()


def query_resources(paths, token, audit):
    """Public Restart Manager API; no script-policy changes or process control."""
    import ctypes
    from ctypes import wintypes as w
    class Process(ctypes.Structure):
        _fields_=[('pid',w.DWORD),('started',w.FILETIME)]
    class Info(ctypes.Structure):
        _fields_=[('process',Process),('application',w.WCHAR*256),('service',w.WCHAR*64),
                  ('kind',w.UINT),('status',w.ULONG),('session',w.DWORD),('restartable',w.BOOL)]
    api=ctypes.WinDLL('rstrtmgr',use_last_error=True)
    api.RmStartSession.argtypes=[ctypes.POINTER(w.DWORD),w.DWORD,w.LPWSTR]
    api.RmRegisterResources.argtypes=[w.DWORD,w.UINT,ctypes.POINTER(w.LPCWSTR),w.UINT,ctypes.c_void_p,w.UINT,ctypes.c_void_p]
    api.RmGetList.argtypes=[w.DWORD,ctypes.POINTER(w.UINT),ctypes.POINTER(w.UINT),ctypes.POINTER(Info),ctypes.POINTER(w.DWORD)]
    api.RmEndSession.argtypes=[w.DWORD]
    for name in ('RmStartSession','RmRegisterResources','RmGetList','RmEndSession'):getattr(api,name).restype=w.DWORD
    started=int(time.time());rows=[]
    for path in paths:
        if int(time.time())-started>30:fail('RESOURCE_QUERY_DEADLINE')
        handle=w.DWORD();key=ctypes.create_unicode_buffer(33)
        if api.RmStartSession(ctypes.byref(handle),0,key)!=0:fail('RESOURCE_QUERY_FAILED')
        try:
            names=(w.LPCWSTR*1)(path)
            if api.RmRegisterResources(handle,1,names,0,None,0,None)!=0:fail('RESOURCE_QUERY_FAILED')
            needed=w.UINT();count=w.UINT();reasons=w.DWORD()
            code=api.RmGetList(handle,ctypes.byref(needed),ctypes.byref(count),None,ctypes.byref(reasons))
            if code==0 and needed.value==0:users=[]
            else:
                if code!=234 or not 1<=needed.value<=4096:fail('RESOURCE_QUERY_UNPROVED')
                count.value=needed.value;items=(Info*needed.value)()
                if api.RmGetList(handle,ctypes.byref(needed),ctypes.byref(count),items,ctypes.byref(reasons))!=0:fail('RESOURCE_QUERY_CHANGED')
                users=[items[i].process.pid for i in range(count.value)]
            rows.append({'path':path,'querySucceeded':True,'users':users})
        finally:api.RmEndSession(handle)
    report={'batchId':token['id'],'digest':token['planSha256'],'checkedAtEpoch':started,'files':rows}
    with (audit/(token['id']+'-resources.json')).open('xb') as f:f.write(r.canonical_json(report))
    return report


def execute(review_file, token, audit_directory, resources=query_resources, hook=lambda phase:None):
    """One exact action. hook exists only for isolated failure-injection tests."""
    if os.name!='nt':fail('NATIVE_WINDOWS_REQUIRED')
    p,plan_sha=load(review_file);audit=Path(audit_directory).resolve(strict=True)
    if token.get('format')!='fixed-retirement-technical-token-v1' or token.get('planSha256')!=plan_sha:fail('TOKEN_SCOPE')
    if not re.fullmatch('[a-f0-9]{32}',str(token.get('id',''))):fail('TOKEN_ID')
    if (not isinstance(token.get('authorizationReference'),str) or not 1<=len(token['authorizationReference'])<=1024
            or token.get('humanApprovalTimeRewritten') is not False):fail('AUTHORIZATION_RECORD')
    mono_issued=token.get('technicalIssuedMonotonicNs')
    if type(mono_issued) is not int or not 0<=time.monotonic_ns()-mono_issued<=300*10**9:fail('TECHNICAL_TOKEN_EXPIRED')
    last_wall=[int(time.time())]
    def clock_check():
        now=int(time.time())
        if now<last_wall[0] or time.monotonic_ns()-mono_issued>300*10**9:fail('TECHNICAL_CLOCK_CHANGED')
        last_wall[0]=now
        if not token['technicalIssuedAtEpoch']<=now<=token['technicalExpiresAtEpoch'] or token['technicalExpiresAtEpoch']-token['technicalIssuedAtEpoch']!=300:fail('TECHNICAL_TOKEN_EXPIRED')
        if not p['createdAtEpoch']<=now<=p['expiresAtEpoch']:fail('REVIEW_EXPIRED')
    clock_check()
    if p.get('format')!='sqlite-fixed-retirement-review-v1' or p.get('readyForHumanReview') is not True or p.get('blockers'):fail('REVIEW_REQUIRED')
    if set(p.get('approvedDifferenceColumns',[]))!=HASH_COLUMNS:fail('COLUMN_SCOPE')
    c=p['candidate'];data=r.local_path(c['path']);receipt=r.local_path(c['receipt']);folder=data.parent;root=folder.parent
    if (str(folder)!=c['directory'] or receipt!=folder/'verification.json' or data.name!='wewe-rss.db'
            or p['intendedFilesOnly']!=[str(data),str(receipt)] or p['intendedDirectoryAfterFiles']!=str(folder)
            or c['bytes']+c['receiptBytes']!=p['totalBytesIncludingReceipt']):fail('OBJECT_SCOPE')
    if audit.is_relative_to(root):fail('AUDIT_OUTSIDE_BACKUPS_REQUIRED')
    retained=p['retainedPeriodicPoints'];release=p['retainedReleaseRecovery']
    witness=next((x for x in retained if x['path']==p['coverageWitness']),None)
    if witness is None or p['promotionTarget'] not in [x['path'] for x in retained] or p['coverageWitness']==p['promotionTarget']:fail('RETAINED_SCOPE')
    # The source is bound by the immutable lifecycle initialization, not by caller configuration.
    init_name=next((x['path'] for x in p['references']['records'] if x.get('kind')=='bound-lifecycle-control' and x['path'].endswith('.init')),None)
    if init_name is None:fail('LIFECYCLE_INITIALIZATION_REQUIRED')
    initialization=load(init_name)[0];database=r.local_path(initialization['source'])
    key=hashlib.sha256(str(database).encode()).hexdigest()[:24]
    state_file=root/('.periodic-lifecycle-'+key+'.json');marker_file=root/'.space-budget.lock'
    if p['capacityPolicyUnchanged']!=initialization['policy']:fail('POLICY_CHANGED')
    journal=Journal(audit/(token['id']+'-execution.json'),{'token':token,'planSha256':plan_sha,'status':'checking','attempted':[],'completed':[],'permanentDeletionPerformed':False})
    try:
        with ExitStack() as stack:
            full=stack.enter_context(r.backup.FileLock(database.parent/('.full-snapshot-'+key+'.lock'),timeout=0))
            owner=stack.enter_context(r.backup.FileLock(database.parent/('.snapshot-'+key+'.lock'),timeout=0))
            store=stack.enter_context(r.backup.periodic_lifecycle().Store(database,root,writable=True))
            s=store.state
            if store.binding()!=p['lifecycleBinding'] or s['status']!='pending-confirmation':fail('LIFECYCLE_CHANGED')
            if c['path']!=s['normal'][0]['path'] or [x['path'] for x in retained]!=[x['path'] for x in s['normal'][1:]+[s['pending']]]:fail('LIFECYCLE_SCOPE')
            if s['pending']['path']!=p['promotionTarget']:fail('PROMOTION_CHANGED')
            if p['coverageWitness'] not in [x['path'] for x in s['normal'][1:]]:fail('WITNESS_SCOPE')
            fields=('path','identity','sha256','receipt','receiptIdentity','receiptSha256','at')
            for point,index in zip([c,*retained],s['normal']+[s['pending']]):
                if any(point.get(k)!=index[k] for k in fields):fail('INDEX_DESCRIPTOR_CHANGED')
                if point['bytes']!=int(index['identity'][2]) or point['receiptBytes']!=int(index['receiptIdentity'][2]):fail('INDEX_SIZE_CHANGED')
            if any(Path(str(data)+suffix).exists() for suffix in ('-wal','-shm','-journal')):fail('SIDECAR_PRESENT')
            if set(folder.iterdir())!={data,receipt}:fail('DIRECTORY_SCOPE')
            for point in [c,*retained]:
                if r.identity(Path(point['path']))!=point['identity'] or r.identity(Path(point['receipt']))!=point['receiptIdentity']:fail('OBJECT_CHANGED')
            marker,stamp=r.backup.periodic_lifecycle().marker(store)
            marker_pin=stack.enter_context(r.WindowsPin(marker,stamp,delete=True))
            budget=Budget(initialization['policy']['readBytes'])
            budget.handles={str(state_file):store.fd,str(marker_file):marker_pin.fd}
            if marker_pin.sha(budget)!=s['allocation']['sha256']:fail('ALLOCATION_CHANGED')
            controls=[state_file,Path(init_name),marker_file]
            refs=r.indexed_reference_review(root,data,budget,controls)
            if r.digest(refs)!=r.digest(p['references']) or not refs['complete']:fail('REFERENCES_CHANGED')
            # Existing publication/registration/receipt files are pinned against writes.
            own_controls={str(state_file),str(marker_file),str(Path(init_name))}
            reference_records={x.get('path',x.get('registrationManifest')):x for x in refs['records']}
            reference_paths=set(reference_records)-own_controls
            if None in reference_paths or len(reference_paths)>256:fail('REFERENCE_PIN_LIMIT')
            for at in sorted(reference_paths):
                record=reference_records[at]
                pin=stack.enter_context(r.WindowsPin(Path(at),record['identity'],sharing=1))
                if pin.sha(budget)!=record['sha256']:fail('REFERENCE_HASH_CHANGED')
            for point in retained:
                pin=stack.enter_context(r.WindowsPin(Path(point['receipt']),point['receiptIdentity'],sharing=1))
                if pin.sha(budget)!=point['receiptSha256']:fail('RETAINED_RECEIPT_CHANGED')
            release_receipt=Path(release['receipt'])
            receipt_identity=token.get('preparedReleaseReceiptIdentity')
            if release.get('receiptIdentity',receipt_identity)!=receipt_identity:fail('RELEASE_RECEIPT_CHANGED')
            pin=stack.enter_context(r.WindowsPin(release_receipt,receipt_identity,sharing=1))
            if pin.sha(budget)!=release['receiptSha256']:fail('RELEASE_RECEIPT_CHANGED')
            expected_names={}
            for row in refs['roots']:
                at=Path(row['path']);stack.enter_context(r.WindowsPin(at,row['identity'],directory=True))
                names=sorted(x.name for x in at.iterdir())
                if r.digest(names)!=row['namesDigest']:fail('NAMESPACE_CHANGED')
                expected_names[str(at)]=names
            def namespaces():
                for at,names in expected_names.items():
                    if sorted(x.name for x in Path(at).iterdir())!=names:fail('NAMESPACE_CHANGED')
            # Same-schema retained witness, independent of the pending promotion target.
            with ExitStack() as read_pins:
                for point in (c,witness):read_pins.enter_context(r.WindowsPin(Path(point['path']),point['identity'],sharing=1))
                budget.reserve(3*(c['bytes']+witness['bytes']))
                with closing(sqlite3.connect(data.as_uri()+'?mode=ro&immutable=1',uri=True)) as db:
                    db.execute('PRAGMA query_only=ON');db.execute('ATTACH DATABASE ? AS witness',(Path(witness['path']).as_uri()+'?mode=ro&immutable=1',))
                    db.set_progress_handler(lambda:int(time.monotonic()>budget.deadline),1000)
                    if not r.indexed_typed_coverage(db)['covers']:fail('TYPED_COVERAGE_HELD')
            hook('coverage-proved');namespaces();clock_check()
            paths=sorted({str(data),str(receipt),*[x['path'] for x in retained],release['path']})
            resource_start=int(time.time());report=resources(paths,token,audit)
            rows={x['path']:x for x in report.get('files',[])}
            if (report.get('batchId')!=token['id'] or report.get('digest')!=plan_sha or len(rows)!=len(report.get('files',[]))
                    or set(rows)!=set(paths) or report.get('checkedAtEpoch',0)<resource_start
                    or any(x.get('querySucceeded') is not True or x.get('users')!=[] for x in rows.values())):fail('RESOURCE_UNPROVED_OR_OCCUPIED')
            # Delete handles opened only after read-only coverage closes; full hashes
            # bind the now-pinned bytes back to the exact reviewed coverage proof.
            for point in retained:
                pin=stack.enter_context(r.WindowsPin(Path(point['path']),point['identity']))
                if pin.sha(budget)!=point['sha256']:fail('RETAINED_HASH_CHANGED')
            release_pin=stack.enter_context(r.WindowsPin(Path(release['path']),release['identity']))
            if release_pin.sha(budget)!=release['sha256']:fail('RELEASE_HASH_CHANGED')
            directory_pin=stack.enter_context(r.WindowsPin(folder,c['directoryIdentity'],directory=True,delete=True))
            data_pin=stack.enter_context(r.WindowsPin(data,c['identity'],delete=True))
            receipt_pin=stack.enter_context(r.WindowsPin(receipt,c['receiptIdentity'],delete=True))
            if data_pin.sha(budget)!=c['sha256'] or receipt_pin.sha(budget)!=c['receiptSha256']:fail('CANDIDATE_HASH_CHANGED')
            def check():
                budget.tick();clock_check();full.check();owner.check();namespaces()
                if store.read()!=store.raw:fail('STATE_CHANGED')
                if not 0<=int(time.time())-report['checkedAtEpoch']<=60:fail('RESOURCE_EXPIRED')
                if r.identity(marker)!=stamp:fail('ALLOCATION_CHANGED')
            hook('all-pinned');check()
            s['status']='retirement-started';s['lastRetirement']={'batchId':token['id'],'digest':plan_sha,
                'approvalSha256':digest(token),'previous':s['lastRetirement'] and digest(s['lastRetirement'])}
            store.save();journal.value['status']='retirement-started';journal.save();hook('state-started')
            for label,at,pin in (('database',str(data),data_pin),('receipt',str(receipt),receipt_pin),('directory',str(folder),directory_pin)):
                check();hook('before-'+label);check()
                journal.value['attempted'].append(at);journal.save();pin.delete()
                journal.value['completed'].append(at);journal.value['permanentDeletionPerformed']=True;journal.save()
                if label=='directory':expected_names[str(root)].remove(folder.name)
                hook('after-'+label);namespaces()
            remaining=s['normal'][1:];combined=remaining+[s['pending']]
            if len(combined)>3 or sum(int(x['identity'][2]) for x in combined)>initialization['policy']['bytes']:fail('RETAINED_CAPACITY_HELD')
            s['normal']=combined;s['pending']=None;s['status']='releasing';store.save();check()
            journal.value['allocationReleaseAttempted']=True;journal.save()
            marker_pin.delete();expected_names[str(root)].remove(marker.name)
            journal.value['allocationReleaseCompleted']=True;journal.save()
            s['allocation']=None;s['status']='ready';hook('before-ready');store.save();namespaces()
            journal.value.update(status='complete',normalCopies=3,pendingCopies=0,allocationReleased=True,deletedBytes=p['totalBytesIncludingReceipt'])
            journal.save();return journal.value
    except BaseException as error:
        allocation_uncertain=journal.value.get('allocationReleaseAttempted',False) and not journal.value.get('allocationReleaseCompleted',False)
        journal.value['allocationReleaseOutcomeUncertain']=allocation_uncertain
        uncertain=len(journal.value['attempted'])>len(journal.value['completed']) or allocation_uncertain
        journal.value['deletionOutcomeUncertain']=uncertain
        if uncertain and not journal.value['completed']:journal.value['permanentDeletionPerformed']=None
        journal.value.update(status='held',errorCode=str(error) if isinstance(error,r.MaintenanceError) else type(error).__name__)
        journal.save();raise
    finally:journal.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--review',type=Path,required=True);parser.add_argument('--audit',type=Path,required=True)
    parser.add_argument('--issue-token',action='store_true');parser.add_argument('--approved-plan-sha256')
    parser.add_argument('--authorization-reference');parser.add_argument('--token',type=Path)
    args=parser.parse_args()
    if args.issue_token:
        token=issue_token(args.review,args.approved_plan_sha256,args.authorization_reference)
        target=args.audit/(token['id']+'-token.json')
        with target.open('xb') as f:f.write(r.canonical_json(token))
        print(json.dumps({'tokenFile':str(target),'planSha256':token['planSha256'],'technicalExpiresAtEpoch':token['technicalExpiresAtEpoch']}))
    else:
        if args.token is None:fail('TOKEN_REQUIRED')
        result=execute(args.review,load(args.token)[0],args.audit)
        print(json.dumps({k:result[k] for k in ('status','permanentDeletionPerformed','deletedBytes','normalCopies','pendingCopies')}))

if __name__=='__main__':main()
