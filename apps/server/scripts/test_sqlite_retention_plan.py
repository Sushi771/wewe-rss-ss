"""Small synthetic SQLite fixtures only; deletion is limited to owned temp files."""
from contextlib import closing
from datetime import datetime, timezone
import copy
import hashlib
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
import uuid
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

    def test_protected_high_risk_receipt_is_never_a_retirement_candidate(self):
        receipt=self.old.parent/'verification.json';r=json.loads(receipt.read_text())
        r['recoveryOrigin']={'format':'sqlite-recovery-origin-v1','kind':'protected'};receipt.write_text(json.dumps(r))
        plan=self.plan();self.assertIn(str(self.old),plan['payload']['protected']);self.assertFalse(plan['payload']['candidates'])
        receipt.write_text(json.dumps({**r,'sha256':'f'*64}))
        with self.assertRaisesRegex(retention.MaintenanceError,'REFERENCES_OR_GENERATION_CHANGED'):self.validate(plan)

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

    def ordinary(self,age_hours,kind='periodic',value=None):
        stamp=self.now-age_hours*3600
        prefix='periodic-snapshot' if kind=='periodic' else 'before-collection'
        name=prefix+'-'+datetime.fromtimestamp(stamp,timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]
        file=self.database(name,stamp,value or name)
        receipt=file.parent/'verification.json';r=json.loads(receipt.read_text())
        r['recoveryOrigin']={'format':'sqlite-recovery-origin-v1','kind':kind}
        receipt.write_text(json.dumps(r));return file

    def tier_fixture(self):
        files=[self.ordinary(h) for h in (72,71,70)]
        policy={'maxOrdinaryCopies':2,'keepLatest':2,'roundDays':1,'recentHours':1,
                'dailyDays':1,'weeklyWeeks':0,'maximumAgeDays':1,'bucketHours':1}
        plan=self.plan(policy=policy);a,r=self.inputs(plan)
        a['uniqueHistoryPaths']=[x['path'] for x in plan['payload']['candidates'] if x['kind']=='retention-expired']
        return files,policy,plan,a,r

    def rotation_fixture(self,count=3,manifest=True,**changes):
        # Tiny fixture source retains business/history rows throughout rotation.
        shutil.copyfile(self.keep,self.source)
        if manifest:
            (self.root/'retention-protected.json').write_text(json.dumps({'format':'sqlite-retention-protected-v1','paths':[]}))
        files=[self.ordinary(72+i) for i in range(count)]
        policy={'maxOrdinaryCopies':2,'keepLatest':2,'roundDays':1,'recentHours':1,
                'dailyDays':1,'weeklyWeeks':0,'maximumAgeDays':28,'bucketHours':1,**changes}
        plan=self.plan(policy=policy,periodic_only=True);a,r=self.inputs(plan)
        a.update(action='rotate-exact-periodic-backups',uniqueHistoryPaths=[x['path'] for x in plan['payload']['candidates']],
                 metadataPaths=[x['receipt'] for x in plan['payload']['candidates']],
                 directories=[x['directory'] for x in plan['payload']['candidates']])
        return files,policy,plan,a,r

    def execute_rotation(self,plan,a,r,policy):
        return retention.execute_periodic_batch(plan,a,r,now=self.now,policy=policy)

    @unittest.skipUnless(os.name=='nt','Windows protection publication critical section')
    def test_native_rotation_missing_manifest_never_enters_deletion_or_creates_placeholder(self):
        _files,policy,plan,a,r=self.rotation_fixture(manifest=False)
        with patch.object(retention.WindowsPin,'delete',side_effect=AssertionError('owned delete guard')) as delete:
            with self.assertRaisesRegex(retention.MaintenanceError,'PREEXISTING_PROTECTION_MANIFEST_REQUIRED'):
                self.execute_rotation(plan,a,r,policy)
        delete.assert_not_called();self.assertFalse((self.root/'retention-protected.json').exists())
        self.assertTrue(all(Path(p).exists() for p in a['paths']))

    @unittest.skipUnless(os.name=='nt','Windows preexisting protection writer exclusion')
    def test_native_rotation_preexisting_manifest_writer_holds_before_deletion(self):
        _files,policy,plan,a,r=self.rotation_fixture();manifest=self.root/'retention-protected.json';original=manifest.read_bytes()
        with manifest.open('r+b') as writer,patch.object(retention.WindowsPin,'delete',side_effect=AssertionError('owned delete guard')) as delete:
            with self.assertRaisesRegex(retention.MaintenanceError,'EXCLUSIVE_OBJECT_PIN_FAILED'):
                self.execute_rotation(plan,a,r,policy)
            self.assertFalse(writer.closed);delete.assert_not_called()
        self.assertEqual(manifest.read_bytes(),original);self.assertTrue(all(Path(p).exists() for p in a['paths']))

    @unittest.skipUnless(os.name=='nt','Windows protection publication critical section')
    def test_native_rotation_late_protection_write_and_replace_are_excluded_without_delete(self):
        _files,policy,plan,a,r=self.rotation_fixture();manifest=self.root/'retention-protected.json'
        original=manifest.read_bytes();native=retention.WindowsPin.sha
        for replace in (False,True):
            attempts=[]
            def publish_after_validation(pin,budget):
                value=native(pin,budget)
                if not attempts:
                    attempts.append(True)
                    data=json.dumps({'format':'sqlite-retention-protected-v1','paths':a['paths']})
                    if replace:
                        temporary=self.root/'owned-new-protection.tmp';temporary.write_text(data)
                        try:temporary.replace(manifest)
                        finally:temporary.unlink()
                    else:manifest.write_text(data)
                return value
            with self.subTest(replace=replace),patch.object(retention.WindowsPin,'sha',publish_after_validation),\
                 patch.object(retention.WindowsPin,'delete',side_effect=AssertionError('owned delete guard')) as delete:
                with self.assertRaises(PermissionError):self.execute_rotation(plan,a,r,policy)
            delete.assert_not_called();self.assertEqual(attempts,[True]);self.assertEqual(manifest.read_bytes(),original)
            self.assertTrue(all(Path(p).exists() for p in a['paths']));self.assertFalse((self.root/'.space-budget.lock').exists())
        # Failed publication/rotation does not leave the manifest frozen.
        manifest.write_bytes(original)

    @unittest.skipUnless(os.name=='nt','Windows current publisher locks')
    def test_native_rotation_active_guard_refuses_without_stopping_owner_or_deleting(self):
        _files,policy,plan,a,r=self.rotation_fixture()
        spec=importlib.util.spec_from_file_location('owned_guard',Path(__file__).with_name('sqlite-snapshot-guard.py'))
        guard_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard_module)
        guard=guard_module.SnapshotGuard(self.source,self.root)
        try:
            with patch.object(retention.WindowsPin,'delete',side_effect=AssertionError('owned delete guard')) as delete:
                with self.assertRaises(TimeoutError):self.execute_rotation(plan,a,r,policy)
            delete.assert_not_called();guard.lock.check()
            self.assertEqual(guard.source.execute('SELECT name FROM feeds').fetchone(),('retained subscription',))
        finally:guard.close()
        self.assertTrue(all(Path(p).exists() for p in a['paths']))

    @unittest.skipUnless(os.name=='nt','Windows current publisher locks')
    def test_native_rotation_excludes_backup_guard_and_lock_replacement_through_action_boundary(self):
        _files,policy,plan,a,r=self.rotation_fixture();native=retention.WindowsPin.sha;observed=[]
        key=hashlib.sha256(str(self.source).encode()).hexdigest()[:24]
        def inspect_critical_section(pin,budget):
            value=native(pin,budget)
            if not observed:
                for name in (f'.snapshot-{key}.lock',f'.full-snapshot-{key}.lock'):
                    lock=self.source.parent/name
                    with self.assertRaises(TimeoutError):retention.backup.FileLock(lock,timeout=0)
                    with self.assertRaises(PermissionError):lock.rename(lock.with_suffix('.moved'))
                    observed.append(name)
                raise AssertionError('OWNED_NO_DELETE_AFTER_PUBLISHER_LOCK_PROOF')
            return value
        with patch.object(retention.WindowsPin,'sha',inspect_critical_section),\
             patch.object(retention.WindowsPin,'delete',side_effect=AssertionError('owned delete guard')) as delete:
            with self.assertRaisesRegex(AssertionError,'OWNED_NO_DELETE_AFTER_PUBLISHER_LOCK_PROOF'):
                self.execute_rotation(plan,a,r,policy)
        delete.assert_not_called();self.assertEqual(len(observed),2)
        for name in observed:
            with retention.backup.FileLock(self.source.parent/name,timeout=0):pass

    @unittest.skipUnless(os.name=='nt','Windows protection publication ordering')
    def test_native_rotation_protection_published_before_freeze_wins_and_stops_deletion(self):
        _files,policy,plan,a,r=self.rotation_fixture();native=retention.validate_batch;count=[]
        manifest=self.root/'retention-protected.json'
        def publish_before_freeze(*args,**kwargs):
            result=native(*args,**kwargs)
            if not count:
                count.append(True);manifest.write_text(json.dumps({'format':'sqlite-retention-protected-v1','paths':a['paths']}))
            return result
        with patch.object(retention,'validate_batch',publish_before_freeze),\
             patch.object(retention.WindowsPin,'delete',side_effect=AssertionError('owned delete guard')) as delete:
            with self.assertRaises(retention.MaintenanceError):self.execute_rotation(plan,a,r,policy)
        delete.assert_not_called();self.assertEqual(json.loads(manifest.read_text())['paths'],a['paths'])
        self.assertTrue(all(Path(p).exists() for p in a['paths']))

    def test_periodic_rotation_old_plan_without_reference_protocol_is_not_executable(self):
        _files,policy,plan,a,r=self.rotation_fixture();old=copy.deepcopy(plan)
        old['payload']['policy'].pop('referenceConcurrency')
        with self.assertRaisesRegex(retention.MaintenanceError,'REFERENCE_CONCURRENCY_PLAN_REQUIRED'):
            self.execute_rotation(old,a,r,policy)
        altered=copy.deepcopy(plan);altered['payload']['referenceRecords']=[]
        altered['digest']=retention.digest(altered['payload'])
        with self.assertRaisesRegex(retention.MaintenanceError,'BOUND_REFERENCE_RECORDS_CHANGED'):
            self.execute_rotation(altered,{**a,'digest':altered['digest']},{**r,'digest':altered['digest']},policy)

    @unittest.skipUnless(os.name=='nt','Windows supported publisher namespace')
    def test_native_rotation_unknown_or_foreign_reference_publishers_hold_execution(self):
        _files,policy,_plan,_a,_r=self.rotation_fixture()
        reference=self.root/'refresh-recovery-owner-unmanaged.json'
        reference.write_text(json.dumps({'backup':str(self.keep),'source':str(self.source)}))
        plan=self.plan(policy=policy,periodic_only=True);a,r=self.inputs(plan)
        a.update(action='rotate-exact-periodic-backups',uniqueHistoryPaths=[x['path'] for x in plan['payload']['candidates']],
                 metadataPaths=[x['receipt'] for x in plan['payload']['candidates']],directories=[x['directory'] for x in plan['payload']['candidates']])
        with patch.object(retention.WindowsPin,'delete',side_effect=AssertionError('owned delete guard')) as delete:
            with self.assertRaisesRegex(retention.MaintenanceError,'UNSUPPORTED_REFERENCE_PUBLISHER'):
                self.execute_rotation(plan,a,r,policy)
        delete.assert_not_called();self.assertTrue(reference.exists())

    @unittest.skipUnless(os.name=='nt','Windows all declared manual protection roots')
    def test_native_rotation_legacy_root_manifest_is_also_pinned_against_late_protection(self):
        _files,policy,_plan,_a,_r=self.rotation_fixture();legacy=self.folder/'legacy';legacy.mkdir()
        manifest=legacy/'retention-protected.json';manifest.write_text(json.dumps({'format':'sqlite-retention-protected-v1','paths':[]}))
        with patch.dict(os.environ,{'SQLITE_BACKUP_KIND':'production','SQLITE_PRODUCTION_LEGACY_ROOTS':json.dumps([str(legacy)])}):
            plan=self.plan(policy=policy,periodic_only=True);a,r=self.inputs(plan)
            a.update(action='rotate-exact-periodic-backups',uniqueHistoryPaths=[x['path'] for x in plan['payload']['candidates']],
                     metadataPaths=[x['receipt'] for x in plan['payload']['candidates']],directories=[x['directory'] for x in plan['payload']['candidates']])
            native=retention.WindowsPin.sha;injected=[];original=manifest.read_bytes()
            def late_legacy_protection(pin,budget):
                value=native(pin,budget)
                if not injected:
                    injected.append(True);manifest.write_text(json.dumps({'format':'sqlite-retention-protected-v1','paths':a['paths']}))
                return value
            with patch.object(retention.WindowsPin,'sha',late_legacy_protection),\
                 patch.object(retention.WindowsPin,'delete',side_effect=AssertionError('owned delete guard')) as delete:
                with self.assertRaises(PermissionError):self.execute_rotation(plan,a,r,policy)
            delete.assert_not_called();self.assertEqual(manifest.read_bytes(),original)

    def test_periodic_rotation_count_and_byte_targets_include_all_retained_points(self):
        size=self.keep.stat().st_size
        files,policy,plan,a,r=self.rotation_fixture(count=5,maxOrdinaryCopies=4,maxOrdinaryBytes=2*size-1)
        # Latest two are mandatory even below their combined byte footprint.
        self.assertEqual(plan['payload']['summary']['ordinaryCopies'],5)
        self.assertEqual(plan['payload']['summary']['retainedOrdinaryCopies'],2)
        self.assertTrue(plan['payload']['summary']['ordinaryByteTargetExceeded'])
        self.assertEqual(len(plan['payload']['candidates']),3)
        self.assertEqual(len(self.validate(plan,a,r,policy=policy)['validated']),3)
        self.assertTrue(all(p.exists() for p in files))

    def test_periodic_rotation_capacity_retires_old_points_before_count_target(self):
        files,policy,plan,_a,_r=self.rotation_fixture(count=5,maxOrdinaryCopies=5,maxOrdinaryBytes=3*self.keep.stat().st_size)
        self.assertEqual(plan['payload']['summary']['retainedOrdinaryCopies'],3)
        self.assertEqual(plan['payload']['summary']['retainedOrdinaryBytes'],3*files[0].stat().st_size)
        self.assertEqual(len(plan['payload']['candidates']),2)

    def test_periodic_rotation_preserves_other_origins_unknown_files_and_all_business_bytes(self):
        _files,policy,_plan,_a,_r=self.rotation_fixture()
        boundaries=[self.ordinary(960,'write-before'),self.ordinary(961)]
        receipt=boundaries[1].parent/'verification.json';data=json.loads(receipt.read_text())
        data['recoveryOrigin']['kind']='protected';receipt.write_text(json.dumps(data))
        unknown=self.root/'historic-articles.sqlite';unknown.write_bytes(b'unattributed history')
        before={str(p):p.read_bytes() for p in self.folder.rglob('*') if p.is_file()}
        plan=self.plan(policy=policy,periodic_only=True)
        paths=[x['path'] for x in plan['payload']['candidates']]
        self.assertTrue(all(str(p) not in paths for p in (*boundaries,unknown,self.source,self.old,self.keep)))
        self.assertEqual(before,{str(p):p.read_bytes() for p in self.folder.rglob('*') if p.is_file()})

    def test_periodic_rotation_active_owner_and_only_recovery_points_are_never_retired(self):
        files,policy,_plan,_a,_r=self.rotation_fixture()
        ref=self.root/'snapshot-owner-synthetic.json';ref.write_text(json.dumps({'backup':str(files[-1])}))
        plan=self.plan(policy=policy,periodic_only=True)
        self.assertFalse(plan['payload']['candidates'])
        self.assertTrue(plan['payload']['summary']['ordinaryTargetExceeded'])
        for p in files[1:]:
            p.unlink();(p.parent/'verification.json').unlink();p.parent.rmdir()
        ref.unlink();plan=self.plan(policy=policy,periodic_only=True)
        self.assertFalse(plan['payload']['candidates']);self.assertIn(str(files[0]),plan['payload']['protected'])

    def test_periodic_rotation_requires_new_exact_action_history_and_metadata_approval(self):
        _files,policy,plan,a,r=self.rotation_fixture()
        before={str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        for change in ({'action':'permanent-delete-exact-files'},{'metadataPaths':[]},{'directories':[]},
                       {'paths':[]},{'uniqueHistoryPaths':[]},{'approvedAtEpoch':self.now-301}):
            with self.subTest(change=change),self.assertRaises(retention.MaintenanceError):
                self.execute_rotation(plan,{**a,**change},r,policy)
        self.assertEqual(before,{str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        with self.assertRaisesRegex(retention.MaintenanceError,'PERIODIC_ROTATION_PLAN_REQUIRED'):
            self.execute_rotation(self.plan(),a,r,None)
        with self.assertRaisesRegex(retention.MaintenanceError,'EXPLICIT_PERIODIC_POLICY_REQUIRED'):
            self.plan(periodic_only=True)

    def test_periodic_rotation_changed_siblings_receipt_policy_and_refs_refuse_execution(self):
        _files,policy,plan,a,r=self.rotation_fixture()
        entry=plan['payload']['candidates'][0];file=Path(entry['path'])
        extra=file.parent/'operator-note.txt';extra.write_text('keep')
        self.assertTrue(self.validate(plan,a,r,policy=policy)['skipped'])
        with self.assertRaisesRegex(retention.MaintenanceError,'NOT_FULLY_PROVED'):self.execute_rotation(plan,a,r,policy)
        extra.unlink()
        with self.assertRaisesRegex(retention.MaintenanceError,'POLICY_CHANGED'):
            self.execute_rotation(plan,a,r,{**policy,'maxOrdinaryBytes':1})
        owner=self.root/'refresh-recovery-owner-new.json';owner.write_text(json.dumps({'backup':str(file)}))
        with self.assertRaisesRegex(retention.MaintenanceError,'BOUND_REFERENCE_RECORDS_CHANGED'):
            self.execute_rotation(plan,a,r,policy)
        self.assertTrue(file.exists());self.assertEqual(owner.read_text(),json.dumps({'backup':str(file)}))

    def test_periodic_rotation_sidecars_corrupt_receipts_and_finite_byte_policy_fail_closed(self):
        _files,policy,plan,a,r=self.rotation_fixture();entry=plan['payload']['candidates'][0]
        sidecar=Path(entry['path']+'-wal');sidecar.write_bytes(b'owned fixture WAL')
        with self.assertRaisesRegex(retention.MaintenanceError,'NOT_FULLY_PROVED'):self.execute_rotation(plan,a,r,policy)
        sidecar.unlink();receipt=Path(entry['receipt']);raw=receipt.read_bytes();receipt.write_bytes(b'{}')
        with self.assertRaises(retention.MaintenanceError):self.execute_rotation(plan,a,r,policy)
        receipt.write_bytes(raw)
        for value in (0,-1,True,129*1024**3):
            with self.subTest(value=value),self.assertRaises(retention.MaintenanceError):
                self.plan(policy={**policy,'maxOrdinaryBytes':value},periodic_only=True)

    def test_periodic_rotation_modified_batch_cannot_substitute_receipt_hash_or_unknown_recovery(self):
        _files,policy,plan,a,r=self.rotation_fixture()
        for changes in ({'sha256':'f'*64},{'representative':str(self.keep),'representativeIdentity':retention.identity(self.keep),
                                                'representativeSha256':retention.ReadBudget().sha(self.keep)}):
            changed=copy.deepcopy(plan);changed['payload']['candidates'][0].update(changes)
            changed['digest']=retention.digest(changed['payload'])
            approved={**a,'digest':changed['digest']};resources=copy.deepcopy(r);resources['digest']=changed['digest']
            resources['files'] += [{'path':str(self.keep),'querySucceeded':True,'users':[]}]
            with self.subTest(changes=changes),self.assertRaisesRegex(retention.MaintenanceError,'NOT_FULLY_PROVED'):
                self.execute_rotation(changed,approved,resources,policy)

    @unittest.skipUnless(os.name=='nt' and shutil.which('pwsh'),'Windows exact CLI and owned resource query')
    def test_native_periodic_cli_preview_validation_and_explicit_execution_are_separate(self):
        _files,policy,plan,a,_r=self.rotation_fixture();batch=self.folder/'rotation.json'
        batch.write_bytes(retention.canonical_json(plan));approval=self.folder/'approval.json';approval.write_text(json.dumps(a))
        resources=self.folder/'resources.json'
        probe=subprocess.run(['pwsh','-NoProfile','-File',str(Path(__file__).with_name('query-retention-resources.ps1')),
                              '-Batch',str(batch),'-Output',str(resources)],capture_output=True,text=True,timeout=45)
        self.assertEqual(probe.returncode,0,probe.stdout+probe.stderr)
        command=[sys.executable,str(Path(__file__).with_name('sqlite-retention-plan.py')),
                 '--database',str(self.source),'--backup-root',str(self.root),'--periodic-only']
        env={**os.environ,'SQLITE_RETENTION_POLICY':json.dumps(policy),'SQLITE_PRODUCTION_LEGACY_ROOTS':'[]'}
        preview=subprocess.run(command,capture_output=True,text=True,timeout=15,env=env)
        self.assertEqual(preview.returncode,0,preview.stdout+preview.stderr)
        self.assertTrue(all(Path(p).exists() for p in a['paths']))
        bound=command+['--batch',str(batch),'--approval',str(approval),'--resources',str(resources)]
        validation=subprocess.run(bound,capture_output=True,text=True,timeout=15,env=env)
        self.assertEqual(validation.returncode,0,validation.stdout+validation.stderr)
        self.assertFalse(json.loads(validation.stdout)['permanentDeletionPerformed'])
        self.assertTrue(all(Path(p).exists() for p in a['paths']))
        executed=subprocess.run(bound+['--execute-periodic'],capture_output=True,text=True,timeout=20,env=env)
        self.assertEqual(executed.returncode,0,executed.stdout+executed.stderr)
        self.assertEqual(json.loads(executed.stdout)['deleted'],a['paths'])
        self.assertTrue(all(not Path(p).exists() for p in a['paths']));self.assertTrue(self.source.exists())

    @unittest.skipUnless(os.name=='nt','Windows exact-handle deletion')
    def test_native_periodic_rotation_deletes_only_approved_fixture_objects_and_replay_fails(self):
        files,policy,plan,a,r=self.rotation_fixture(count=5)
        before={str(p):p.read_bytes() for p in self.folder.rglob('*') if p.is_file()}
        result=self.execute_rotation(plan,a,r,policy)
        self.assertEqual(result['status'],'complete');self.assertTrue(result['permanentDeletionPerformed'])
        self.assertEqual(set(result['deleted']),set(a['paths']))
        self.assertEqual(set(result['deletedMetadata']),set(a['metadataPaths']))
        self.assertEqual(set(result['removedDirectories']),set(a['directories']))
        removed=set(a['paths']+a['metadataPaths'])
        for path,data in before.items():
            self.assertEqual(Path(path).exists(),path not in removed)
            if path not in removed:self.assertEqual(Path(path).read_bytes(),data)
        self.assertFalse((self.root/'.space-budget.lock').exists())
        with self.assertRaises(retention.MaintenanceError):self.execute_rotation(plan,a,r,policy)
        self.assertEqual(sum(p.exists() for p in files),2)

    @unittest.skipUnless(os.name=='nt','Windows rotation followed by real synthetic backup generation')
    def test_native_periodic_rotation_restores_capacity_for_next_backup_and_keeps_current_history(self):
        _files,policy,plan,a,r=self.rotation_fixture(count=5)
        with closing(sqlite3.connect(self.source)) as db,db:
            db.execute('CREATE TABLE articles(id INTEGER PRIMARY KEY, content)')
            db.execute('INSERT INTO articles VALUES(1,?)',('retained historical article',))
        live=self.source.read_bytes();unknown=self.old.read_bytes()
        with patch.dict(os.environ,{'SQLITE_TEST_MAX_COPIES':'5','SQLITE_TEST_MAX_BYTES':str(4*1024**2),
                                    'SQLITE_TEST_MIN_FREE_BYTES':'1','SQLITE_TEST_BUDGET_ROOT':str(self.root)}):
            with self.assertRaisesRegex(ValueError,'SPACE_BUDGET_EXCEEDED'):
                retention.backup.create_backup(self.source,self.root,prefix='periodic-snapshot')
            result=self.execute_rotation(plan,a,r,policy);self.assertEqual(result['status'],'complete')
            report=retention.backup.create_backup(self.source,self.root,prefix='periodic-snapshot')
        self.assertEqual(self.source.read_bytes(),live);self.assertEqual(self.old.read_bytes(),unknown)
        self.assertEqual(len(list(self.root.rglob('*.db'))),5)
        with closing(sqlite3.connect(report['backup'])) as db:
            self.assertEqual(db.execute('SELECT content FROM articles').fetchone(),('retained historical article',))

    @unittest.skipUnless(os.name=='nt','Windows exclusive object pins')
    def test_native_periodic_rotation_resource_and_live_handle_occupancy_never_delete(self):
        _files,policy,plan,a,r=self.rotation_fixture();file=Path(a['paths'][0])
        busy=copy.deepcopy(r)
        for row in busy['files']:
            if row['path']==str(file):row['users']=['fixture reader']
        with self.assertRaisesRegex(retention.MaintenanceError,'NOT_FULLY_PROVED'):self.execute_rotation(plan,a,busy,policy)
        with file.open('rb') as _reader:
            with self.assertRaisesRegex(retention.MaintenanceError,'EXCLUSIVE_OBJECT_PIN_FAILED'):
                self.execute_rotation(plan,a,r,policy)
        self.assertTrue(file.exists());self.assertTrue(Path(a['metadataPaths'][0]).exists())

    @unittest.skipUnless(os.name=='nt','Windows partial-action reporting')
    def test_native_periodic_rotation_partial_failure_stops_without_second_candidate_or_replay(self):
        _files,policy,plan,a,r=self.rotation_fixture(count=5)
        with patch.object(retention.WindowsPin,'delete',side_effect=OSError('synthetic pre-disposition failure')):
            uncertain=self.execute_rotation(plan,a,r,policy)
        self.assertIsNone(uncertain['permanentDeletionPerformed']);self.assertTrue(uncertain['deletionOutcomeUncertain'])
        self.assertEqual(len(uncertain['attempted']),1);self.assertTrue(all(Path(p).exists() for p in a['paths']))
        native=retention.WindowsPin.delete;calls=[]
        def fail_receipt(pin):
            calls.append(pin)
            if len(calls)==2:raise OSError('synthetic receipt deletion failure')
            return native(pin)
        with patch.object(retention.WindowsPin,'delete',fail_receipt):result=self.execute_rotation(plan,a,r,policy)
        self.assertEqual(result['status'],'partial-failed');self.assertEqual(len(result['deleted']),1)
        self.assertTrue(result['deletionOutcomeUncertain']);self.assertEqual(result['deletedMetadata'],[])
        self.assertEqual(len(result['attempted']),2);self.assertTrue(all(Path(p).exists() for p in a['metadataPaths']))
        self.assertTrue(all(Path(p).exists() for p in a['paths'] if p!=result['deleted'][0]))
        with self.assertRaises(retention.MaintenanceError):self.execute_rotation(plan,a,r,policy)

    @unittest.skipUnless(os.name=='nt','Windows no-rename object pins')
    def test_native_periodic_pin_blocks_write_or_replacement_of_same_fixture_before_delete(self):
        _files,policy,plan,a,r=self.rotation_fixture();file=Path(a['paths'][0]);native=retention.WindowsPin.sha;checked=[]
        def check_pin(pin,budget):
            if os.fstat(pin.fd).st_ino==file.stat().st_ino:
                for operation in (lambda:file.write_bytes(b'wrong object'),lambda:file.rename(file.with_suffix('.moved'))):
                    with self.assertRaises(PermissionError):operation()
                checked.append(True)
            return native(pin,budget)
        with patch.object(retention.WindowsPin,'sha',check_pin):result=self.execute_rotation(plan,a,r,policy)
        self.assertEqual(checked,[True]);self.assertEqual(result['status'],'complete')

    def test_tiered_count_plan_lists_exact_unique_history_but_never_deletes(self):
        files,policy,plan,a,r=self.tier_fixture()
        entries=[x for x in plan['payload']['candidates'] if x['kind']=='retention-expired']
        self.assertEqual([x['path'] for x in entries],[str(files[0])])
        self.assertIn('UNIQUE',entries[0]['evidence'])
        before={str(p):p.read_bytes() for p in files}
        result=self.validate(plan,a,r,policy=policy)
        self.assertIn(str(files[0]),[x['path'] for x in result['validated']])
        self.assertFalse(result['permanentDeletionPerformed'])
        self.assertEqual(before,{str(p):p.read_bytes() for p in files})

    def test_unique_history_requires_its_own_exact_path_acknowledgement(self):
        _files,policy,plan,a,r=self.tier_fixture()
        for paths in (None,[],['another file']):
            changed={**a,'uniqueHistoryPaths':paths}
            if paths is None:changed.pop('uniqueHistoryPaths')
            with self.assertRaisesRegex(retention.MaintenanceError,'UNIQUE_HISTORY_LOSS_APPROVAL'):
                self.validate(plan,changed,r,policy=policy)

    def test_policy_change_invalidates_action_time_approval(self):
        _files,policy,plan,a,r=self.tier_fixture()
        with self.assertRaisesRegex(retention.MaintenanceError,'POLICY_CHANGED'):
            self.validate(plan,a,r,policy={**policy,'maxOrdinaryCopies':3})

    def test_active_and_explicit_release_protections_override_retirement(self):
        files,policy,_plan,_a,_r=self.tier_fixture()
        (self.root/'snapshot-owner-test.json').write_text(json.dumps({'backup':str(files[0])}))
        plan=self.plan(policy=policy,protected_paths=[str(files[1])])
        self.assertTrue(all(str(x) in plan['payload']['protected'] for x in files))
        self.assertFalse([x for x in plan['payload']['candidates'] if x['kind']=='retention-expired'])

    def test_manual_manifest_is_bound_and_new_protection_invalidates_approval(self):
        files,policy,plan,a,r=self.tier_fixture()
        manifest=self.root/'retention-protected.json'
        manifest.write_text(json.dumps({'format':'sqlite-retention-protected-v1','paths':[str(files[0])]}))
        self.assertIn(str(files[0]),self.plan(policy=policy)['payload']['protected'])
        with self.assertRaisesRegex(retention.MaintenanceError,'REFERENCES_OR_GENERATION_CHANGED'):
            self.validate(plan,a,r,policy=policy)
        manifest.write_text(json.dumps({'format':'sqlite-retention-protected-v1','paths':[str(self.source)]}))
        with self.assertRaisesRegex(retention.MaintenanceError,'PROTECTION_OUTSIDE_ROOTS'):self.plan(policy=policy)

    def test_retirement_rechecks_file_identity_receipt_and_occupancy(self):
        files,policy,plan,a,r=self.tier_fixture()
        changed=copy.deepcopy(r)
        for row in changed['files']:
            if row['path']==str(files[0]):row['users']=['synthetic holder']
        self.assertNotIn(str(files[0]),[x['path'] for x in self.validate(plan,a,changed,policy=policy)['validated']])
        receipt=files[0].parent/'verification.json';raw=json.loads(receipt.read_text());raw['note']='changed'
        receipt.write_text(json.dumps(raw))
        with self.assertRaisesRegex(retention.MaintenanceError,'REFERENCES_OR_GENERATION_CHANGED'):
            self.validate(plan,a,r,policy=policy)

    def test_replaced_retirement_file_invalidates_inventory_proof(self):
        files,policy,plan,a,r=self.tier_fixture()
        replacement=files[0].with_suffix('.fixture');files[0].rename(replacement);shutil.copyfile(replacement,files[0])
        with self.assertRaisesRegex(retention.MaintenanceError,'REFERENCES_OR_GENERATION_CHANGED'):
            self.validate(plan,a,r,policy=policy)

    def test_round_window_exceeds_soft_count_instead_of_discarding_recovery(self):
        points=[self.ordinary(48+i,'write-before') for i in range(5)]
        plan=self.plan(policy={'maxOrdinaryCopies':2})
        self.assertTrue(all(str(p) in plan['payload']['protected'] for p in points))
        self.assertTrue(plan['payload']['summary']['ordinaryTargetExceeded'])
        self.assertIn('protected-time-windows-exceed-count-target',plan['payload']['summary']['warningReasons'])

    def test_configurable_time_and_48_copy_window_use_only_small_fixtures(self):
        points=[self.ordinary(2+i*12) for i in range(60)]
        plan=self.plan(policy={})
        self.assertEqual(plan['payload']['summary']['retainedOrdinaryCopies'],48)
        retired=[x for x in plan['payload']['candidates'] if x['kind']=='retention-expired']
        self.assertEqual(len(retired),12)
        self.assertTrue(all(p.exists() for p in points))
        self.assertLess(sum(p.stat().st_size for p in points),1024**2)

    def test_unmarked_or_other_source_points_are_not_claimed_by_tier_policy(self):
        unknown=self.database('unmarked',self.now-40*86400,'unmarked historic state')
        foreign=self.ordinary(960);receipt=foreign.parent/'verification.json'
        r=json.loads(receipt.read_text());r['source']=str(self.folder/'other.db');receipt.write_text(json.dumps(r))
        plan=self.plan(policy={});retired=[x['path'] for x in plan['payload']['candidates'] if x['kind']=='retention-expired']
        self.assertNotIn(str(unknown),retired);self.assertNotIn(str(foreign),retired)

    def test_finite_tier_policy_and_inconsistent_windows_fail_closed(self):
        for bad in ({'maxOrdinaryCopies':True},{'keepLatest':1},{'unknown':1},{'weeklyWeeks':5,'maximumAgeDays':28},
                    {'keepLatest':3,'maxOrdinaryCopies':2},{'recentHours':1,'bucketHours':2}):
            with self.subTest(bad=bad),self.assertRaises(retention.MaintenanceError):self.plan(policy=bad)

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
    def test_active_refresh_boundary_is_protected_and_new_boundary_invalidates_approval(self):
        reference=self.root/'refresh-recovery-owner-synthetic.json'
        plan=self.plan();reference.write_text(json.dumps({'backup':str(self.old),'source':str(self.source)}))
        self.assertIn(str(self.old),self.plan()['payload']['protected'])
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

@unittest.skipUnless(os.name=='nt','Actual Windows handles; owned tiny SQLite only')
class AutomaticRetentionTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='automatic-retention-owned-');self.addCleanup(temp.cleanup)
        self.folder=Path(temp.name).resolve();self.root=self.folder/'backups';self.root.mkdir();self.source=self.folder/'source.db'
        settings=patch.dict(os.environ,{'SQLITE_BACKUP_KIND':'test','SQLITE_TEST_MAX_BYTES':str(16*1024**2),
            'SQLITE_TEST_MAX_COPIES':'48','SQLITE_TEST_MIN_FREE_BYTES':'1','SQLITE_PRODUCTION_LEGACY_ROOTS':'[]',
            'SQLITE_PERIODIC_RETENTION_ENABLED':'0','SQLITE_PERIODIC_RETENTION_COPIES':'4',
            'SQLITE_PERIODIC_RETENTION_BYTES':str(1024**2),'SQLITE_PERIODIC_RETENTION_RESERVE_BYTES':str(2*1024**2),
            'SQLITE_PERIODIC_RETENTION_READ_BYTES':str(16*1024**2),'SQLITE_ARTICLE_HISTORY_MAINTENANCE_WINDOW':'0'})
        settings.start();self.addCleanup(settings.stop)
        with closing(sqlite3.connect(self.source)) as db,db:
            db.executescript('CREATE TABLE feeds(id TEXT PRIMARY KEY,name TEXT,sync_time INTEGER);'
                'CREATE TABLE articles(id INTEGER PRIMARY KEY,body TEXT,metric INTEGER);'
                'CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT);'
                "INSERT INTO feeds VALUES('feed','Preserved subscription',0);"
                "INSERT INTO articles VALUES(1,'Preserved complete body',7);"
                "INSERT INTO notes VALUES(1,'Preserved note');")
        (self.root/'retention-protected.json').write_text(json.dumps({'format':'sqlite-retention-protected-v1','paths':[]}))
        self.points=[];self.serial=1;self.guards=[];self.addCleanup(self.close_guards)
        spec=importlib.util.spec_from_file_location('automatic_guard',Path(__file__).with_name('sqlite-snapshot-guard.py'))
        self.guardmod=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.guardmod)
        # Exercise the actual guard tick and actual rotator, retaining one module
        # instance solely so fault injection reaches the native delete boundary.
        self.guardmod._retention_module=retention

    def close_guards(self):
        for guard in self.guards:guard.close()
        self.guards=[]

    def append(self):
        self.serial+=1
        with closing(sqlite3.connect(self.source)) as db,db:
            db.execute('INSERT INTO articles VALUES(?,?,?)',(self.serial,'Appended body '+str(self.serial),self.serial))
            db.execute('UPDATE feeds SET sync_time=?',(self.serial,))

    def seed(self,count=6,unique=False):
        for index in range(count):
            if index==1 and unique:
                with closing(sqlite3.connect(self.source)) as db,db:db.execute("UPDATE notes SET body='New note'")
            report=retention.backup.create_backup(self.source,self.root,prefix='periodic-snapshot')
            point=Path(report['backup']);self.points.append(point)
            report['createdAtUtc']=datetime.fromtimestamp(time.time()-7200-(count-index)*60,timezone.utc).isoformat()
            # This edits only fixture timestamps to exercise age eligibility.
            (point.parent/'verification.json').write_text(json.dumps(report))
            self.append()
        os.environ['SQLITE_PERIODIC_RETENTION_ENABLED']='1'

    def owner(self,**kwargs):
        guard=self.guardmod.SnapshotGuard(self.source,self.root,**kwargs);self.guards.append(guard);return guard

    def business(self):
        with closing(sqlite3.connect(self.source)) as db:
            return [list(db.execute('SELECT * FROM '+table+' ORDER BY id')) for table in ('feeds','articles','notes')]

    def test_actual_owner_rotates_append_only_points_and_restores_hard_cap_after_one_staging_slot(self):
        self.seed();os.environ['SQLITE_TEST_MAX_COPIES']='4';before=self.business();guard=self.owner();guard.tick()
        self.assertIsNotNone(guard.record,guard.status());result=guard.record['automaticRetention']
        self.assertEqual(result['status'],'complete',result);self.assertGreaterEqual(result['deletedCopies'],3)
        self.assertEqual(len(list(self.root.glob('periodic-snapshot-*/wewe-rss.db'))),4)
        self.assertFalse((self.root/'.space-budget.lock').exists());self.assertEqual(self.business(),before)
        for point in self.root.glob('periodic-snapshot-*/wewe-rss.db'):
            with closing(sqlite3.connect(point)) as db:self.assertEqual(db.execute('PRAGMA integrity_check').fetchone(),('ok',))
        self.append();guard.tick();self.assertTrue(guard.record,guard.status())
        self.assertEqual(len(list(self.root.glob('periodic-snapshot-*/wewe-rss.db'))),4)

    def test_unique_notes_body_metric_unknown_and_nullable_duplicate_keys_are_never_covered(self):
        self.seed(unique=True);guard=self.owner();guard.tick();result=guard.record['automaticRetention']
        self.assertGreaterEqual(result['heldUnique'],1,result);self.assertTrue(self.points[0].exists())
        with closing(sqlite3.connect(self.points[0])) as db:self.assertEqual(db.execute('SELECT body FROM notes').fetchone(),('Preserved note',))
        for change in ("UPDATE articles SET body='changed' WHERE id=1",'UPDATE articles SET metric=8 WHERE id=1',
                       'DELETE FROM notes'):
            with closing(sqlite3.connect(':memory:')) as old,closing(sqlite3.connect(':memory:')) as new:
                with closing(sqlite3.connect(self.points[0])) as saved:saved.backup(old);saved.backup(new)
                new.execute(change)
                self.assertFalse(retention.backup.snapshot_covers(new,old,retention.ReadBudget()))
        with closing(sqlite3.connect(':memory:')) as old,closing(sqlite3.connect(':memory:')) as new:
            for db in (old,new):db.executescript('CREATE TABLE unknown_state(id PRIMARY KEY,value);INSERT INTO unknown_state VALUES(NULL,1);')
            old.execute('INSERT INTO unknown_state VALUES(NULL,1)')
            self.assertFalse(retention.backup.snapshot_covers(new,old,retention.ReadBudget()))

    def test_copy_failure_preserves_all_old_points_and_marker_prevents_restart_allocation(self):
        self.seed();before=self.business();native=self.guardmod.backup_module._create_backup
        def failed(*args,**kwargs):native(*args,**kwargs);raise OSError('private-path-must-not-escape')
        guard=self.owner()
        with patch.object(self.guardmod.backup_module,'_create_backup',failed):guard.tick()
        self.assertIsNone(guard.record);self.assertTrue(all(p.exists() for p in self.points))
        self.assertTrue((self.root/'.space-budget.lock').exists());count=len(list(self.root.glob('periodic-snapshot-*')))
        self.close_guards();again=self.owner();again.tick()
        self.assertIsNone(again.record);self.assertEqual(again.failure['code'],'SQLITE_PERIODIC_RETENTION_HELD')
        self.assertEqual(len(list(self.root.glob('periodic-snapshot-*'))),count);self.assertEqual(self.business(),before)

    def test_interruption_after_first_exact_delete_keeps_two_recovery_points_and_does_not_replay(self):
        self.seed(unique=True);guard=self.owner();native=retention.WindowsPin.delete;calls=[]
        def interrupted(pin):
            native(pin);calls.append(True);raise KeyboardInterrupt('owned interruption after native close')
        with patch.object(retention.WindowsPin,'delete',interrupted),self.assertRaises(KeyboardInterrupt):guard.tick()
        self.assertEqual(len(calls),1);self.assertTrue(self.points[0].exists())
        saved=Path(guard.record['backup']);self.assertTrue(saved.exists())
        self.assertGreaterEqual(len(list(self.root.glob('periodic-snapshot-*/wewe-rss.db'))),2)
        self.assertTrue((self.root/'.space-budget.lock').exists());count=len(list(self.root.glob('periodic-snapshot-*')))
        self.close_guards();again=self.owner();again.tick();self.assertIsNone(again.record)
        self.assertEqual(len(list(self.root.glob('periodic-snapshot-*'))),count)

    def test_live_candidate_reader_and_unknown_backlog_hold_without_unlimited_staging(self):
        self.seed();os.environ['SQLITE_TEST_MAX_COPIES']='2';guard=self.owner()
        streams=[p.open('rb') for p in self.points]
        try:guard.tick()
        finally:
            for stream in streams:stream.close()
        self.assertTrue(guard.record);self.assertTrue(all(p.exists() for p in self.points))
        self.assertEqual(guard.record['automaticRetention']['status'],'held');self.assertTrue((self.root/'.space-budget.lock').exists())
        self.append();count=len(list(self.root.glob('periodic-snapshot-*')));guard.tick()
        self.assertIsNone(guard.record);self.assertEqual(len(list(self.root.glob('periodic-snapshot-*'))),count)
        # Ordinary committed source updates do not borrow snapshot/retention credit.
        self.append();self.assertEqual(self.business()[1][-1][0],self.serial)

    def test_existing_manifest_protection_and_history_window_are_respected(self):
        self.seed();manifest=self.root/'retention-protected.json'
        manifest.write_text(json.dumps({'format':'sqlite-retention-protected-v1','paths':[str(self.points[0])]}))
        guard=self.owner();guard.tick();self.assertTrue(guard.record,guard.status());self.assertTrue(self.points[0].exists())
        self.append();os.environ['SQLITE_ARTICLE_HISTORY_MAINTENANCE_WINDOW']='1';guard.tick()
        self.assertTrue(guard.record);self.assertEqual(guard.record['automaticRetention']['code'],'HISTORY_MAINTENANCE_ACTIVE')
        self.assertTrue((self.root/'.space-budget.lock').exists())

    def test_reserve_growth_and_full_snapshot_concurrency_never_delete_old_points(self):
        self.seed();guard=self.owner();key=hashlib.sha256(str(self.source).encode()).hexdigest()[:24]
        with retention.backup.FileLock(self.source.parent/f'.full-snapshot-{key}.lock'):
            with self.assertRaises(TimeoutError):retention.backup.create_backup(self.source,self.root,prefix='periodic-snapshot',timeout=.02)
        self.assertTrue(all(p.exists() for p in self.points));self.assertFalse((self.root/'.space-budget.lock').exists())
        native=self.guardmod.backup_module._create_backup
        def grow(*args,**kwargs):
            with closing(sqlite3.connect(self.source)) as db,db:db.execute('INSERT INTO notes VALUES(2,?)',('x'*(1200*1024),))
            return native(*args,**kwargs)
        with patch.object(self.guardmod.backup_module,'_create_backup',grow):guard.tick()
        self.assertIsNone(guard.record);self.assertEqual(guard.failure['code'],'SQLITE_PERIODIC_RETENTION_RESERVE_EXCEEDED')
        self.assertTrue(all(p.exists() for p in self.points));self.assertTrue((self.root/'.space-budget.lock').exists())
        self.assertLess(sum(p.stat().st_size for p in self.root.glob('periodic-snapshot-*/*')),2*1024**2)

    def test_growth_during_real_online_backup_aborts_within_one_bounded_staging_reserve(self):
        self.seed();guard=self.owner();module=self.guardmod.backup_module;connect=sqlite3.connect;grew=[]
        with closing(connect(self.source)) as db,db:db.execute('INSERT INTO notes VALUES(2,?)',('x'*(400*1024),))
        source=self.source
        class GrowingConnection(sqlite3.Connection):
            def backup(connection,destination,**kwargs):
                progress=kwargs['progress']
                def observed(status,remaining,total):
                    progress(status,remaining,total)
                    if not grew:
                        grew.append(True)
                        with closing(connect(source)) as writer,writer:
                            writer.execute('INSERT INTO notes VALUES(3,?)',('y'*(900*1024),))
                return super().backup(destination,**{**kwargs,'progress':observed})
        def instrument(*args,**kwargs):
            if str(args[0]).startswith(self.source.as_uri()):kwargs['factory']=GrowingConnection
            return connect(*args,**kwargs)
        with patch.object(module.sqlite3,'connect',instrument):guard.tick()
        self.assertEqual(grew,[True]);self.assertIsNone(guard.record)
        self.assertEqual(guard.failure['code'],'SQLITE_PERIODIC_RETENTION_RESERVE_EXCEEDED')
        self.assertTrue(all(p.exists() for p in self.points));self.assertTrue((self.root/'.space-budget.lock').exists())
        self.assertLess(sum(p.stat().st_size for p in self.root.glob('periodic-snapshot-*/*')),2*1024**2)

    def test_same_pid_lease_rewrite_is_not_adopted_after_verified_copy(self):
        self.seed();native=self.guardmod.backup_module.create_backup
        def altered(*args,**kwargs):
            report=native(*args,**kwargs);lease=self.root/'.space-budget.lock'
            value=json.loads(lease.read_text());value['unownedExtra']='changed';lease.write_text(json.dumps(value))
            return report
        guard=self.owner(backup=altered);guard.tick()
        self.assertTrue(guard.record);self.assertEqual(guard.record['automaticRetention']['code'],'AUTO_LEASE_CHANGED')
        self.assertTrue(all(p.exists() for p in self.points));self.assertTrue((self.root/'.space-budget.lock').exists())

    def test_late_manual_reference_publication_is_blocked_by_actual_native_reference_pin(self):
        self.seed();guard=self.owner();manifest=self.root/'retention-protected.json';native=retention.WindowsPin.sha;attempts=[];denied=[]
        original=manifest.read_bytes()
        def attempted(pin,budget):
            result=native(pin,budget)
            if not attempts:
                attempts.append(True)
                try:manifest.write_text(json.dumps({'format':'sqlite-retention-protected-v1','paths':[str(self.points[0])]}))
                except PermissionError:denied.append(True)
            return result
        with patch.object(retention.WindowsPin,'sha',attempted):guard.tick()
        self.assertEqual(attempts,[True]);self.assertEqual(denied,[True]);self.assertTrue(guard.record)
        self.assertEqual(manifest.read_bytes(),original)
        self.assertEqual(guard.record['automaticRetention']['status'],'complete')
        self.assertGreater(guard.record['automaticRetention']['deletedCopies'],0)

    def test_protected_origin_and_unknown_files_survive_automatic_retirement(self):
        self.seed();receipt=self.points[0].parent/'verification.json';value=json.loads(receipt.read_text())
        value['recoveryOrigin']['kind']='protected';receipt.write_text(json.dumps(value))
        unknown=self.root/'unknown.sqlite';unknown.write_bytes(b'unique unknown historical bytes')
        guard=self.owner();guard.tick();self.assertTrue(guard.record,guard.status())
        self.assertTrue(self.points[0].exists());self.assertEqual(unknown.read_bytes(),b'unique unknown historical bytes')
        self.assertGreater(guard.record['automaticRetention']['deletedCopies'],0)

if __name__=='__main__':unittest.main()
