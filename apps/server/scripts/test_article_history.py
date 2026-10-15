"""Tiny synthetic databases only; no production paths, cookies or network."""
import base64
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import article_history as history


PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=')
INLINE = 'data:image/png;base64,' + base64.b64encode(PNG).decode('ascii')


def connect(path):
    return closing(sqlite3.connect(path, isolation_level=None))


def database(path, body='<p>original</p>', *, title='title', metrics='{"reads":1}', article_id='a', feed='f'):
    with connect(path) as db:
        db.executescript('CREATE TABLE articles(id TEXT PRIMARY KEY,mp_id TEXT,title TEXT,content_html TEXT,metrics TEXT,source_url TEXT,extension BLOB);'
                         'CREATE TABLE feeds(id TEXT,mp_name TEXT,group_id TEXT);'
                         'CREATE TABLE management_groups(id TEXT,name TEXT,platform TEXT,"order" INT);'
                         'CREATE TABLE accounts(token TEXT);')
        db.execute('INSERT INTO articles VALUES(?,?,?,?,?,?,?)', (article_id, feed, title, body, metrics, 'https://example.invalid/original', b'\x00\xff'))
        db.execute('INSERT INTO feeds VALUES(?,?,?)', (feed, 'synthetic feed', 'g'))
        db.execute('INSERT INTO management_groups VALUES(?,?,?,?)', ('g', 'synthetic group', 'wechat', 1))
        db.execute('INSERT INTO accounts VALUES(?)', ('NEVER-ARCHIVE-THIS-TEST-TOKEN',))


def fake_browser(root, pages):
    manifest = json.loads((root / 'manifest.json').read_text())
    image_counts = {e['reader']: len(e['assets']) for e in manifest['entries']}
    return {'pages': len(pages), 'decoded': True, 'remoteRequests': 0, 'images': sum(image_counts.values())}


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='article-history-test-')
        self.root = Path(self.temp.name)
        self.sources = self.root / 'sources'
        self.sources.mkdir()
        self.old = self.sources / 'old.db'
        self.current = self.root / 'current.db'
        self.archive = self.root / 'archive'
        database(self.old)
        database(self.current, '<p>new body</p>')
        self.browser = patch.object(history, 'browser_check', side_effect=fake_browser)
        self.browser.start()
        self.addCleanup(self.browser.stop)
        self.addCleanup(self.temp.cleanup)

    def prepare(self, **kwargs):
        return history.prepareArchive([self.old], self.current, self.archive,
                                      source_roots=[self.sources], **kwargs)

    def change(self, **columns):
        with connect(self.old) as db:
            for column, value in columns.items():
                db.execute('UPDATE articles SET "' + column + '"=?', (value,))

    def manifest(self):
        return json.loads((self.archive / 'manifest.json').read_text())

    def receipts(self):
        owner = self.root / 'owner.db'
        previous = self.root / 'previous.db'
        database(owner)
        database(previous)
        return [{'role': role, 'identity': history.database_identity(p), 'verificationSha256': 'a' * 64}
                for role, p in [('owner', owner), ('previous', previous)]]

    def plan(self, **kwargs):
        receipts = kwargs.pop('protections', None)
        if receipts is None:
            receipts = self.receipts()
        sha = history.load_manifest(self.archive)[2]
        return history.planRetirements(self.archive, protections=receipts,
                                      non_article_coverage={'manifestSha256': sha, 'verificationSha256': 'b' * 64}, **kwargs)

    def test_changed_body_preserved_exactly_with_all_metadata_and_context(self):
        self.prepare()
        manifest = self.manifest()
        entry = manifest['entries'][0]
        self.assertNotEqual(entry['bodySha256'], entry['currentMatch']['body'])
        self.assertEqual((self.archive / entry['body']).read_bytes(), b'<p>original</p>')
        meta = json.loads((self.archive / entry['metadata']).read_text())
        self.assertEqual(meta['extension'], {'sqliteBlobBase64': 'AP8='})
        self.assertEqual(meta['metrics'], '{"reads":1}')
        self.assertIn('context', manifest['sources'][0])
        self.assertTrue(history.verifyCoverage(self.archive)['verified'])
        self.assertNotIn(b'NEVER-ARCHIVE-THIS-TEST-TOKEN', b''.join(p.read_bytes() for p in self.archive.rglob('*') if p.is_file()))

    def test_metadata_only_version_is_not_discarded(self):
        self.change(content_html='<p>new body</p>', title='old title', metrics='{"reads":99}')
        self.prepare()
        entry = self.manifest()['entries'][0]
        self.assertEqual(entry['bodySha256'], entry['currentMatch']['body'])
        self.assertNotEqual(entry['metadataSha256'], entry['currentMatch']['metadata'])
        self.assertTrue(history.verifyCoverage(self.archive)['verified'])

    def test_distinct_feed_and_missing_current_identity_kept(self):
        self.change(mp_id='another-feed', id='old-id')
        self.prepare()
        self.assertIsNone(self.manifest()['entries'][0]['currentMatch'])
        self.assertTrue(history.verifyCoverage(self.archive)['verified'])

    def test_same_id_multiple_versions_are_append_only_and_body_deduplicated(self):
        second = self.sources / 'second.db'
        third = self.sources / 'third.db'
        database(second, title='different metadata')
        database(third, '<p>older body</p>')
        history.prepareArchive([self.old, second, third], self.current, self.archive, source_roots=[self.sources])
        entries = self.manifest()['entries']
        self.assertEqual(len(entries), 3)
        self.assertEqual(entries[0]['body'], entries[1]['body'])
        self.assertNotEqual(entries[0]['metadata'], entries[1]['metadata'])
        self.assertNotEqual(entries[0]['body'], entries[2]['body'])
        self.assertTrue(history.verifyCoverage(self.archive)['verified'])

    def test_inline_and_local_image_deduplicate_and_stale_remote_is_ignored(self):
        media = self.root / 'media'
        media.mkdir()
        (media / 'pixel.png').write_bytes(PNG)
        self.change(content_html=f'<img src="{INLINE}" data-src="https://example.invalid/stale"><img src="pixel.png">')
        self.prepare(media_roots=[media])
        manifest = self.manifest()
        self.assertEqual(len(set(manifest['entries'][0]['assets'])), 1)
        self.assertFalse(manifest['externalUnknown'])
        self.assertTrue(history.verifyCoverage(self.archive)['verified'])

    def test_cover_pixels_preserved_in_addition_to_metadata(self):
        media = self.root / 'media'
        media.mkdir()
        (media / 'cover.png').write_bytes(PNG)
        with connect(self.old) as db:
            db.execute('ALTER TABLE articles ADD COLUMN pic_url TEXT')
            db.execute("UPDATE articles SET pic_url='cover.png'")
        self.prepare(media_roots=[media])
        self.assertEqual(len(self.manifest()['entries'][0]['assets']), 1)
        self.assertTrue(history.verifyCoverage(self.archive)['verified'])

    def test_remote_unknown_holds_by_default_and_requires_explicit_acknowledgment(self):
        self.change(content_html='<img src="https://example.invalid/never-fetch">')
        self.prepare()
        self.assertTrue(history.verifyCoverage(self.archive)['verified'])
        self.assertFalse(self.plan()['eligible'])
        # Reuse same receipts rather than attempting to recreate test databases.
        receipts = [{'role': role, 'identity': history.database_identity(self.root / (role + '.db')), 'verificationSha256': 'a' * 64} for role in ('owner', 'previous')]
        self.assertEqual(len(self.plan(protections=receipts, accept_external_unknown=True)['eligible']), 1)

    def test_bad_base64_mime_signature_and_pending_are_uncovered(self):
        for number, body in enumerate(('<img src="data:image/png;base64,!!!!">',
                                      '<img src="data:image/gif;base64,' + base64.b64encode(PNG).decode() + '">',
                                      '<div data-wewe-image-pending="1">no img remains</div>',
                                      '<img srcset="pixel.png 1x">',
                                      '<div style="background:url(x)">x</div>',
                                      '<style>p{background-image:url(x)}</style><p>x</p>',
                                      '<svg><image href="missing.png" /></svg>', '<img>')):
            with self.subTest(body=number):
                self.change(content_html=body)
                self.archive = self.root / ('archive' + str(number))
                self.prepare()
                self.assertFalse(history.verifyCoverage(self.archive)['verified'])
                self.assertFalse(history.planRetirements(self.archive)['eligible'])

    def test_traversal_and_missing_local_images_do_not_qualify(self):
        for number, address in enumerate(('../outside.png', '%2e%2e/outside.png', 'file:///outside.png', 'C:/outside.png', 'missing.png', 'x\\outside.png')):
            with self.subTest(address=address):
                self.change(content_html='<img src="' + address + '">')
                self.archive = self.root / ('archive' + str(number))
                self.prepare(media_roots=[self.root])
                self.assertFalse(history.verifyCoverage(self.archive)['verified'])

    def test_untrusted_html_only_raw_object_retains_scripts_and_events(self):
        self.change(content_html=f'<script>fetch("https://example.invalid")</script><meta http-equiv="refresh" content="0;url=x"><iframe src="x"></iframe><img src="{INLINE}" onerror="alert(1)"><p>readable</p>')
        self.prepare()
        manifest = self.manifest()
        reader = (self.archive / manifest['entries'][0]['reader']).read_text()
        self.assertNotIn('fetch(', reader)
        self.assertNotIn('onerror', reader)
        self.assertNotIn('<iframe', reader)
        self.assertIn('readable', reader)

    def test_archive_body_and_image_corruption_fail_closed(self):
        self.change(content_html=f'<img src="{INLINE}">')
        self.prepare()
        entry = self.manifest()['entries'][0]
        for name in (entry['body'], entry['assets'][0], entry['reader']):
            target = self.archive / name
            original = target.read_bytes()
            target.write_bytes(b'corrupt')
            with self.assertRaises(history.CoverageError):
                history.planRetirements(self.archive)
            target.write_bytes(original)

    def test_omitted_ledger_cannot_pass_self_reported_hashes(self):
        self.prepare()
        manifest = self.manifest()
        manifest['entries'] = []
        (self.archive / 'manifest.json').write_bytes(history.canonical(manifest))
        with self.assertRaisesRegex(history.CoverageError, 'coverage mismatch'):
            history.verifyCoverage(self.archive)

    def test_rewritten_reader_cleared_assets_and_unknown_cannot_forge_coverage(self):
        self.change(content_html=f'<img src="{INLINE}"><img src="https://example.invalid/unknown">')
        self.prepare()
        manifest = self.manifest()
        forged = history.page('forged', '<p>no images</p>')
        name = 'readers/' + history.digest(forged) + '.html'
        (self.archive / name).write_bytes(forged)
        manifest['files'][name] = {'sha256': history.digest(forged), 'bytes': len(forged)}
        manifest['entries'][0]['reader'] = name
        manifest['entries'][0]['assets'] = []
        manifest['externalUnknown'] = []
        (self.archive / 'manifest.json').write_bytes(history.canonical(manifest))
        with self.assertRaisesRegex(history.CoverageError, 'reference closure'):
            history.verifyCoverage(self.archive)

    def test_final_readback_source_or_recovery_change_holds(self):
        self.prepare()
        receipts = self.receipts()
        original = history.load_manifest
        reads = []

        def mutate_on_final(root):
            result = original(root)
            reads.append(True)
            # helper sha read + plan load + verify load + verify final + plan final
            if len(reads) == 5:
                with connect(self.old) as db:
                    db.execute("UPDATE articles SET title='late source mutation'")
                with connect(self.root / 'owner.db') as db:
                    db.execute("UPDATE articles SET title='late recovery mutation'")
            return result
        with patch.object(history, 'load_manifest', side_effect=mutate_on_final):
            plan = self.plan(protections=receipts)
        self.assertFalse(plan['eligible'])
        self.assertIn('source-identity-changed', plan['heldReasons'])
        self.assertIn('protected-recovery-changed', plan['heldReasons'])

    def test_manifest_replaced_during_archive_scan_rejected(self):
        self.prepare()
        original = history.read_file
        fired = []

        def replace_after_object(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if Path(path).name != 'manifest.json' and not fired:
                fired.append(True)
                manifest = self.manifest()
                manifest['externalUnknown'] = ['https://example.invalid/changed']
                (self.archive / 'manifest.json').write_bytes(history.canonical(manifest))
            return result
        with patch.object(history, 'read_file', side_effect=replace_after_object):
            with self.assertRaisesRegex(history.CoverageError, 'manifest changed'):
                history.load_manifest(self.archive)

    def test_coverage_from_other_manifest_cannot_authorize_plan(self):
        self.prepare()
        with patch.object(history, 'verifyCoverage', return_value={'verified': True, 'manifestSha256': 'c' * 64}):
            with self.assertRaisesRegex(history.CoverageError, 'different manifest'):
                history.planRetirements(self.archive)

    @unittest.skipUnless(os.name == 'nt', 'Windows case aliases')
    def test_windows_case_aliases_are_one_physical_recovery(self):
        self.prepare()
        receipts = self.receipts()
        receipts[1]['identity'] = history.database_identity(str(self.root / 'owner.db').swapcase())
        plan = self.plan(protections=receipts)
        self.assertIn('two-distinct-verified-recovery-points-required', plan['heldReasons'])
        receipts[0]['identity'] = history.database_identity(str(self.old).swapcase())
        self.assertIn('protected-recovery-point', self.plan(protections=receipts)['heldReasons'])

    def test_source_change_and_file_replacement_reject_stale_archive(self):
        self.prepare()
        self.change(title='changed after prepare')
        with self.assertRaises(history.CoverageError):
            history.verifyCoverage(self.archive)
        replacement = self.root / 'replacement.db'
        database(replacement)
        os.replace(replacement, self.old)
        with self.assertRaises(history.CoverageError):
            history.verifyCoverage(self.archive)

    def test_wal_commit_checkpoint_and_delete_reinsert_during_scan_rejected(self):
        for mode in ('update', 'checkpoint', 'delete-insert', 'change-back'):
            with self.subTest(mode=mode):
                writer = sqlite3.connect(self.old, isolation_level=None)
                writer.execute('PRAGMA journal_mode=WAL')
                fired = []

                def mutate():
                    if fired:
                        return
                    fired.append(True)
                    if mode == 'delete-insert':
                        writer.execute("INSERT INTO articles SELECT 'b',mp_id,title,content_html,metrics,source_url,extension FROM articles WHERE id='a'")
                        writer.execute("DELETE FROM articles WHERE id='b'")
                    else:
                        writer.execute("UPDATE articles SET title='committed'")
                        if mode == 'change-back':
                            writer.execute("UPDATE articles SET title='title'")
                        if mode == 'checkpoint':
                            writer.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                try:
                    with self.assertRaises(history.CoverageError):
                        history.read_articles(self.old, history.Budget(1024 * 1024), lambda _: None, _after_batch=mutate)
                finally:
                    writer.close()

    def test_budget_failure_never_publishes_or_changes_sources(self):
        before = history.identity(self.old)
        with self.assertRaises(history.CoverageError):
            self.prepare(max_bytes=32)
        self.assertFalse(self.archive.exists())
        self.assertEqual(before, history.identity(self.old))
        self.assertLess(sum(p.stat().st_size for p in self.root.rglob('*') if p.is_file()), 100000)

    def test_existing_archive_and_archive_inside_retirement_root_rejected(self):
        self.prepare()
        with self.assertRaises(history.CoverageError):
            self.prepare()
        self.archive = self.sources / 'unsafe-archive'
        with self.assertRaises(history.CoverageError):
            self.prepare()

    def test_no_deletion_and_default_protections_hold(self):
        self.prepare()
        held = history.planRetirements(self.archive)
        self.assertFalse(held['eligible'])
        self.assertIn('two-distinct-verified-recovery-points-required', held['heldReasons'])
        approved_review = self.plan()
        self.assertEqual(len(approved_review['eligible']), 1)
        self.assertFalse(approved_review['executable'])
        self.assertTrue(approved_review['requiresSpecificBatchApproval'])
        self.assertTrue(self.old.exists())
        self.assertEqual(len(approved_review['batchSha256']), 64)

    def test_protected_source_and_duplicate_recovery_paths_hold(self):
        self.prepare()
        receipts = self.receipts()
        receipts[0]['identity'] = history.database_identity(self.old)
        self.assertIn('protected-recovery-point', self.plan(protections=receipts)['heldReasons'])
        receipts[1]['identity'] = receipts[0]['identity']
        self.assertIn('two-distinct-verified-recovery-points-required', self.plan(protections=receipts)['heldReasons'])

    def test_browser_failure_and_current_change_during_browser_hold(self):
        self.prepare()
        with patch.object(history, 'browser_check', side_effect=history.CoverageError('decode failed')):
            with self.assertRaises(history.CoverageError):
                history.planRetirements(self.archive)
        def change_current(root, pages):
            with connect(self.current) as db:
                db.execute("UPDATE articles SET title='changed during browser'")
            return fake_browser(root, pages)
        with patch.object(history, 'browser_check', side_effect=change_current):
            with self.assertRaisesRegex(history.CoverageError, 'changed during browser'):
                self.plan()

    def test_cli_has_no_apply_delete_or_remote_fetch(self):
        result = subprocess.run(['python', str(Path(history.__file__)), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('{prepare,verify,plan}', result.stdout)
        self.assertFalse(hasattr(history, 'applyRetirements'))

    def test_symlink_media_and_source_rejected(self):
        link = self.root / 'linked.db'
        try:
            link.symlink_to(self.old)
        except OSError:
            self.skipTest('OS does not permit synthetic symlink')
        with self.assertRaises(history.CoverageError):
            history.regular(link)
        (self.root / 'pixel.png').write_bytes(PNG)
        (self.root / 'linked.png').symlink_to(self.root / 'pixel.png')
        self.change(content_html='<img src="linked.png">')
        self.prepare(media_roots=[self.root])
        self.assertFalse(history.verifyCoverage(self.archive)['verified'])


class BrowserIntegration(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('ARTICLE_HISTORY_BROWSER_REQUIRED') == '1', 'enable real offline Chrome integration explicitly')
    def test_real_decode_no_requests_and_corrupt_pixels_rejected(self):
        with tempfile.TemporaryDirectory(prefix='article-history-browser-test-') as temp:
            root = Path(temp)
            sources = root / 'sources'
            sources.mkdir()
            old, current = sources / 'old.db', root / 'current.db'
            database(old, f'<img src="{INLINE}"><img src="https://example.invalid/no-fetch"><script>fetch("https://example.invalid")</script>')
            database(current)
            archive = root / 'archive'
            history.prepareArchive([old], current, archive, source_roots=[sources])
            result = history.verifyCoverage(archive)
            self.assertEqual(result['browser']['images'], 1)
            self.assertEqual(result['browser']['remoteRequests'], 0)
            # PNG signature is valid; actual browser decode must still fail.
            with connect(old) as db:
                corrupt = base64.b64encode(b'\x89PNG\r\n\x1a\ntruncated').decode()
                db.execute('UPDATE articles SET content_html=?', ('<img src="data:image/png;base64,' + corrupt + '">',))
            broken = root / 'broken'
            history.prepareArchive([old], current, broken, source_roots=[sources])
            with self.assertRaisesRegex(history.CoverageError, 'browser validation failed'):
                history.verifyCoverage(broken)


if __name__ == '__main__':
    unittest.main()
