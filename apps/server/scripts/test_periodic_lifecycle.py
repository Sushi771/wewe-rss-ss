"""Owned tiny SQLite only: no deployment, network, production reads or cleanup."""
from contextlib import closing
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


def load(name, file):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


backup=load('daily_backup_test','backup-sqlite.py')
lifecycle=backup.periodic_lifecycle()
r=lifecycle.retention()
guard_module=load('daily_guard_test','sqlite-snapshot-guard.py')


@unittest.skipUnless(os.name=='nt','Actual Windows pinned marker release')
class LifecycleTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='daily-lifecycle-owned-');self.addCleanup(temp.cleanup)
        self.folder=Path(temp.name).resolve();self.database=self.folder/'source.db'
        self.root=self.folder/'backups';self.root.mkdir()
        self.now=float(int(time.time()));self.serial=0
        settings=patch.dict(os.environ,{'SQLITE_BACKUP_KIND':'test','SQLITE_TEST_MAX_BYTES':str(16*1024**2),
            'SQLITE_TEST_MAX_COPIES':'12','SQLITE_TEST_MIN_FREE_BYTES':'1','SQLITE_PRODUCTION_LEGACY_ROOTS':'[]',
            'SQLITE_SNAPSHOT_INTERVAL_SECONDS':'86400','SQLITE_PERIODIC_RETENTION_ENABLED':'0',
            'SQLITE_PERIODIC_LIFECYCLE_ENABLED':'1',
            'SQLITE_PERIODIC_RETENTION_COPIES':'3','SQLITE_PERIODIC_RETENTION_BYTES':str(1024**2),
            'SQLITE_PERIODIC_RETENTION_RESERVE_BYTES':str(2*1024**2),
            'SQLITE_PERIODIC_RETENTION_READ_BYTES':str(16*1024**2)})
        settings.start();self.addCleanup(settings.stop)
        with closing(sqlite3.connect(self.database)) as db,db:
            db.executescript("CREATE TABLE feeds(id INTEGER PRIMARY KEY,sync_time INTEGER);"
                "CREATE TABLE articles(id INTEGER PRIMARY KEY,body TEXT,metric INTEGER,"
                "derived INTEGER GENERATED ALWAYS AS (metric*2) STORED);"
                "CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT);"
                "INSERT INTO feeds VALUES(1,0);INSERT INTO articles(id,body,metric) VALUES(1,'old complete body',5);"
                "INSERT INTO notes VALUES(1,'old note');")
        (self.root/'retention-protected.json').write_text(json.dumps({'format':'sqlite-retention-protected-v1','paths':[]}))

    def create(self):
        # Virtualize the original copy clock as well as the persisted cadence;
        # the receipt is emitted by the actual writer, never retagged afterward.
        with patch.object(backup,'datetime') as clock:
            clock.now.return_value=datetime.fromtimestamp(self.now,timezone.utc)
            return backup.create_backup(self.database,self.root,prefix='periodic-snapshot',periodic_now=self.now)

    def change(self):
        self.serial+=1
        with closing(sqlite3.connect(self.database)) as db,db:
            db.execute('INSERT INTO articles(id,body,metric) VALUES(?,?,?)',(self.serial+1,'new body',self.serial))
            db.execute('UPDATE feeds SET sync_time=?',(self.serial,))

    def copies(self):
        return sorted(self.root.glob('periodic-snapshot-*/wewe-rss.db'))

    def state(self):
        with lifecycle.Store(self.database,self.root) as store:
            return json.loads(json.dumps(store.state))

    def fill(self):
        for _ in range(3):
            self.create();self.change();self.now+=86400
        return self.create()

    def inputs(self):
        policy={**r.POLICY_DEFAULTS,'maxOrdinaryCopies':3,'maxOrdinaryBytes':int(os.environ['SQLITE_PERIODIC_RETENTION_BYTES']),
                'keepLatest':2,'recentHours':1,'bucketHours':1,'dailyDays':1,'weeklyWeeks':0,'expectedGenerationsPerDay':1}
        # Fixture timestamps are genuine current copy times; age policy needs
        # future logical review time. No receipt is edited to produce eligibility.
        now=int(self.now)+7200
        plan=r.make_plan(self.database,self.root,now=now,policy=policy,periodic_only=True)
        approval={'batchId':plan['batchId'],'digest':plan['digest'],'action':'rotate-exact-periodic-backups',
                  'approvedAtEpoch':now,'paths':[e['path'] for e in plan['payload']['candidates']],
                  'metadataPaths':[e['receipt'] for e in plan['payload']['candidates']],
                  'directories':[e['directory'] for e in plan['payload']['candidates']],
                  'uniqueHistoryPaths':[e['path'] for e in plan['payload']['candidates']]}
        resources={'batchId':plan['batchId'],'digest':plan['digest'],'checkedAtEpoch':now,
                   'files':[{'path':file,'querySucceeded':True,'users':[]} for file in sorted({
                       x for e in plan['payload']['candidates'] for x in (e['path'],e['representative'])})]}
        return plan,approval,resources,now,policy

    def execute(self,inputs):
        plan,approval,resources,now,policy=inputs
        return r.execute_periodic_batch(plan,approval,resources,now=now,policy=policy)

    def test_changed_restart_not_due_and_unchanged_complete_proof_preserve_original_generation(self):
        first=self.create();original=self.state()['lastGenerationEpoch']
        for _ in range(3):
            self.now+=60
            reused=self.create()
            self.assertTrue(reused['reused']);self.assertEqual(reused['startedAtUtc'],first['startedAtUtc'])
            self.assertEqual(self.state()['lastGenerationEpoch'],original)
        self.change()
        for _ in range(4):
            with self.assertRaisesRegex(ValueError,'SQLITE_PERIODIC_NOT_DUE'):self.create()
        self.assertEqual(len(self.copies()),1)
        self.now=original+86400
        self.assertFalse(self.create()['reused']);self.assertEqual(len(self.copies()),2)

    def test_actual_owner_changed_restart_has_no_fresh_lease_and_retries_at_saved_boundary(self):
        self.create();self.change();self.now+=3600
        guard=guard_module.SnapshotGuard(self.database,self.root,interval=86400,max_age=86400,
            wall=lambda:self.now,monotonic=lambda:1000)
        try:
            guard.tick();self.assertFalse(guard.query()['fresh'])
            self.assertEqual(guard.status()['failure']['code'],'SQLITE_PERIODIC_NOT_DUE')
            self.assertEqual(guard.next_check,1000+82800)
            self.assertEqual(len(self.copies()),1)
        finally:guard.close()

    def test_one_pending_fourth_never_fifth_after_restart_or_config_change(self):
        report=self.fill();self.assertEqual(report['periodicLifecycleStatus']['pendingCopies'],1)
        self.assertEqual(len(self.copies()),4);self.assertEqual(len(self.state()['normal']),3)
        self.assertTrue(self.create()['reused'])
        self.change();self.now+=86400
        for _ in range(3):
            with self.assertRaisesRegex(ValueError,'PENDING_CONFIRMATION'):self.create()
        with patch.dict(os.environ,{'SQLITE_SNAPSHOT_INTERVAL_SECONDS':'900'}):
            with self.assertRaises(ValueError):self.create()
        with patch.dict(os.environ,{'SQLITE_PERIODIC_RETENTION_COPIES':'4'}):
            with self.assertRaises(ValueError):self.create()
        with patch.dict(os.environ,{'SQLITE_PERIODIC_LIFECYCLE_ENABLED':'0'}):
            with self.assertRaisesRegex(ValueError,'LIFECYCLE_HELD'):self.create()
        self.assertEqual(len(self.copies()),4)

    def test_copy_failure_spends_same_credit_before_io_and_cannot_retry(self):
        with patch.object(backup,'_create_backup',side_effect=TimeoutError('owned copy fault')):
            with self.assertRaises(TimeoutError):self.create()
        self.assertEqual(self.state()['status'],'copy-intent')
        with self.assertRaisesRegex(ValueError,'LIFECYCLE_HELD'):self.create()
        self.assertEqual(len(self.copies()),0)

    def test_partial_state_write_cannot_replay_consumed_copy_intent(self):
        native=os.write
        def partial(fd,data):
            try:value=json.loads(data)
            except ValueError:value={}
            if value.get('payload',{}).get('status')=='copy-intent':
                return native(fd,data[:7])
            return native(fd,data)
        with patch.object(os,'write',partial):
            with self.assertRaises(ValueError):self.create()
        with self.assertRaises(ValueError):self.create()
        self.assertEqual(self.copies(),[])

    def test_crash_after_durable_intent_cannot_create_marker_or_copy_on_retry(self):
        native=lifecycle.Store.save
        def interrupted(store):
            native(store)
            if store.state['status']=='copy-intent':raise OSError('owned post-fsync crash')
        with patch.object(lifecycle.Store,'save',interrupted):
            with self.assertRaises(OSError):self.create()
        self.assertEqual(self.state()['status'],'copy-intent')
        with self.assertRaises(ValueError):self.create()
        self.assertEqual(self.copies(),[])

    def test_verified_copy_release_failure_holds_same_credit_and_preserves_copy(self):
        with patch.object(lifecycle,'release_marker',side_effect=OSError('owned release failure')):
            with self.assertRaises(OSError):self.create()
        self.assertEqual(self.state()['status'],'releasing')
        self.assertEqual(len(self.copies()),1)
        with self.assertRaisesRegex(ValueError,'LIFECYCLE_HELD'):self.create()
        self.assertTrue((self.root/'.space-budget.lock').exists())

    def test_crash_after_actual_marker_release_before_ready_save_stays_held(self):
        native=lifecycle.Store.save
        def interrupted(store):
            if store.state['status']=='ready' and store.state['sequence']==1:
                raise OSError('owned final state save crash')
            native(store)
        with patch.object(lifecycle.Store,'save',interrupted):
            with self.assertRaises(OSError):self.create()
        self.assertEqual(self.state()['status'],'releasing')
        self.assertFalse((self.root/'.space-budget.lock').exists())
        with self.assertRaisesRegex(ValueError,'LIFECYCLE_HELD'):self.create()
        self.assertEqual(len(self.copies()),1)

    def test_pending_publication_failure_retains_four_files_and_never_retries_copy(self):
        for _ in range(3):self.create();self.change();self.now+=86400
        native=lifecycle.Store.save
        def interrupted(store):
            if store.state['status']=='pending-confirmation':raise OSError('owned pending publication fault')
            native(store)
        with patch.object(lifecycle.Store,'save',interrupted):
            with self.assertRaises(OSError):self.create()
        self.assertEqual(len(self.copies()),4)
        with self.assertRaises(ValueError):self.create()
        self.assertEqual(len(self.copies()),4)

    def test_native_state_and_allocation_pins_refuse_same_path_write_or_replacement(self):
        native=backup._create_backup;seen=[]
        def copy(*args,**kwargs):
            state=lifecycle.paths(self.database,self.root)[1]
            for operation in (lambda:state.write_bytes(b'foreign'),lambda:state.rename(state.with_suffix('.moved'))):
                with self.assertRaises(PermissionError):operation()
            seen.append('state-pinned')
            return native(*args,**kwargs)
        marker_delete=r.WindowsPin.delete
        def release(pin):
            file=self.root/'.space-budget.lock'
            if file.exists() and os.fstat(pin.fd).st_ino==file.stat().st_ino:
                for operation in (lambda:file.write_bytes(b'foreign'),lambda:file.rename(file.with_suffix('.moved'))):
                    with self.assertRaises(PermissionError):operation()
                seen.append('marker-pinned')
            return marker_delete(pin)
        with patch.object(backup,'_create_backup',copy),patch.object(r.WindowsPin,'delete',release):self.create()
        self.assertEqual(seen,['state-pinned','marker-pinned']);self.assertEqual(self.state()['status'],'ready')

    def test_state_partial_write_and_missing_marker_cannot_allocate_again(self):
        self.fill();self.change();self.now+=86400
        (self.root/'.space-budget.lock').unlink()  # Owned fault, never production.
        with self.assertRaises((ValueError,OSError)):self.create()
        self.assertEqual(len(self.copies()),4)
        _init,state=lifecycle.paths(self.database,self.root);state.write_bytes(b'{partial')
        with self.assertRaises(ValueError):self.create()
        self.assertEqual(len(self.copies()),4)

    def test_deleted_controls_cannot_readopt_tagged_copies(self):
        self.create()
        for file in lifecycle.paths(self.database,self.root):file.unlink()
        self.change();self.now+=86400
        with self.assertRaises(ValueError):self.create()
        self.assertEqual(len(self.copies()),1)

    def test_protected_and_unknown_origin_points_remain_separate_and_global_cap_is_not_relaxed(self):
        protected=backup.create_backup(self.database,self.root)
        unknown=self.root/'periodic-snapshot-20000101T000000Z-12345678';unknown.mkdir()
        (unknown/'wewe-rss.db').write_bytes(b'unknown legacy bytes')
        self.change();self.fill();self.assertEqual(len(self.state()['normal']),3)
        self.assertTrue(Path(protected['backup']).exists());self.assertTrue((unknown/'wewe-rss.db').exists())
        self.assertEqual(len(self.copies()),5)  # Four explicit + one unknown.

    def test_global_count_ceiling_refuses_fourth_without_staging_exemption(self):
        for _ in range(3):self.create();self.change();self.now+=86400
        with patch.dict(os.environ,{'SQLITE_TEST_MAX_COPIES':'3'}):
            with self.assertRaisesRegex(ValueError,'SQLITE_SPACE_BUDGET_EXCEEDED'):self.create()
        self.assertEqual(len(self.copies()),3);self.assertEqual(self.state()['status'],'ready')

    def test_retirement_keeps_same_pending_when_regular_byte_target_is_still_exceeded(self):
        with patch.dict(os.environ,{'SQLITE_PERIODIC_RETENTION_BYTES':str(3*self.database.stat().st_size)}):
            for _ in range(3):self.create();self.change();self.now+=86400
            with closing(sqlite3.connect(self.database)) as db,db:
                db.execute('INSERT INTO articles(id,body,metric) VALUES(99,?,0)',('x'*(128*1024),))
            self.create();pending=self.state()['pending']['path']
            outcome=self.execute(self.inputs())
            self.assertEqual(outcome['status'],'complete')
            self.assertEqual(self.state()['status'],'pending-confirmation')
            self.assertEqual(self.state()['pending']['path'],pending)
            self.assertEqual(len(self.state()['normal']),2)
            self.change();self.now+=86400
            with self.assertRaisesRegex(ValueError,'PENDING_CONFIRMATION'):self.create()
            self.assertEqual(len(self.copies()),3)

    def test_no_automatic_delete_switch_can_bypass_confirmation(self):
        self.fill()
        with patch.dict(os.environ,{'SQLITE_PERIODIC_RETENTION_ENABLED':'1'}):
            with self.assertRaisesRegex(ValueError,'CONFIRMATION_REQUIRED'):self.create()
        self.assertEqual(len(self.copies()),4)

    def test_receipt_origin_change_and_extra_periodic_point_are_not_free_credit(self):
        self.create();self.change();self.now+=86400
        receipt=self.copies()[0].parent/'verification.json';value=json.loads(receipt.read_text())
        value['recoveryOrigin']['kind']='protected';receipt.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError,'EVIDENCE_INVALID'):self.create()
        self.assertEqual(len(self.copies()),1)

    def test_exact_confirmation_retires_oldest_and_promotes_same_pending_then_replay_refused(self):
        self.fill();inputs=self.inputs();self.assertEqual(len(inputs[0]['payload']['candidates']),1)
        checked=r.validate_batch(*inputs[:3],now=inputs[3],policy=inputs[4])
        self.assertEqual(checked['skipped'],[])
        old=Path(inputs[0]['payload']['candidates'][0]['path']);pending=self.state()['pending']['path']
        outcome=self.execute(inputs)
        self.assertEqual(outcome['status'],'complete',outcome);self.assertFalse(old.exists())
        self.assertEqual(len(self.copies()),3);self.assertEqual(self.state()['normal'][-1]['path'],pending)
        self.assertEqual(self.state()['status'],'ready');self.assertFalse((self.root/'.space-budget.lock').exists())
        with self.assertRaises(ValueError):self.execute(inputs)

    def test_real_owner_cli_restarts_with_changed_source_without_copy_or_fresh_lease(self):
        self.create();self.change()
        script=Path(__file__).with_name('sqlite-snapshot-guard.py')
        command=[sys.executable,str(script),'--database',str(self.database),'--backup-root',str(self.root),
                 '--interval-seconds','86400','--max-age-seconds','86400']
        for _ in range(2):
            result=subprocess.run(command,input=json.dumps({'id':1,'operation':'query'})+'\n',
                                  text=True,capture_output=True,timeout=15)
            self.assertEqual(result.returncode,0,result.stderr)
            rows=[json.loads(line) for line in result.stdout.splitlines()]
            status=next(x for x in rows if x.get('event')=='periodic-snapshot-status')
            self.assertEqual(status['failure']['code'],'SQLITE_PERIODIC_NOT_DUE')
            query=next(x for x in rows if x.get('id')==1)
            self.assertFalse(query['result']['fresh'])
        self.assertEqual(len(self.copies()),1)

    def test_missing_or_denied_confirmation_and_changed_references_delete_nothing(self):
        self.fill();inputs=self.inputs();before=self.copies()
        inputs[1]['action']='denied'
        with self.assertRaisesRegex(ValueError,'APPROVAL'):self.execute(inputs)
        self.assertEqual(self.copies(),before);self.assertEqual(self.state()['status'],'pending-confirmation')
        inputs=self.inputs()
        (self.root/'retention-protected.json').write_text(json.dumps({'format':'sqlite-retention-protected-v1','paths':[str(before[0])]}))
        with self.assertRaises(ValueError):self.execute(inputs)
        self.assertEqual(self.copies(),before)

    def test_unique_note_and_stored_generated_value_hold_even_with_exact_approval(self):
        self.unique_hold("UPDATE notes SET body='changed note'")

    def test_changed_stored_generated_value_alone_is_never_retired(self):
        self.unique_hold('UPDATE articles SET metric=6 WHERE id=1')

    def unique_hold(self, sql):
        self.create();self.change();self.now+=86400
        with closing(sqlite3.connect(self.database)) as db,db:
            db.execute(sql)
        for _ in range(2):self.create();self.change();self.now+=86400
        self.create();before=self.copies()
        with self.assertRaisesRegex(ValueError,'UNIQUE_HISTORY_HELD'):self.execute(self.inputs())
        self.assertEqual(self.copies(),before);self.assertEqual(self.state()['status'],'pending-confirmation')

    def test_copy_growth_cannot_exceed_single_staging_byte_cap(self):
        with closing(sqlite3.connect(self.database)) as db,db:
            db.execute('INSERT INTO articles(id,body,metric) VALUES(99,?,0)',('x'*(1024**2+4096),))
        with self.assertRaisesRegex(ValueError,'RESERVE_EXCEEDED'):self.create()
        self.assertEqual(self.state()['status'],'copy-intent')
        self.assertLessEqual(sum(p.stat().st_size for p in self.copies()),1024**2)
        with self.assertRaisesRegex(ValueError,'LIFECYCLE_HELD'):self.create()

    def test_uncertain_retirement_spends_credit_and_fresh_approval_cannot_replay(self):
        self.fill();inputs=self.inputs();before=self.copies()
        with patch.object(r,'_delete_pinned_points',side_effect=OSError('owned delete fault')):
            with self.assertRaises(OSError):self.execute(inputs)
        self.assertEqual(self.state()['status'],'retirement-started')
        with self.assertRaises(ValueError):self.execute(inputs)
        with self.assertRaises(ValueError):self.inputs()
        self.assertEqual(self.copies(),before)

    def test_native_partial_delete_never_replays_or_allocates_fifth(self):
        self.fill();inputs=self.inputs();native=r.WindowsPin.delete;calls=[]
        def fail_receipt(pin):
            calls.append(pin)
            if len(calls)==2:raise OSError('owned receipt delete failure')
            return native(pin)
        with patch.object(r.WindowsPin,'delete',fail_receipt):outcome=self.execute(inputs)
        self.assertEqual(outcome['status'],'partial-failed')
        self.assertEqual(self.state()['status'],'retirement-started')
        with self.assertRaises(ValueError):self.execute(inputs)
        self.change();self.now+=86400
        with self.assertRaises((ValueError,OSError)):self.create()
        self.assertEqual(len(self.copies()),3)


class IntervalTests(unittest.TestCase):
    def test_strict_interval_and_defaults(self):
        self.assertEqual(lifecycle.interval('900'),900);self.assertEqual(lifecycle.interval('86400'),86400)
        for value in ('0','59','86401','900.0','+900','900\n','nan',' 900'):
            with self.subTest(value=value),self.assertRaises(ValueError):lifecycle.interval(value)


if __name__=='__main__':unittest.main()
