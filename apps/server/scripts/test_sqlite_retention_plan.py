"""Small synthetic SQLite fixtures only. No production database or deletion."""
from contextlib import closing
from datetime import datetime, timezone
import copy
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('retention',Path(__file__).with_name('sqlite-retention-plan.py'))
retention=importlib.util.module_from_spec(spec);spec.loader.exec_module(retention)

class RetentionTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix='retention-synthetic-')
        self.addCleanup(temporary.cleanup)
        self.folder=Path(temporary.name).resolve();self.root=self.folder/'backups';self.root.mkdir()
        self.source=self.folder/'source.db';self.now=int(time.time())
        settings=patch.dict(os.environ,{'SQLITE_BACKUP_KIND':'test','SQLITE_TEST_MAX_BYTES':'524288',
                                      'SQLITE_TEST_MAX_COPIES':'12'})
        settings.start();self.addCleanup(settings.stop)
        self.old=self.database('旧副本',self.now-10*86400)
        self.keep=self.database('latest',self.now-1)

    def database(self,name,stamp,value='retained subscription'):
        folder=self.root/name;folder.mkdir();file=folder/'synthetic.db'
        with closing(sqlite3.connect(file)) as db,db:
            db.execute('CREATE TABLE feeds(id PRIMARY KEY, name)')
            db.execute('INSERT INTO feeds VALUES(1,?)',(value,))
        sha=retention.ReadBudget().sha(file)
        report={'source':str(self.source),'backup':str(file),'sha256':sha,'integrityCheck':'ok',
                'createdAtUtc':datetime.fromtimestamp(stamp,timezone.utc).isoformat()}
        (folder/'verification.json').write_text(json.dumps(report))
        return file

    def plan(self,**kwargs):return retention.make_plan(self.source,self.root,now=self.now,**kwargs)
    def inputs(self,plan):
        entries=plan['payload']['candidates'];paths=[x['path'] for x in entries]
        resources=set(paths)|{x['representative'] for x in entries if x['representative']}
        return ({'batchId':plan['batchId'],'digest':plan['digest'],'action':'permanent-delete-exact-files',
                 'approvedAtEpoch':self.now,'paths':paths},
                {'batchId':plan['batchId'],'digest':plan['digest'],'checkedAtEpoch':self.now,
                 'files':[{'path':p,'querySucceeded':True,'users':[]} for p in resources]})
    def validate(self,plan,approval=None,resources=None,**kwargs):
        a,r=self.inputs(plan)
        return retention.validate_batch(plan,approval or a,resources or r,now=self.now,**kwargs)

    def test_duplicate_plan_protects_latest_and_keeps_business_bytes(self):
        before={str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        plan=self.plan();entries=plan['payload']['candidates']
        self.assertEqual([x['path'] for x in entries],[str(self.old)])
        self.assertEqual(entries[0]['kind'],'duplicate');self.assertEqual(entries[0]['evidence'],'sha-checked')
        self.assertIn(str(self.keep),plan['payload']['protected'])
        self.assertEqual(before,{str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        self.assertFalse(plan['payload']['summary']['automaticDeletion'])

    def test_valid_action_time_check_never_deletes(self):
        result=self.validate(self.plan())
        self.assertEqual(len(result['validated']),1);self.assertFalse(result['skipped'])
        self.assertFalse(result['permanentDeletionPerformed']);self.assertTrue(self.old.exists())
        with closing(sqlite3.connect(self.keep)) as db:
            self.assertEqual(db.execute('SELECT name FROM feeds').fetchone(),('retained subscription',))

    def test_unique_expired_history_is_held_outside_executable_batch(self):
        unique=self.database('unique',self.now-9*86400,'different past state')
        plan=self.plan();held={x['path']:x for x in plan['payload']['held']}
        self.assertEqual(held[str(unique)]['kind'],'expired-review')
        self.assertNotIn(str(unique),[x['path'] for x in plan['payload']['candidates']])

    def test_owner_and_explicit_boundaries_are_protected(self):
        (self.root/'snapshot-owner-test.json').write_text(json.dumps({'backup':str(self.old)}))
        plan=self.plan(protected_paths=[str(self.keep)])
        self.assertFalse(plan['payload']['candidates'])

    def test_generation_lock_holds_every_point(self):
        (self.root/'.space-budget.lock').write_text('synthetic lease')
        self.assertFalse(self.plan()['payload']['candidates'])
    def test_generation_started_after_plan_invalidates_approval(self):
        plan=self.plan();(self.root/'.space-budget.lock').write_text('new lease')
        with self.assertRaisesRegex(retention.MaintenanceError,'GENERATION_CHANGED'):self.validate(plan)
    def test_new_owner_invalidates_approval(self):
        plan=self.plan();(self.root/'snapshot-owner-test.json').write_text(json.dumps({'backup':str(self.old)}))
        with self.assertRaisesRegex(retention.MaintenanceError,'GENERATION_CHANGED'):self.validate(plan)
    def test_new_latest_receipt_invalidates_approval_without_owner_file(self):
        plan=self.plan();self.database('new-latest',self.now,'new state')
        with self.assertRaisesRegex(retention.MaintenanceError,'GENERATION_CHANGED'):self.validate(plan)
    def test_action_digest_scope_and_expiry_are_exact(self):
        plan=self.plan();a,r=self.inputs(plan)
        for changed in ({**a,'digest':'0'*64},{**a,'paths':[]},{**a,'approvedAtEpoch':self.now-301},
                        {**a,'action':'delete-similar-files'}):
            with self.subTest(changed=changed),self.assertRaises(retention.MaintenanceError):
                self.validate(plan,changed,r)
        modified=copy.deepcopy(plan);modified['payload']['policy']['maxCopies']=99
        with self.assertRaisesRegex(retention.MaintenanceError,'DIGEST_MISMATCH'):self.validate(modified)
    def test_resource_proof_requires_fresh_bound_successful_no_users(self):
        plan=self.plan();a,r=self.inputs(plan)
        for changed in ({**r,'checkedAtEpoch':self.now-61},{**r,'digest':'0'*64}):
            with self.assertRaisesRegex(retention.MaintenanceError,'RESOURCE_CHECK'):self.validate(plan,a,changed)
        for bad in ({'querySucceeded':False,'users':[]},{'querySucceeded':True,'users':['synthetic pid']}):
            changed=copy.deepcopy(r);changed['files'][0].update(bad)
            result=self.validate(plan,a,changed);self.assertFalse(result['validated']);self.assertEqual(len(result['skipped']),1)
        missing=copy.deepcopy(r)
        for entry in missing['files']:entry.pop('users')
        self.assertFalse(self.validate(plan,a,missing)['validated'])
    def test_replaced_file_is_skipped(self):
        plan=self.plan();self.old.write_bytes(b'changed')
        result=self.validate(plan);self.assertFalse(result['validated']);self.assertIn('CHANGED',result['skipped'][0]['reason'])
    def test_representative_change_is_skipped(self):
        plan=self.plan();self.keep.write_bytes(b'changed')
        result=self.validate(plan);self.assertFalse(result['validated']);self.assertIn('REPRESENTATIVE',result['skipped'][0]['reason'])
    def test_sidecars_hold_point_and_action_time_rechecks_them(self):
        plan=self.plan();Path(str(self.old)+'-wal').write_bytes(b'synthetic WAL')
        self.assertFalse(self.plan()['payload']['candidates'])
        self.assertIn('SIDECAR',self.validate(plan)['skipped'][0]['reason'])
    def test_read_budget_defers_large_hash_without_guessing_identical(self):
        plan=self.plan(read_bytes=4096)
        self.assertEqual(plan['payload']['candidates'][0]['evidence'],'requires-bounded-sha-check')
        result=self.validate(plan,read_bytes=4096)
        self.assertFalse(result['validated']);self.assertEqual(len(result['skipped']),1)
    def test_small_read_budget_fails_closed(self):
        with self.assertRaisesRegex(retention.MaintenanceError,'READ_BUDGET'):self.plan(read_bytes=1)
    def test_only_old_empty_artifact_without_siblings_is_candidate(self):
        folder=self.root/'empty';folder.mkdir();empty=folder/'empty.db';empty.touch()
        os.utime(empty,(self.now-7200,self.now-7200))
        self.assertIn(str(empty),[x['path'] for x in self.plan()['payload']['candidates']])
        (folder/'note.txt').write_text('must preserve');self.assertNotIn(str(empty),[x['path'] for x in self.plan()['payload']['candidates']])
    def test_unknown_point_and_identity_name_are_preserved(self):
        folder=self.root/'before-identity-merge';folder.mkdir();unknown=folder/'unknown.db';unknown.write_bytes(b'unknown')
        self.assertIn(str(unknown),self.plan()['payload']['protected'])
        plain=self.root/'unattributed.db';plain.write_bytes(b'unknown')
        self.assertIn(str(plain),[x['path'] for x in self.plan()['payload']['held']])
    def test_own_reports_rotate_with_data_and_unregistered_files_unchanged(self):
        state=self.root/'.retention-review';state.mkdir();unknown=state/'operator-approval.json';unknown.write_text('keep')
        before=self.old.read_bytes()
        for offset in range(5):
            plan=retention.make_plan(self.source,self.root,now=self.now+offset)
            retention.persist_plan(plan)
        index=json.loads((state/'owned-index.json').read_text())
        self.assertEqual(len(index['files']),3)
        self.assertEqual(len(list(state.glob('retention-*.json'))),3)
        self.assertEqual(unknown.read_text(),'keep');self.assertEqual(self.old.read_bytes(),before)
        self.assertFalse(list(state.glob('.planner-*.tmp')))
        self.assertLess(sum(p.stat().st_size for p in state.iterdir()),3*retention.MAX_REPORT_BYTES+16384)
    def test_temp_is_removed_if_report_publication_fails(self):
        with patch.object(Path,'replace',side_effect=OSError('synthetic failure')):
            with self.assertRaises(OSError):retention.write_owned_json(self.root/'review.json',{'test':True})
        self.assertFalse(list(self.root.glob('.planner-*.tmp')));self.assertTrue(self.old.exists())
    def test_unknown_or_modified_report_is_never_evicted(self):
        output=retention.persist_plan(self.plan());output.write_text('{}')
        with self.assertRaisesRegex(retention.MaintenanceError,'OWNERSHIP'):retention.persist_plan(self.plan())
        self.assertTrue(output.exists());self.assertTrue(self.old.exists())
    def test_unregistered_reserved_status_is_never_overwritten(self):
        state=self.root/'.retention-review';state.mkdir();status=state/'latest-status.json';status.write_text('{}')
        with self.assertRaisesRegex(retention.MaintenanceError,'OWNERSHIP'):retention.persist_plan(self.plan())
        self.assertEqual(status.read_text(),'{}');self.assertTrue(self.old.exists())
    def test_oversized_owned_report_is_rejected_before_temp_creation(self):
        with self.assertRaisesRegex(retention.MaintenanceError,'BYTE_LIMIT'):
            retention.write_owned_json(self.root/'report.json',{'synthetic':'x'*retention.MAX_REPORT_BYTES})
        self.assertFalse(list(self.root.glob('.planner-*.tmp')))
    def test_warning_does_not_change_source_or_write_admission(self):
        with patch.dict(os.environ,{'SQLITE_TEST_MAX_BYTES':'1'}):
            plan=self.plan();self.assertTrue(plan['payload']['summary']['warning'])
        self.assertTrue(self.old.exists());self.assertTrue(self.keep.exists())
    def test_finite_bounds_and_nested_source_refused(self):
        for value in (0,-1,True,5*1024**3):
            with self.assertRaises(retention.MaintenanceError):self.plan(read_bytes=value)
        with self.assertRaisesRegex(retention.MaintenanceError,'NESTED'):
            retention.make_plan(self.old,self.root)
    def test_unlinked_legacy_points_are_reviewed_once_and_source_cannot_be_legacy(self):
        legacy=self.folder/'unlinked-history';legacy.mkdir();file=legacy/'unique.db';file.write_bytes(b'unknown historic point')
        with patch.dict(os.environ,{'SQLITE_BACKUP_KIND':'production','SQLITE_PRODUCTION_LEGACY_ROOTS':json.dumps([str(legacy),str(legacy)])}):
            plan=self.plan();self.assertEqual(plan['payload']['summary']['existingCopies'],3)
            self.assertIn(str(file),[x['path'] for x in plan['payload']['held']]);self.assertEqual(file.read_bytes(),b'unknown historic point')
        with patch.dict(os.environ,{'SQLITE_BACKUP_KIND':'production','SQLITE_PRODUCTION_LEGACY_ROOTS':json.dumps([str(self.folder)])}):
            with self.assertRaisesRegex(retention.MaintenanceError,'NESTED_SOURCE'):self.plan()
    def link(self,alias,target):
        if os.name=='nt':
            subprocess.run(['powershell','-NoProfile','-Command',f"New-Item -ItemType Junction -Path '{alias}' -Target '{target}' | Out-Null"],check=True)
        else:alias.symlink_to(target,target_is_directory=True)
    def test_declared_repeated_aliases_are_deduplicated_and_cycles_refused(self):
        legacy=self.folder/'history';legacy.mkdir();point=legacy/'point';point.mkdir();file=point/'unique.db';file.write_bytes(b'keep')
        self.link(self.root/'history-a',point);self.link(self.root/'history-b',point)
        with patch.dict(os.environ,{'SQLITE_BACKUP_KIND':'production','SQLITE_PRODUCTION_LEGACY_ROOTS':json.dumps([str(legacy)])}):
            self.assertEqual(self.plan()['payload']['summary']['existingCopies'],3)
            self.link(legacy/'cycle',legacy)
            with self.assertRaisesRegex(retention.MaintenanceError,'CYCLIC'):self.plan()
    def move_old_to_legacy(self):
        legacy=self.folder/'legacy';legacy.mkdir();directory=legacy/'old-point';self.old.parent.rename(directory)
        self.old=directory/'synthetic.db'
        receipt=directory/'verification.json';r=json.loads(receipt.read_text());r['backup']=str(self.old);receipt.write_text(json.dumps(r))
        return legacy
    def test_each_declared_legacy_owner_and_latest_protects_its_point(self):
        legacy=self.move_old_to_legacy()
        with patch.dict(os.environ,{'SQLITE_BACKUP_KIND':'production','SQLITE_PRODUCTION_LEGACY_ROOTS':json.dumps([str(legacy)])}):
            for name in ('snapshot-owner-synthetic.json','.latest-synthetic.json'):
                reference=legacy/name;reference.write_text(json.dumps({'backup':str(self.old),'source':str(self.source)}))
                plan=self.plan();self.assertIn(str(self.old),plan['payload']['protected'])
                self.assertFalse(plan['payload']['candidates']);self.assertFalse(self.validate(plan)['validated'])
                reference.unlink()  # This synthetic fixture's reference only.
    def test_new_or_changed_legacy_reference_invalidates_action_time_approval(self):
        legacy=self.move_old_to_legacy()
        with patch.dict(os.environ,{'SQLITE_BACKUP_KIND':'production','SQLITE_PRODUCTION_LEGACY_ROOTS':json.dumps([str(legacy)])}):
            for name in ('snapshot-owner-synthetic.json','.latest-synthetic.json'):
                reference=legacy/name
                plan=self.plan();self.assertEqual(len(plan['payload']['candidates']),1)
                reference.write_text(json.dumps({'backup':str(self.old)}))
                with self.assertRaisesRegex(retention.MaintenanceError,'REFERENCES_OR_GENERATION_CHANGED'):self.validate(plan)
                reference.write_text(json.dumps({'backup':str(self.keep)}))
                plan=self.plan();reference.write_text(json.dumps({'backup':str(self.old)}))
                with self.assertRaisesRegex(retention.MaintenanceError,'REFERENCES_OR_GENERATION_CHANGED'):self.validate(plan)
                reference.unlink()
    def test_declared_root_set_change_invalidates_action_time_approval(self):
        legacy=self.folder/'extra-root';legacy.mkdir();plan=self.plan()
        with patch.dict(os.environ,{'SQLITE_BACKUP_KIND':'production','SQLITE_PRODUCTION_LEGACY_ROOTS':json.dumps([str(legacy)])}):
            with self.assertRaisesRegex(retention.MaintenanceError,'REFERENCES_OR_GENERATION_CHANGED'):self.validate(plan)
    @unittest.skipUnless(os.name=='nt' and shutil.which('pwsh'),'Windows RestartManager helper')
    def test_real_windows_resource_helper_and_cli_only_validate_synthetic_batch(self):
        plan=self.plan();batch=self.folder/'batch.json';batch.write_bytes(retention.canonical_json(plan))
        approval,_resources=self.inputs(plan);approved=self.folder/'approval.json';approved.write_text(json.dumps(approval))
        report=self.folder/'resources.json'
        probe=subprocess.run(['pwsh','-NoProfile','-File',str(Path(__file__).with_name('query-retention-resources.ps1')),
                              '-Batch',str(batch),'-Output',str(report)],capture_output=True,text=True,timeout=20)
        self.assertEqual(probe.returncode,0,probe.stderr)
        proof=json.loads(report.read_text(encoding='utf-8'));self.assertEqual(len(proof['files']),2)
        self.assertTrue(all(x['querySucceeded'] and x['users']==[] for x in proof['files']))
        result=subprocess.run([sys.executable,str(Path(__file__).with_name('sqlite-retention-plan.py')),
                               '--database',str(self.source),'--backup-root',str(self.root),'--batch',str(batch),
                               '--approval',str(approved),'--resources',str(report)],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(json.loads(result.stdout)['validatedCount'],1);self.assertTrue(self.old.exists());self.assertTrue(self.keep.exists())

if __name__=='__main__':unittest.main()
