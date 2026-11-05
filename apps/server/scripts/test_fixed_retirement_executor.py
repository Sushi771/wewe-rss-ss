"""Actual native execution on new tiny owned fixtures only. Never production."""
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import unittest
from unittest.mock import patch


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file))
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
e=load('fixed_executor_tests','fixed-retirement-executor.py')
fixtures=load('fixed_executor_lifecycle_fixture','test_periodic_lifecycle.py')


@unittest.skipUnless(os.name=='nt','Real Windows handle tests')
class ExecutorTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.LifecycleTests();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.f.now=float(int(time.time())-3*86400)
        self.f.create();self.f.change();self.f.now+=86400
        self.f.create();self.f.change();self.f.now+=86400
        # Pending is a DIFFERENT schema; only the retained same-schema witness
        # can cover the old point. No schema exception is introduced.
        with closing(sqlite3.connect(self.f.database)) as db:db.execute('CREATE TABLE extension(id TEXT PRIMARY KEY)')
        self.f.create();self.f.change();self.f.now+=86400;self.f.create()
        self.r=e.r;self.root=self.f.root;self.audit=self.f.folder/'audit';self.audit.mkdir()
        self.state=self.f.state();self.points=self.state['normal']+[self.state['pending']]
        with self.r.backup.periodic_lifecycle().Store(self.f.database,self.root) as store:
            binding=store.binding();capacity=store.init['policy']
        candidate=[]
        for p in self.points:
            file=Path(p['path']);receipt=Path(p['receipt'])
            candidate.append({**p,'bytes':file.stat().st_size,'receiptBytes':receipt.stat().st_size,
                'directory':str(file.parent),'directoryIdentity':self.r.directory_identity(file.parent)})
        self.old=candidate[0];self.retained=candidate[1:]
        self.release=self.f.folder/'release.db';shutil.copyfile(self.f.database,self.release)
        receipt=self.f.folder/'release-receipt.json';receipt.write_text(json.dumps({'sha256':self.sha(self.release)}))
        release={'path':str(self.release),'identity':self.r.identity(self.release),'sha256':self.sha(self.release),
            'receipt':str(receipt),'receiptSha256':self.sha(receipt),'receiptIdentity':self.r.identity(receipt)}
        init,statefile=self.r.backup.periodic_lifecycle().paths(self.f.database,self.root)
        refs=self.r.indexed_reference_review(self.root,Path(self.old['path']),self.r.ReadBudget(),[init,statefile,self.root/'.space-budget.lock'])
        self.assertTrue(refs['complete'])
        now=int(time.time())
        self.plan={'format':'sqlite-fixed-retirement-review-v1','readyForHumanReview':True,'blockers':[],
            'createdAtEpoch':now,'expiresAtEpoch':now+86400,'approvedDifferenceColumns':sorted(e.HASH_COLUMNS),
            'candidate':self.old,'retainedPeriodicPoints':self.retained,'retainedReleaseRecovery':release,
            'intendedFilesOnly':[self.old['path'],self.old['receipt']],'intendedDirectoryAfterFiles':self.old['directory'],
            'totalBytesIncludingReceipt':self.old['bytes']+self.old['receiptBytes'],
            'coverageWitness':self.retained[0]['path'],'promotionTarget':self.retained[-1]['path'],
            'lifecycleBinding':binding,'capacityPolicyUnchanged':capacity,'references':refs}
        self.review=self.audit/'review.json';self.review.write_bytes(self.r.canonical_json(self.plan))
        self.token=e.issue_token(self.review,self.sha(self.review),'explicit synthetic fixture approval')
        self.before={p['path']:self.sha(Path(p['path'])) for p in self.retained}
        self.before[str(self.release)]=self.sha(self.release)
    def sha(self,file):return hashlib.sha256(file.read_bytes()).hexdigest()
    def resources(self,paths,token,audit):
        return {'batchId':token['id'],'digest':token['planSha256'],'checkedAtEpoch':int(time.time()),
                'files':[{'path':p,'querySucceeded':True,'users':[]} for p in paths]}
    def execute(self,**kw):return e.execute(self.review,self.token,self.audit,resources=kw.pop('resources',self.resources),**kw)
    def unchanged_retained(self):
        self.assertEqual({p:self.sha(Path(p)) for p in self.before},self.before)
    def test_real_resources_native_delete_and_promotion_with_distinct_witness(self):
        out=e.execute(self.review,self.token,self.audit)
        self.assertEqual(out['status'],'complete');self.assertEqual(len(out['completed']),3)
        self.assertFalse(Path(self.old['directory']).exists());self.unchanged_retained()
        s=self.f.state();self.assertEqual(s['status'],'ready');self.assertIsNone(s['pending']);self.assertEqual(s['normal'][-1]['path'],self.plan['promotionTarget'])
        self.assertFalse((self.root/'.space-budget.lock').exists())
        with self.assertRaises((ValueError,FileExistsError)):self.execute()
        self.f.change();self.f.now+=86400;self.f.create()
        self.assertEqual(len(self.f.state()['normal']),3);self.assertIsNotNone(self.f.state()['pending'])
    def test_real_resources_distinguish_occupied_external_process_and_idle(self):
        path=self.old['path']
        child=subprocess.Popen([sys.executable,'-c',
            "import sys; f=open(sys.argv[1],'rb'); print('ready',flush=True); sys.stdin.read(1)",path],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(),'ready')
            busy=e.query_resources([path],{**self.token,'id':'a'*32},self.audit)
            self.assertIn(child.pid,busy['files'][0]['users'])
        finally:
            child.stdin.close()
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
            child.stdout.close();child.stderr.close()
        idle=e.query_resources([path],{**self.token,'id':'b'*32},self.audit)
        self.assertEqual(idle['files'][0]['users'],[])
        self.assertEqual(self.f.state(),self.state);self.assertTrue(Path(path).exists())
    def test_owner_lifetime_lock_is_not_skipped(self):
        key=hashlib.sha256(str(self.f.database).encode()).hexdigest()[:24]
        with self.r.backup.FileLock(self.f.database.parent/('.snapshot-'+key+'.lock'),timeout=0):
            with self.assertRaises(TimeoutError):self.execute()
        self.assertTrue(Path(self.old['path']).exists());self.assertEqual(self.f.state(),self.state)
    def test_occupied_resource_blocks_before_state_change(self):
        def busy(*args):
            result=self.resources(*args);result['files'][0]['users']=[123];return result
        with self.assertRaisesRegex(ValueError,'RESOURCE'):self.execute(resources=busy)
        self.assertEqual(self.f.state(),self.state);self.assertTrue(Path(self.old['path']).exists())
    def test_unknown_reference_injection_and_expired_token_do_not_delete(self):
        self.token['technicalIssuedAtEpoch']-=301;self.token['technicalExpiresAtEpoch']-=301
        with self.assertRaisesRegex(ValueError,'TOKEN_EXPIRED'):self.execute()
        self.token=e.issue_token(self.review,self.sha(self.review),'same unchanged synthetic authorization')
        def inject(phase):
            if phase=='coverage-proved':(self.root/'unknown.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'NAMESPACE'):self.execute(hook=inject)
        self.assertEqual(self.f.state(),self.state);self.assertTrue(Path(self.old['path']).exists())
    def test_native_pins_prevent_replacement_and_writes(self):
        def check(phase):
            if phase=='all-pinned':
                for point in [self.old,*self.retained]:
                    with self.assertRaises(PermissionError):Path(point['path']).write_bytes(b'changed')
                    with self.assertRaises(PermissionError):Path(point['path']).rename(Path(point['path']+'.moved'))
        self.execute(hook=check);self.unchanged_retained()
    def test_partial_failure_stays_held_and_cannot_allocate_or_replay(self):
        def fault(phase):
            if phase=='after-database':raise RuntimeError('synthetic interruption')
        with self.assertRaises(RuntimeError):self.execute(hook=fault)
        self.assertFalse(Path(self.old['path']).exists());self.assertTrue(Path(self.old['receipt']).exists())
        self.assertEqual(self.f.state()['status'],'retirement-started');self.assertTrue((self.root/'.space-budget.lock').exists())
        self.unchanged_retained()
        with self.assertRaises(ValueError):self.f.create()
        token=e.issue_token(self.review,self.sha(self.review),'same scope cannot replay partial action')
        with self.assertRaisesRegex(ValueError,'LIFECYCLE_CHANGED'):e.execute(self.review,token,self.audit,resources=self.resources)
    def test_final_metadata_failure_does_not_claim_ready(self):
        def fault(phase):
            if phase=='before-ready':raise RuntimeError('synthetic final save interruption')
        with self.assertRaises(RuntimeError):self.execute(hook=fault)
        self.assertEqual(self.f.state()['status'],'releasing');self.unchanged_retained()
        with self.assertRaises(ValueError):self.f.create()
    def test_uncertain_native_result_is_not_reported_as_no_deletion(self):
        native=self.r.WindowsPin.delete;calls=[]
        def uncertain(pin):
            calls.append(1);native(pin)
            if len(calls)==1:raise OSError('synthetic lost return after native deletion')
        with patch.object(self.r.WindowsPin,'delete',uncertain):
            with self.assertRaises(OSError):self.execute()
        receipt=json.loads((self.audit/(self.token['id']+'-execution.json')).read_bytes())
        self.assertTrue(receipt['deletionOutcomeUncertain']);self.assertIsNone(receipt['permanentDeletionPerformed'])
        self.assertEqual(self.f.state()['status'],'retirement-started');self.unchanged_retained()
    def test_stale_or_incomplete_resource_proof_is_rejected(self):
        def stale(*args):
            result=self.resources(*args);result['checkedAtEpoch']-=61;return result
        with self.assertRaisesRegex(ValueError,'RESOURCE'):self.execute(resources=stale)
        self.assertEqual(self.f.state(),self.state)
    def test_same_byte_replacement_of_release_receipt_is_rejected(self):
        receipt=Path(self.plan['retainedReleaseRecovery']['receipt']);raw=receipt.read_bytes()
        receipt.rename(receipt.with_suffix('.old'));receipt.write_bytes(raw)
        with self.assertRaises(ValueError):self.execute()
        self.assertEqual(self.f.state(),self.state);self.assertTrue(Path(self.old['path']).exists())
    def test_technical_record_and_monotonic_expiry_are_checked(self):
        token=dict(self.token);self.token['humanApprovalTimeRewritten']=True
        with self.assertRaisesRegex(ValueError,'AUTHORIZATION'):self.execute()
        self.token=token;self.token['technicalIssuedMonotonicNs']-=301*10**9
        with self.assertRaisesRegex(ValueError,'TOKEN_EXPIRED'):self.execute()
        self.assertTrue(Path(self.old['path']).exists())
    def test_allocation_lost_return_is_recorded_and_stays_held(self):
        native=self.r.WindowsPin.delete;calls=[]
        def uncertain(pin):
            calls.append(1);native(pin)
            if len(calls)==4:raise OSError('synthetic lost allocation delete return')
        with patch.object(self.r.WindowsPin,'delete',uncertain):
            with self.assertRaises(OSError):self.execute()
        receipt=json.loads((self.audit/(self.token['id']+'-execution.json')).read_bytes())
        self.assertTrue(receipt['allocationReleaseOutcomeUncertain']);self.assertTrue(receipt['permanentDeletionPerformed'])
        self.assertEqual(self.f.state()['status'],'releasing');self.unchanged_retained()


if __name__=='__main__':unittest.main()
