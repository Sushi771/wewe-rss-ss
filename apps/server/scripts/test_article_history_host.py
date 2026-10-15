"""Real SnapshotGuard + tiny synthetic databases. No production or platforms."""
from contextlib import closing
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

import article_history as history
import article_history_host as host
from test_article_history import database, fake_browser

spec = importlib.util.spec_from_file_location('history_test_owner', Path(__file__).with_name('sqlite-snapshot-guard.py'))
owner_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner_module)


def free_resources(paths):
    return {'querySucceeded': True, 'checkedAtEpoch': int(time.time()),
            'files': [{'path': str(path), 'users': []} for path in paths]}


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='history-host-test-')
        self.root = Path(self.temp.name)
        self.live = self.root / 'live.db'
        self.old_root = self.root / 'old'
        self.old_root.mkdir()
        self.old = self.old_root / 'old.db'
        self.backups = self.root / 'recoveries'
        database(self.live, '<p>previous body</p>')
        database(self.old, '<p>historical body</p>')
        self.owner = owner_module.SnapshotGuard(self.live, self.backups)
        self.owner.tick()
        self.assertIsNotNone(self.owner.record)
        self.previous = Path(self.owner.record['backup'])
        with closing(sqlite3.connect(self.live, isolation_level=None)) as db:
            db.execute("UPDATE articles SET content_html='<p>current body</p>'")
        self.owner.tick()
        self.assertNotEqual(self.previous, Path(self.owner.record['backup']))
        self.refs = self.root / 'active.json'
        self.refs.write_text(json.dumps({'format': 'article-history-references-v1', 'paths': [str(self.live)]}))
        self.config = {'sourceRoots': [str(self.old_root)], 'recoveryRoots': [str(self.backups)],
                       'archiveRoot': str(self.root / 'archives'), 'previous': str(self.previous),
                       'referenceFiles': [str(self.refs)]}
        self.service = host.HistoryReviewHost(self.owner, self.config)
        self.service.registry.sync_runtime({'format': 'wewe-history-runtime-v1', 'scope': 'sqlite-coordinator-held', 'paths': []})
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.owner.close)
        for patcher in (patch.object(history, 'browser_check', side_effect=fake_browser),
                        patch.object(host, 'resource_probe', side_effect=free_resources)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def review(self):
        return self.service.review([str(self.old)])

    def approval(self, plan):
        return {'action': 'permanent-delete-exact-files', 'batchSha256': plan['batchSha256'],
                'approvedAtEpoch': int(time.time()), 'paths': [str(self.old.resolve())]}

    def test_real_owner_full_chain_generates_exact_hashed_review_not_delete(self):
        plan = self.review()
        self.assertEqual(len(plan['eligible']), 1)
        self.assertEqual(len(plan['eligible'][0]['sha256']), 64)
        self.assertEqual(plan['sourceStateCoverage'][0]['coveredBy'], 'owner')
        self.assertTrue(plan['requiresSpecificBatchApproval'])
        self.assertFalse(plan['executable'])
        self.assertFalse(plan['permanentDeletionPerformed'])
        self.assertTrue(self.old.exists())
        self.assertNotIn('NEVER-ARCHIVE-THIS-TEST-TOKEN', json.dumps(plan))
        validated = self.service.validate_approval(plan, self.approval(plan))
        self.assertTrue(validated['approvedForReview'])
        self.assertFalse(validated['executable'])
        self.assertTrue(self.old.exists())

    def test_uncovered_account_queue_or_other_state_cannot_generate_plan(self):
        with closing(sqlite3.connect(self.old, isolation_level=None)) as db:
            db.execute("INSERT INTO accounts VALUES('old unique private value')")
        with self.assertRaisesRegex(host.HostError, 'NON_ARTICLE_STATE_UNCOVERED'):
            self.review()
        self.assertFalse((self.root / 'archives').exists())

    def test_schema_difference_holds_even_when_no_extra_rows(self):
        with closing(sqlite3.connect(self.old, isolation_level=None)) as db:
            db.execute('CREATE TABLE unknown_queue(id TEXT)')
        with self.assertRaisesRegex(host.HostError, 'NON_ARTICLE_STATE_UNCOVERED'):
            self.review()

    def test_duplicate_nonarticle_rows_need_multiplicity_coverage(self):
        with closing(sqlite3.connect(self.old, isolation_level=None)) as db:
            db.execute('INSERT INTO accounts SELECT token FROM accounts')
        with self.assertRaisesRegex(host.HostError, 'NON_ARTICLE_STATE_UNCOVERED'):
            self.review()

    def test_forged_disk_receipt_is_not_owner_authority(self):
        self.owner.receipt.write_text('{"verified":true,"sha256":"' + 'a' * 64 + '"}')
        with self.assertRaises(host.HostError):
            self.review()

    def test_owner_unsnapshotted_writes_hold(self):
        with closing(sqlite3.connect(self.live, isolation_level=None)) as db:
            db.execute("UPDATE accounts SET token='new state'")
        with self.assertRaisesRegex(host.HostError, 'UNSNAPSHOTTED'):
            self.review()

    def test_active_disk_and_inmemory_references_protect_candidates(self):
        self.service.registry.pin('restore', self.old)
        with self.assertRaisesRegex(host.HostError, 'ACTIVE_OR_PROTECTED'):
            self.review()
        self.service.registry.unpin('restore')
        self.refs.write_text(json.dumps({'format': 'article-history-references-v1', 'paths': [str(self.old)]}))
        with self.assertRaisesRegex(host.HostError, 'ACTIVE_OR_PROTECTED'):
            self.review()

    def test_missing_reference_record_and_corrupt_recovery_hold(self):
        self.refs.write_text('{invalid')
        with self.assertRaises(ValueError):
            self.review()
        self.refs.write_text('{"format":"article-history-references-v1","paths":[]}')
        self.previous.write_bytes(b'not a recovery database')
        with self.assertRaises(sqlite3.DatabaseError):
            self.review()

    def test_reference_changes_during_browser_and_owner_rotation_hold(self):
        def mutate(root, pages):
            self.refs.write_text(json.dumps({'format': 'article-history-references-v1', 'paths': [str(self.old)]}))
            return fake_browser(root, pages)
        with patch.object(history, 'browser_check', side_effect=mutate):
            with self.assertRaisesRegex(host.HostError, 'REFERENCES_CHANGED'):
                self.review()

    def test_unconnected_runtime_and_unknown_catalog_hold(self):
        self.service.registry.runtime_paths = None
        with self.assertRaisesRegex(host.HostError, 'NOT_CONNECTED'):
            self.review()
        self.service.registry.sync_runtime({'format': 'wewe-history-runtime-v1', 'scope': 'sqlite-coordinator-held', 'paths': []})
        self.refs.write_text('{}')
        with self.assertRaisesRegex(host.HostError, 'FORMAT_UNSUPPORTED'):
            self.review()

    def test_relative_and_file_uri_references_protect(self):
        for path in ('old/old.db', self.old.as_uri()):
            self.refs.write_text(json.dumps({'format': 'article-history-references-v1', 'paths': [path]}))
            with self.assertRaisesRegex(host.HostError, 'ACTIVE_OR_PROTECTED'):
                self.review()

    def test_actual_active_release_pointer_format_resolves_subtree(self):
        release = self.old_root / 'release-123'
        release.mkdir()
        (release / 'release.json').write_text('{"id":"release-123"}')
        old = release / 'old.db'
        database(old)
        active = self.old_root / 'active.json'
        active.write_text('{"format":1,"id":"release-123"}')
        with self.assertRaisesRegex(host.HostError, 'ACTIVE_OR_PROTECTED'):
            self.service.review([str(old)])

    def test_new_reference_record_during_resource_query_holds(self):
        def mutate(paths):
            (self.backups / 'retention-protected.json').write_text(json.dumps({'format':'sqlite-retention-protected-v1','paths':[str(self.old)]}))
            return free_resources(paths)
        with patch.object(host, 'resource_probe', side_effect=mutate):
            with self.assertRaisesRegex(host.HostError, 'REFERENCES_CHANGED'):
                self.review()

    def test_maintenance_window_is_required_at_owner_boundary(self):
        with patch.dict(os.environ, {'SQLITE_ARTICLE_HISTORY_REVIEW_ENABLED': '1', 'SQLITE_ARTICLE_HISTORY_MAINTENANCE_WINDOW': '0'}):
            with self.assertRaisesRegex(host.HostError, 'MAINTENANCE_WINDOW'):
                host.from_environment(self.owner)

    def test_expiry_during_browser_revalidation_blocks_approval(self):
        plan = self.review()
        real_time = time.time()
        clock = [real_time]
        def expire(root, pages):
            clock[0] = plan['expiresAtEpoch'] + 1
            return fake_browser(root, pages)
        with patch.object(host.time, 'time', side_effect=lambda: clock[0]), patch.object(history, 'browser_check', side_effect=expire):
            with self.assertRaisesRegex(host.HostError, 'EXPIRED'):
                self.service.validate_approval(plan, self.approval(plan))

    def test_unknown_or_busy_resource_query_produces_no_candidates(self):
        with patch.object(host, 'resource_probe', return_value={'querySucceeded': False, 'files': []}):
            self.assertFalse(self.review()['eligible'])
        def busy(paths):
            result = free_resources(paths)
            result['files'][0]['users'] = [12345]
            return result
        with patch.object(host, 'resource_probe', side_effect=busy):
            self.assertFalse(self.review()['eligible'])

    def test_exact_approval_cannot_be_reused_or_broadened(self):
        plan = self.review()
        approval = self.approval(plan)
        approval['paths'] = []
        with self.assertRaisesRegex(host.HostError, 'EXACT_FRESH'):
            self.service.validate_approval(plan, approval)
        modified = dict(plan, executable=True)
        with self.assertRaisesRegex(host.HostError, 'NOT_ISSUED'):
            self.service.validate_approval(modified, self.approval(plan))
        self.service.registry.pin('export', self.old)
        with self.assertRaisesRegex(host.HostError, 'REFERENCES_CHANGED'):
            self.service.validate_approval(plan, self.approval(plan))

    def test_recovery_modified_after_plan_rejects_exact_approval(self):
        plan = self.review()
        with closing(sqlite3.connect(self.previous, isolation_level=None)) as db:
            db.execute("UPDATE accounts SET token='changed'")
        with self.assertRaisesRegex(host.HostError, 'RECOVERY_CHANGED'):
            self.service.validate_approval(plan, self.approval(plan))

    def test_budget_fail_closed_without_database_copy(self):
        self.service.config['maxReadBytes'] = 65536
        with self.assertRaises(history.CoverageError):
            self.review()
        self.assertTrue(self.old.exists())


class HostStdioIntegration(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('ARTICLE_HISTORY_BROWSER_REQUIRED') == '1', 'real offline browser opt-in')
    def test_actual_owner_private_stdio_to_real_browser_and_os_resource_query(self):
        with tempfile.TemporaryDirectory(prefix='history-owner-e2e-') as temp:
            root = Path(temp)
            old_root = root / 'old'
            recovery = root / 'recovery'
            old_root.mkdir()
            recovery.mkdir()
            live, old, previous = root / 'live.db', old_root / 'old.db', recovery / 'previous.db'
            for file in (live, old, previous):
                database(file)
            reference = root / 'active.json'
            reference.write_text(json.dumps({'format': 'article-history-references-v1', 'paths': [str(live)]}))
            env = dict(os.environ, SQLITE_ARTICLE_HISTORY_REVIEW_ENABLED='1', SQLITE_ARTICLE_HISTORY_MAINTENANCE_WINDOW='1',
                       SQLITE_ARTICLE_HISTORY_HOST_CONFIG=json.dumps({'sourceRoots': [str(old_root)],
                           'recoveryRoots': [str(recovery)], 'previous': str(previous),
                           'archiveRoot': str(root / 'archive'), 'referenceFiles': [str(reference)]}))
            request = json.dumps({'id': 0, 'operation': 'history-sync', 'runtime': {'format':'wewe-history-runtime-v1','scope':'sqlite-coordinator-held','paths':[]}}) + '\n'
            request += json.dumps({'id': 1, 'operation': 'history-review', 'sources': [str(old)]}) + '\n'
            process = subprocess.run([sys.executable, str(Path(__file__).with_name('sqlite-snapshot-guard.py')),
                                      '--database', str(live), '--backup-root', str(recovery)],
                                     input=request, text=True, capture_output=True, env=env, timeout=150)
            self.assertEqual(process.returncode, 0, process.stderr[-300:])
            result = json.loads(process.stdout.splitlines()[-1])['result']
            self.assertIn('review', result, result)
            plan = result['review']
            self.assertEqual(plan['coverage']['browser']['remoteRequests'], 0)
            if os.name == 'nt':
                self.assertEqual(len(plan['eligible']), 1, plan['heldReasons'])
            else:
                self.assertFalse(plan['eligible'])
                self.assertIn('RESOURCE_OCCUPANCY_UNPROVED_OR_BUSY', plan['heldReasons'])
            self.assertTrue(old.exists())
            self.assertFalse(plan['executable'])


if __name__ == '__main__':
    unittest.main()
