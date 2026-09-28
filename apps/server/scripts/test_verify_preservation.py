"""Offline preservation checks; all writes use disposable SQLite fixtures."""

import contextlib
import hashlib
import importlib.util
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("verify-preservation.py")
SPEC = importlib.util.spec_from_file_location("verify_preservation", SCRIPT)
preservation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preservation)


class PreservationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.database = self.root / "fixture.db"
        self.article_id = "WX_3895431412_2247493540_1"
        self.short_id = "K_oKauPpwhSyavBWQXFMKw"
        self.mp_id = "MP_WXS_3895431412"
        with contextlib.closing(sqlite3.connect(self.database)) as connection, connection:
            connection.executescript(
                "PRAGMA journal_mode=WAL;"
                "CREATE TABLE accounts (id TEXT, token TEXT);"
                "INSERT INTO accounts VALUES ('private', 'never-read-this');"
                "CREATE TABLE feeds (id TEXT PRIMARY KEY);"
                "CREATE TABLE articles (id TEXT PRIMARY KEY, mp_id TEXT, title TEXT, "
                "publish_time INTEGER, pic_url TEXT, source_url TEXT, content_html TEXT, "
                "metrics TEXT, read_count INTEGER, like_count INTEGER);"
            )
            connection.execute("INSERT INTO feeds VALUES (?)", (self.mp_id,))
            connection.execute(
                "INSERT INTO articles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (self.article_id, self.mp_id, "An existing article", 1000,
                 "https://cover.example/old.jpg", "https://mp.weixin.qq.com/s/" + self.short_id,
                 "<p>preserve this body</p>", '{"read":{"value":0,"display":"0"}}', 0, None),
            )

    def update(self, **fields):
        with contextlib.closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                "UPDATE articles SET " + ", ".join(key + "=?" for key in fields),
                tuple(fields.values()),
            )

    def state(self, **kwargs):
        return preservation.database_state(self.database, **kwargs)

    def compare(self, before, corrections=None):
        return preservation.compare_states(before, self.state(), corrections)

    def correction_file(self, *, stored_id=None, before=1000, after=2000):
        evidence = self.root / "verified.json"
        evidence.write_text(json.dumps({
            "mpId": self.mp_id,
            "latest": [{"id": self.article_id,
                        "shortUrl": "https://mp.weixin.qq.com/s/" + self.short_id,
                        "publishTime": after}],
        }), encoding="utf-8")
        correction = self.root / "corrections.json"
        correction.write_text(json.dumps({"corrections": [{
            "articleId": stored_id or self.article_id,
            "previousPublishTime": before,
            "publishTime": after,
            "verifiedId": self.article_id,
            "evidencePath": evidence.name,
            "evidenceSha256": hashlib.sha256(evidence.read_bytes()).hexdigest(),
        }]}), encoding="utf-8")
        return correction

    def test_snapshot_uses_one_read_transaction_and_never_reads_accounts(self):
        statements = []
        real_connect = sqlite3.connect
        database = self.database
        injected = False

        class ObservedConnection(sqlite3.Connection):
            def execute(self, sql, *args):
                nonlocal injected
                statements.append(sql)
                result = super().execute(sql, *args)
                if sql.startswith("SELECT id FROM feeds") and not injected:
                    injected = True
                    with contextlib.closing(real_connect(database)) as writer, writer:
                        writer.execute("INSERT INTO feeds VALUES ('other-feed')")
                        writer.execute("INSERT INTO articles (id, mp_id) VALUES ('new', 'other-feed')")
                return result

        def read_connect(*args, **kwargs):
            self.assertIn("mode=ro", args[0])
            return real_connect(*args, **kwargs, factory=ObservedConnection)

        with patch.object(preservation.sqlite3, "connect", side_effect=read_connect):
            snapshot = self.state()
        self.assertEqual(snapshot["feedIds"], [self.mp_id])
        self.assertEqual(list(snapshot["records"]), [self.article_id])
        self.assertIn("PRAGMA query_only=ON", statements)
        self.assertLess(statements.index("BEGIN"), statements.index("PRAGMA integrity_check"))
        self.assertFalse(any("accounts" in query.lower() for query in statements))

    def test_snapshot_contains_hashes_instead_of_original_text(self):
        snapshot = self.state()
        serialized = json.dumps(snapshot)
        for text in ("preserve this body", "cover.example", self.short_id,
                     "An existing article", "never-read-this"):
            self.assertNotIn(text, serialized)
        self.assertEqual(snapshot["records"][self.article_id]["publishTime"], 1000)

    def test_null_and_empty_fields_can_be_filled_and_rows_added(self):
        for blank in (None, ""):
            with self.subTest(blank=blank):
                self.update(pic_url=blank, source_url=blank, content_html=blank)
                before = self.state()
                self.update(pic_url="cover", source_url="source", content_html="body")
                report = self.compare(before)
                self.assertTrue(report["passed"])
                self.assertEqual(len(report["allowedBackfills"]), 3)
        before = self.state()
        with contextlib.closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("INSERT INTO articles (id,mp_id) VALUES ('new',?)", (self.mp_id,))
        self.assertTrue(self.compare(before)["passed"])
        self.assertEqual(self.compare(before)["addedArticles"], ["new"])

    def test_old_nonempty_text_identity_and_title_cannot_be_replaced_or_removed(self):
        fields = {"pic_url": "picUrl", "source_url": "sourceUrl",
                  "content_html": "contentHtml", "title": "titleSha256", "mp_id": "mpId"}
        for column, protected in fields.items():
            for replacement in (None, "", "different"):
                with self.subTest(column=column, replacement=replacement):
                    before = self.state()
                    with contextlib.closing(sqlite3.connect(self.database)) as connection, connection:
                        original = connection.execute("SELECT " + column + " FROM articles").fetchone()[0]
                    self.update(**{column: replacement})
                    report = self.compare(before)
                    self.assertFalse(report["passed"])
                    self.assertIn({"id": self.article_id, "field": protected}, report["violations"])
                    self.update(**{column: original})

    def test_old_ids_and_feed_ids_must_survive(self):
        before = self.state()
        with contextlib.closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("DELETE FROM articles")
            connection.execute("DELETE FROM feeds")
        report = self.compare(before)
        self.assertFalse(report["passed"])
        self.assertEqual(report["missingArticles"], [self.article_id])
        self.assertEqual(report["missingFeeds"], [self.mp_id])

    def test_metrics_zero_null_and_valid_values_are_preserved(self):
        for column, replacement in (("read_count", None), ("read_count", 1),
                                    ("like_count", 0), ("metrics", None),
                                    ("metrics", '{"read":{"value":1,"display":"1"}}')):
            with self.subTest(column=column):
                before = self.state()
                with contextlib.closing(sqlite3.connect(self.database)) as connection, connection:
                    original = connection.execute("SELECT " + column + " FROM articles").fetchone()[0]
                self.update(**{column: replacement})
                self.assertFalse(self.compare(before)["passed"])
                self.update(**{column: original})
        self.update(metrics=None)
        before = self.state()
        self.update(metrics='{"read":{"value":0}}')
        self.assertFalse(self.compare(before)["passed"])

    def test_equivalent_metric_json_order_is_allowed_but_invalid_data_is_protected(self):
        before = self.state()
        self.update(metrics=' { "read": { "display": "0", "value": 0 } } ')
        self.assertTrue(self.compare(before)["passed"])
        self.update(metrics="previous-invalid-json")
        before = self.state()
        self.assertTrue(self.compare(before)["passed"])
        self.update(metrics=None)
        self.assertFalse(self.compare(before)["passed"])

    def test_publication_date_requires_explicit_verified_correction(self):
        before = self.state()
        self.update(publish_time=2000)
        self.assertFalse(self.compare(before)["passed"])
        corrections = preservation.load_date_corrections(self.correction_file())
        report = self.compare(before, corrections)
        self.assertTrue(report["passed"])
        self.assertEqual(report["dateCorrectionsApplied"], [self.article_id])
        wrong_previous = preservation.load_date_corrections(self.correction_file(before=999))
        self.assertFalse(self.compare(before, wrong_previous)["passed"])
        self.update(publish_time=2001)
        self.assertFalse(self.compare(before, corrections)["passed"])

    def test_date_correction_can_address_preserved_short_link_id(self):
        self.update(id=self.short_id)
        before = self.state()
        self.update(publish_time=2000)
        corrections = preservation.load_date_corrections(self.correction_file(stored_id=self.short_id))
        self.assertTrue(self.compare(before, corrections)["passed"])

    def test_date_evidence_tampering_or_wrong_identity_is_rejected(self):
        correction = self.correction_file()
        evidence = self.root / "verified.json"
        evidence.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            preservation.load_date_corrections(correction)
        with self.assertRaisesRegex(ValueError, "stored article"):
            preservation.load_date_corrections(self.correction_file(stored_id="unrelated"))
        correction = self.correction_file()
        payload = json.loads(correction.read_text(encoding="utf-8"))
        payload["corrections"][0]["publishTime"] = 3000
        correction.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "absent from the verified evidence"):
            preservation.load_date_corrections(correction)

    def legacy_snapshot(self):
        with contextlib.closing(sqlite3.connect(self.database)) as connection, connection:
            row = connection.execute(
                "SELECT id,mp_id,pic_url,source_url,content_html,metrics,read_count,like_count FROM articles"
            ).fetchone()
        return {"feedIds": [self.mp_id],
                "protectedArticles": {row[0]: preservation.fingerprint(row[1:3] + row[4:])},
                "protectedSourceUrls": {row[0]: row[3]} if row[3] is not None else {}}

    def test_legacy_baseline_never_claims_to_protect_dates_or_titles(self):
        before = self.legacy_snapshot()
        self.update(title="changed", publish_time=2000)
        report = preservation.compare_states(before, self.state(include_legacy=True))
        self.assertTrue(report["passed"])
        self.assertEqual(report["unprotectedFields"], ["title", "publish_time"])
        self.assertTrue(report["warnings"])

    def test_legacy_allows_only_empty_backfills_and_protects_existing_metrics(self):
        self.update(pic_url="", source_url=None, content_html=None)
        before = self.legacy_snapshot()
        self.update(pic_url="cover", source_url="source", content_html="body")
        self.assertTrue(preservation.compare_states(before, self.state(include_legacy=True))["passed"])
        self.update(like_count=0)
        self.assertFalse(preservation.compare_states(before, self.state(include_legacy=True))["passed"])
        self.update(like_count=None)
        before = self.legacy_snapshot()
        self.update(content_html="")
        self.assertFalse(preservation.compare_states(before, self.state(include_legacy=True))["passed"])

    def test_snapshot_cli_cannot_overwrite_database_or_existing_baseline(self):
        existing = self.root / "baseline.json"
        existing.write_text("existing evidence", encoding="utf-8")
        for destination in (self.database, existing):
            original = destination.read_bytes()
            argv = [str(SCRIPT), "snapshot", "--database", str(self.database),
                    "--snapshot", str(destination)]
            with patch.object(sys, "argv", argv), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    preservation.main()
            self.assertEqual(destination.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
