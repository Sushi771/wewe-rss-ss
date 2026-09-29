"""Snapshot and verify article preservation without reading account credentials.

Version 3 snapshots also protect existing verified source URLs, article creation
times, and subscription configuration. Titles, publication times, old nonempty
bodies, covers, sources and all metric values (including zero and missing/null)
remain protected. Only null/empty bodies, covers and sources may be filled
without extra evidence. Older snapshots remain readable, but cannot verify
fields absent from their schema.

An optional --date-corrections JSON has a corrections array. Each entry contains
articleId, previousPublishTime, publishTime, verifiedId, evidencePath and
evidenceSha256. The evidence must be an independently generated
verify-desktop-evidence.ts report: mpId and latest[].{id,shortUrl,publishTime}.
Paths are relative to the corrections file. This checks the supplied evidence;
it does not make network requests or independently establish its provenance.
"""

import argparse
import hashlib
import itertools
import json
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


def fingerprint(values, *, sort_keys=False):
    payload = json.dumps(
        values, ensure_ascii=False, separators=(",", ":"), sort_keys=sort_keys
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def text_state(value):
    return {"hasValue": value not in (None, ""), "sha256": fingerprint(value)}


def metrics_state(value):
    # JSON serialization order is immaterial; unknown/invalid data is still
    # protected byte for byte instead of being silently treated as missing.
    if value in (None, ""):
        value = {}
    else:
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return {"invalidRawSha256": fingerprint(value)}
        if value is None:
            value = {}
    return {"sha256": fingerprint(value, sort_keys=True)}


def database_state(database, *, include_legacy=False):
    uri = database.resolve(strict=True).as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        if [row[0] for row in connection.execute("PRAGMA integrity_check")] != ["ok"]:
            raise ValueError("SQLite integrity_check failed")
        feeds = connection.execute(
            'SELECT id, mp_name, mp_cover, mp_intro, status, created_at, "order", '
            'local_directory, public_album_ids FROM feeds ORDER BY id'
        ).fetchall()
        rows = connection.execute(
            "SELECT id, mp_id, title, publish_time, pic_url, source_url, "
            "content_html, metrics, read_count, like_count, verified_source_url, "
            "created_at FROM articles ORDER BY id"
        ).fetchall()
        feed_records = {
            row["id"]: {
                field: fingerprint(row[column])
                for field, column in (
                    ("mpName", "mp_name"), ("mpCover", "mp_cover"),
                    ("mpIntro", "mp_intro"), ("status", "status"),
                    ("createdAt", "created_at"), ("order", "order"),
                    ("localDirectory", "local_directory"),
                    ("publicAlbumIds", "public_album_ids"),
                )
            }
            for row in feeds
        }
        records, legacy = {}, {}
        for row in rows:
            records[row["id"]] = {
                "mpId": row["mp_id"],
                "titleSha256": fingerprint(row["title"]),
                "publishTime": row["publish_time"],
                "picUrl": text_state(row["pic_url"]),
                "sourceUrl": text_state(row["source_url"]),
                "verifiedSourceUrl": text_state(row["verified_source_url"]),
                "contentHtml": text_state(row["content_html"]),
                "createdAtSha256": fingerprint(row["created_at"]),
                "metrics": metrics_state(row["metrics"]),
                "readCount": row["read_count"],
                "likeCount": row["like_count"],
            }
            if include_legacy:
                # Old hashes combine fields. Test only the permitted empty ->
                # populated transitions; do not forgive changes to old values.
                covers = [row["pic_url"], None, ""]
                bodies = [row["content_html"], None, ""]
                legacy[row["id"]] = {
                    fingerprint([row["mp_id"], cover, body, row["metrics"],
                                 row["read_count"], row["like_count"]]):
                    (["picUrl"] if cover != row["pic_url"] else [])
                    + (["contentHtml"] if body != row["content_html"] else [])
                    for cover, body in itertools.product(covers, bodies)
                }
    state = {
        "schemaVersion": 3,
        "createdAtUtc": datetime.now(timezone.utc).isoformat(),
        "feedIds": [row["id"] for row in feeds],
        "feedRecords": feed_records,
        "records": records,
    }
    if include_legacy:
        state["_legacyCandidates"] = legacy
    return state


def load_date_corrections(path):
    if path is None:
        return {}
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict) or not isinstance(payload.get("corrections"), list):
        raise ValueError("Date corrections must contain a corrections array")
    corrections = {}
    for item in payload["corrections"]:
        required = ("articleId", "previousPublishTime", "publishTime", "verifiedId",
                    "evidencePath", "evidenceSha256")
        if not isinstance(item, dict) or any(key not in item for key in required):
            raise ValueError("Date correction is missing required evidence fields")
        article_id = item["articleId"]
        if not isinstance(article_id, str) or not article_id or article_id in corrections:
            raise ValueError("Date correction articleId must be unique and nonempty")
        if any(type(item[key]) is not int or item[key] < 0
               for key in ("previousPublishTime", "publishTime")):
            raise ValueError("Date correction times must be nonnegative integer seconds")
        if item["publishTime"] == 0:
            raise ValueError("A verified publication time must be positive")
        identity = re.fullmatch(r"WX_(\d+)_(\d+)_(\d+)", str(item["verifiedId"]))
        if not identity or not isinstance(item["evidencePath"], str):
            raise ValueError("Date correction requires a verified article identity")
        evidence_path = (path.resolve().parent / item["evidencePath"]).resolve(strict=True)
        evidence_bytes = evidence_path.read_bytes()
        if hashlib.sha256(evidence_bytes).hexdigest() != item["evidenceSha256"]:
            raise ValueError("Date correction evidence SHA-256 mismatch")
        evidence = json.loads(evidence_bytes.decode("utf-8-sig"))
        mp_id = "MP_WXS_" + identity[1]
        if not isinstance(evidence, dict) or evidence.get("mpId") != mp_id:
            raise ValueError("Date correction evidence account mismatch")
        latest = evidence.get("latest")
        if not isinstance(latest, list):
            raise ValueError("Date correction evidence has no verified article list")
        matches = [a for a in latest if isinstance(a, dict) and a.get("id") == item["verifiedId"]]
        if (len(matches) != 1 or type(matches[0].get("publishTime")) is not int
                or matches[0]["publishTime"] != item["publishTime"]):
            raise ValueError("Date correction is absent from the verified evidence")
        short_url = matches[0].get("shortUrl", "")
        if not isinstance(short_url, str) or not re.fullmatch(
            r"https://mp\.weixin\.qq\.com/s/[A-Za-z0-9_-]{22}", short_url
        ):
            raise ValueError("Date correction evidence has no valid original short URL")
        if article_id not in (item["verifiedId"], short_url.rsplit("/", 1)[-1]):
            raise ValueError("Date correction does not identify the stored article")
        corrections[article_id] = {**item, "mpId": mp_id}
    return corrections


def compare_states(old, current, date_corrections=None):
    date_corrections = date_corrections or {}
    version = old.get("schemaVersion", 1)
    if version not in (1, 2, 3):
        raise ValueError("Unsupported preservation snapshot schema")
    old_rows = old["records"] if version >= 2 else old["protectedArticles"]
    new_rows = current["records"]
    report = {
        "baselineSchemaVersion": version,
        "oldFeeds": len(old["feedIds"]), "currentFeeds": len(current["feedIds"]),
        "oldArticles": len(old_rows), "currentArticles": len(new_rows),
        "missingFeeds": sorted(set(old["feedIds"]) - set(current["feedIds"])),
        "missingArticles": sorted(old_rows.keys() - new_rows.keys()),
        "addedArticles": sorted(new_rows.keys() - old_rows.keys()),
        "changedProtectedArticles": [], "changedExistingSourceUrls": [],
        "violations": [], "allowedBackfills": [], "dateCorrectionsApplied": [],
        "unprotectedFields": (
            ["title", "publish_time", "verified_source_url", "article.created_at",
             "feed configuration"] if version == 1 else
            ["verified_source_url", "article.created_at", "feed configuration"]
            if version == 2 else []
        ),
        "warnings": (
            ["Legacy baseline cannot verify title or publication-time preservation; "
             "create a version 3 snapshot before the next write."] if version == 1 else
            ["Version 2 baseline cannot verify verified source URLs, creation times "
             "or feed configuration; create a version 3 snapshot before the next write."]
            if version == 2 else []
        ),
    }

    def violation(article_id, field):
        report["violations"].append({"id": article_id, "field": field})
        key = "changedExistingSourceUrls" if field == "sourceUrl" else "changedProtectedArticles"
        if article_id not in report[key]:
            report[key].append(article_id)

    if version == 3:
        for feed_id in sorted(set(old["feedIds"]) & set(current["feedIds"])):
            for field, previous in old["feedRecords"][feed_id].items():
                if current["feedRecords"][feed_id].get(field) != previous:
                    report["violations"].append({"id": feed_id, "field": f"feed.{field}"})

    for article_id in sorted(old_rows.keys() & new_rows.keys()):
        previous, actual = old_rows[article_id], new_rows[article_id]
        if version == 1:
            candidates = current["_legacyCandidates"][article_id]
            if previous not in candidates:
                violation(article_id, "legacyProtectedFields")
            else:
                report["allowedBackfills"].extend(
                    {"id": article_id, "field": field} for field in candidates[previous]
                )
            old_source = old["protectedSourceUrls"].get(article_id)
            if old_source not in (None, "") and fingerprint(old_source) != actual["sourceUrl"]["sha256"]:
                violation(article_id, "sourceUrl")
            elif old_source in (None, "") and actual["sourceUrl"]["hasValue"]:
                report["allowedBackfills"].append({"id": article_id, "field": "sourceUrl"})
            continue
        for field in ("mpId", "titleSha256", "metrics", "readCount", "likeCount"):
            if previous[field] != actual[field]:
                violation(article_id, field)
        for field in ("picUrl", "sourceUrl", "contentHtml"):
            if previous[field]["hasValue"]:
                if previous[field]["sha256"] != actual[field]["sha256"]:
                    violation(article_id, field)
            elif actual[field]["hasValue"]:
                report["allowedBackfills"].append({"id": article_id, "field": field})
        if version == 3:
            if previous["createdAtSha256"] != actual["createdAtSha256"]:
                violation(article_id, "createdAt")
            field = "verifiedSourceUrl"
            if previous[field]["hasValue"]:
                if previous[field]["sha256"] != actual[field]["sha256"]:
                    violation(article_id, field)
            elif actual[field]["hasValue"]:
                report["allowedBackfills"].append({"id": article_id, "field": field})
        if previous["publishTime"] != actual["publishTime"]:
            correction = date_corrections.get(article_id, {})
            if (correction.get("previousPublishTime") == previous["publishTime"]
                    and correction.get("publishTime") == actual["publishTime"]
                    and correction.get("mpId") == previous["mpId"] == actual["mpId"]):
                report["dateCorrectionsApplied"].append(article_id)
            else:
                violation(article_id, "publishTime")
    report["unusedDateCorrections"] = sorted(set(date_corrections) - set(report["dateCorrectionsApplied"]))
    report["passed"] = not (report["missingFeeds"] or report["missingArticles"] or report["violations"])
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["snapshot", "verify"])
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--date-corrections", type=Path)
    args = parser.parse_args()
    if args.mode == "snapshot":
        if args.date_corrections:
            parser.error("--date-corrections applies only to verify")
        if args.snapshot.resolve() == args.database.resolve() or args.snapshot.exists():
            parser.error("Snapshot must be a new file, not the database or an existing baseline")
        current = database_state(args.database)
        args.snapshot.parent.mkdir(parents=True, exist_ok=True)
        with args.snapshot.open("x", encoding="utf-8") as stream:
            json.dump(current, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        print(json.dumps({"schemaVersion": 3, "feeds": len(current["feedIds"]), "articles": len(current["records"])}))
        return
    old = json.loads(args.snapshot.read_text(encoding="utf-8-sig"))
    corrections = load_date_corrections(args.date_corrections)
    current = database_state(args.database, include_legacy=old.get("schemaVersion", 1) == 1)
    report = compare_states(old, current, corrections)
    print(json.dumps(report, ensure_ascii=False))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
