"""Read-only screenshot candidate audit; never treats title matching as identity proof.

Only reads public article fields. Does not read credentials, fetch network data,
or mutate SQLite. --baseline-report compares stored IDs/body/metric evidence.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
from urllib.parse import parse_qs, urlparse

TARGET = "MP_WXS_3895431412"
ZONE = dt.timezone(dt.timedelta(hours=8))
EXPECTATIONS = [
    ("thinking100", "思维100秋季开始报名！", ("思维100", "思维１００"), "星期四"),
    ("physics", "华二断层领先，2026年物理竞赛上海省队和获奖情况解析", ("物理竞赛", "华二断层"), "星期四"),
    ("admission", "上岸四校八大的路径其实很清晰", ("四校八大",), "星期三"),
    ("chemistry", "化学竞赛－省队一等奖名单出炉（仅封面可见，完整标题未知）", ("化学",), "星期一"),
    ("control", "徐汇要建一个南模9年制学校？", ("南模9年",), "昨天"),
]


def digest(value):
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def timestamp(value):
    return dt.datetime.fromtimestamp(value, ZONE).isoformat() if value else None


def identity(source_url):
    url = urlparse(source_url or "")
    query = parse_qs(url.query)
    result = {key: query.get(key, [None])[0] for key in ("__biz", "mid", "idx")}
    return result if url.hostname == "mp.weixin.qq.com" and all(result.values()) else None


def audit(database):
    database = Path(database).resolve(strict=True)
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    # Begin one read snapshot so counts and fingerprints describe the same state.
    connection.execute("BEGIN")
    rows = [dict(row) for row in connection.execute(
        "SELECT id,mp_id,title,publish_time,source_url,content_html,metrics,read_count,like_count FROM articles ORDER BY id"
    )]
    feed_count = connection.execute("SELECT COUNT(*) FROM feeds").fetchone()[0]
    connection.close()
    target_rows = [row for row in rows if row["mp_id"] == TARGET]
    recent_start = int(dt.datetime(2026, 9, 20, tzinfo=ZONE).timestamp())
    recent_end = int(dt.datetime(2026, 9, 28, tzinfo=ZONE).timestamp())

    def summarize(row):
        return {
            "id": row["id"], "title": row["title"],
            "storedPublishedAt": timestamp(row["publish_time"]),
            "storedCanonicalIdentity": identity(row["source_url"]),
            "hasStoredBody": bool(row["content_html"]),
            "readCount": row["read_count"], "likeCount": row["like_count"],
            "identityAgainstScreenshot": "unverified: screenshot contains no canonical URL or biz/mid/idx",
        }

    checks = []
    for key, label, terms, day in EXPECTATIONS:
        candidates = [row for row in target_rows if any(term in row["title"] for term in terms)]
        recent = [row for row in candidates if recent_start <= row["publish_time"] < recent_end]
        checks.append({
            "key": key, "screenshotLabel": label, "screenshotRelativeDay": day,
            "contentType": "unverified: screenshot tab is 全部; must distinguish article, image post, repost/share",
            "recentCandidateCount": len(recent), "allStoredCandidateCount": len(candidates),
            "candidates": [summarize(row) for row in candidates],
            "verdict": "candidate_requires_source_identity" if recent else "no_recent_title_candidate; acquisition_unproven",
        })
    fingerprints = {
        row["id"]: {
            "bodySha256": digest(row["content_html"]), "hadBody": bool(row["content_html"]),
            "metricsSha256": digest(row["metrics"]), "hadMetrics": bool(row["metrics"] and row["metrics"] != "{}"),
            "readCount": row["read_count"], "likeCount": row["like_count"],
        } for row in rows
    }
    return {
        "auditedAt": dt.datetime.now(ZONE).isoformat(), "target": TARGET,
        "databaseTotals": {"feeds": feed_count, "articles": len(rows)},
        "targetArticles": len(target_rows), "targetBodies": sum(bool(row["content_html"]) for row in target_rows),
        "screenshotTab": "全部", "recentWindow": {"fromInclusive": timestamp(recent_start), "untilExclusive": timestamp(recent_end)},
        "checks": checks,
        "constraints": [
            "Candidate search does not prove article identity, type, publication date or collection coverage.",
            "2026-09-24 21:02 inside 思维100 cover is the embedded source date, not verified target publication time.",
            "Friends' likes/reposts are personal social indicators, not total shares/favorites.",
            "Screenshots are manual observations, not proof of automatically collected read/like metrics.",
            "Upstream paging, complete push groups and repeated collection remain unverified by this audit.",
        ],
        "articleFingerprints": fingerprints,
    }


def compare(report, baseline):
    previous, current = baseline["articleFingerprints"], report["articleFingerprints"]
    common = previous.keys() & current.keys()
    return {
        "baselineAuditedAt": baseline["auditedAt"],
        "lostIds": sorted(previous.keys() - current.keys()),
        "addedIds": sorted(current.keys() - previous.keys()),
        "lostBodies": sorted(key for key in common if previous[key]["hadBody"] and not current[key]["hadBody"]),
        "changedBodies": sorted(key for key in common if previous[key]["hadBody"] and previous[key]["bodySha256"] != current[key]["bodySha256"]),
        "lostMetrics": sorted(key for key in common if previous[key]["hadMetrics"] and not current[key]["hadMetrics"]),
        "lostReadCounts": sorted(key for key in common if previous[key]["readCount"] is not None and current[key]["readCount"] is None),
        "lostLikeCounts": sorted(key for key in common if previous[key]["likeCount"] is not None and current[key]["likeCount"] is None),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", default=str(Path(__file__).resolve().parents[1] / "apps/server/data/wewe-rss.db"))
    parser.add_argument("--baseline-report")
    parser.add_argument("--output", required=True, help="Local JSON path; includes fingerprints, never body or credentials")
    args = parser.parse_args()
    report = audit(args.database)
    if args.baseline_report:
        report["comparison"] = compare(report, json.loads(Path(args.baseline_report).read_text(encoding="utf-8")))
    output = Path(args.output).resolve()
    if output == Path(args.database).resolve() or (args.baseline_report and output == Path(args.baseline_report).resolve()):
        raise SystemExit("Output must not overwrite database or baseline report")
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    del report["articleFingerprints"]
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
