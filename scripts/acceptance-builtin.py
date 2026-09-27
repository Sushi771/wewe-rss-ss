"""Read-only preservation evidence for built-in collection acceptance.

No account/credential tables are read. Output contains hashes and public IDs,
never article bodies, source URLs, or credentials. This is not a completeness
test: a real upstream manifest and observed page boundaries remain necessary.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import sqlite3


TARGET = "MP_WXS_3895431412"


def digest(value):
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def snapshot(database):
    connection = sqlite3.connect(Path(database).resolve(strict=True).as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    connection.execute("BEGIN")
    feeds = connection.execute("SELECT COUNT(*) FROM feeds").fetchone()[0]
    rows = connection.execute(
        "SELECT id,mp_id,publish_time,source_url,content_html,metrics,read_count,like_count FROM articles ORDER BY id"
    ).fetchall()
    connection.close()
    records = {}
    for row in rows:
        metrics = json.loads(row["metrics"] or "{}")
        records[row["id"]] = {
            "mpId": row["mp_id"], "publishTime": row["publish_time"],
            "sourceSha256": digest(row["source_url"]), "hasSource": bool(row["source_url"]),
            "bodySha256": digest(row["content_html"]), "hasBody": bool(row["content_html"]),
            "metricFingerprints": {key: digest(json.dumps(value, sort_keys=True, ensure_ascii=False))
                                   for key, value in metrics.items() if value is not None},
            "readCount": row["read_count"], "likeCount": row["like_count"],
        }
    target = [row for row in records.values() if row["mpId"] == TARGET]
    return {
        "auditedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "counts": {"feeds": feeds, "articles": len(rows), "targetArticles": len(target),
                   "targetBodies": sum(row["hasBody"] for row in target)},
        "allArticleIdsSha256": digest("\n".join(records)),
        "upstreamCompleteness": "unverified_by_database_snapshot",
        "records": records,
    }


def compare(before, after):
    old, new = before["records"], after["records"]
    common = sorted(old.keys() & new.keys())
    return {
        "lostIds": sorted(old.keys() - new.keys()), "addedIds": sorted(new.keys() - old.keys()),
        "lostBodies": [key for key in common if old[key]["hasBody"] and not new[key]["hasBody"]],
        "changedBodies": [key for key in common if old[key]["hasBody"] and old[key]["bodySha256"] != new[key]["bodySha256"]],
        "changedPublicationTimes": [key for key in common if old[key]["publishTime"] != new[key]["publishTime"]],
        "changedSources": [key for key in common if old[key]["hasSource"] and old[key]["sourceSha256"] != new[key]["sourceSha256"]],
        "lostMetricFields": [{"id": key, "fields": sorted(old[key]["metricFingerprints"].keys() - new[key]["metricFingerprints"].keys())}
                             for key in common if old[key]["metricFingerprints"].keys() - new[key]["metricFingerprints"].keys()],
        "changedMetricFields": [{"id": key, "field": metric}
                                for key in common for metric in old[key]["metricFingerprints"].keys() & new[key]["metricFingerprints"].keys()
                                if old[key]["metricFingerprints"][metric] != new[key]["metricFingerprints"][metric]],
        "lostReadCounts": [key for key in common if old[key]["readCount"] is not None and new[key]["readCount"] is None],
        "lostLikeCounts": [key for key in common if old[key]["likeCount"] is not None and new[key]["likeCount"] is None],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", default=str(Path(__file__).resolve().parents[1] / "apps/server/data/wewe-rss.db"))
    parser.add_argument("--baseline-report")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    forbidden = [Path(args.database).resolve()]
    if args.baseline_report:
        forbidden.append(Path(args.baseline_report).resolve())
    if output in forbidden or output.exists():
        raise SystemExit("Output must be a new file, not the database or baseline")
    report = snapshot(args.database)
    if args.baseline_report:
        report["comparison"] = compare(json.loads(Path(args.baseline_report).read_text(encoding="utf-8")), report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "records"}, ensure_ascii=True, indent=2))
