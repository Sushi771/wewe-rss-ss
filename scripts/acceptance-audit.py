"""Read-only, credential-free audit of the real collection target.

This checks stored evidence only. A clean audit does NOT prove upstream paging
or history completeness; those require the original acquisition manifest.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import sqlite3
from urllib.parse import parse_qs, urlparse


TARGET = "MP_WXS_3895431412"
SHANGHAI = dt.timezone(dt.timedelta(hours=8))


def date(value):
    return dt.datetime.fromtimestamp(value, SHANGHAI).isoformat() if value else None


def inspect(database):
    database = Path(database).resolve(strict=True)
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    with connection:
        feed = connection.execute(
            "SELECT id, mp_name, sync_time, update_time, has_history, local_directory FROM feeds WHERE id=?",
            (TARGET,),
        ).fetchone()
        rows = [dict(row) for row in connection.execute(
            "SELECT id,title,publish_time,source_url,content_html,metrics,read_count,like_count "
            "FROM articles WHERE mp_id=? ORDER BY publish_time DESC,id", (TARGET,)
        )]
        totals = dict(connection.execute(
            "SELECT (SELECT COUNT(*) FROM feeds) feeds, COUNT(*) articles FROM articles"
        ).fetchone())
        identities = [row[0] for row in connection.execute("SELECT id FROM articles ORDER BY id")]
    connection.close()
    by_source, by_title_date, by_title, groups = {}, {}, {}, {}
    for row in rows:
        if row["source_url"]:
            query = parse_qs(urlparse(row["source_url"]).query)
            identity = tuple(query.get(key, [""])[0] for key in ("__biz", "mid", "idx"))
            if all(identity):
                by_source.setdefault(identity, []).append(row["id"])
                groups.setdefault(identity[:2], set()).add(int(identity[2]))
        by_title_date.setdefault((row["title"], row["publish_time"]), []).append(row["id"])
        by_title.setdefault(row["title"], []).append(row)
    times = sorted(set(row["publish_time"] for row in rows), reverse=True)
    gap_start = int(dt.datetime(2026, 8, 19, tzinfo=SHANGHAI).timestamp())
    gap_end = int(dt.datetime(2026, 9, 27, tzinfo=SHANGHAI).timestamp())
    metric_counts = dict.fromkeys(("read", "like", "favorite", "share", "wow"), 0)
    for row in rows:
        for key, value in json.loads(row["metrics"] or "{}").items():
            if key in metric_counts and value is not None:
                metric_counts[key] += 1
    return {
        "auditedAt": dt.datetime.now(SHANGHAI).isoformat(),
        "target": TARGET,
        "databaseTotals": totals,
        "allArticleIdsSha256": hashlib.sha256("\n".join(identities).encode()).hexdigest(),
        "feed": {"name": feed["mp_name"], "syncTime": date(feed["sync_time"]),
                 "updateTime": date(feed["update_time"]), "hasHistory": feed["has_history"],
                 "hasLocalDirectory": bool(feed["local_directory"])} if feed else None,
        "storedArticles": len(rows),
        "storedBodies": sum(bool(row["content_html"]) for row in rows),
        "readCountAvailable": sum(row["read_count"] is not None for row in rows),
        "likeCountAvailable": sum(row["like_count"] is not None for row in rows),
        "metricsAvailable": metric_counts,
        "knownGapWindow": {"fromInclusive": "2026-08-19T00:00:00+08:00",
                           "untilExclusive": "2026-09-27T00:00:00+08:00",
                           "storedArticles": sum(gap_start <= row["publish_time"] < gap_end for row in rows)},
        "latest": [{"id": row["id"], "title": row["title"], "publishedAt": date(row["publish_time"])} for row in rows[:5]],
        "gapsOverSevenDays": [{"older": date(older), "newer": date(newer), "days": round((newer-older)/86400, 2)}
                              for newer, older in zip(times, times[1:]) if newer-older > 7*86400],
        "duplicateCanonicalIdentities": [ids for ids in by_source.values() if len(ids) > 1],
        "sameTitleDateCandidates": [ids for ids in by_title_date.values() if len(ids) > 1],
        "sameTitleNearTimeCandidates": [{"ids": [row["id"] for row in group],
                                          "timeSpreadSeconds": max(row["publish_time"] for row in group)-min(row["publish_time"] for row in group)}
                                         for group in by_title.values() if len(group) > 1 and max(row["publish_time"] for row in group)-min(row["publish_time"] for row in group) <= 300],
        "storedSecondaryArticles": sum(len([idx for idx in group if idx > 1]) for group in groups.values()),
        "observedPushGroupsWithSecondary": sum(any(idx > 1 for idx in group) for group in groups.values()),
        "completeness": "unverified: needs upstream page boundaries, expected article identities, and push groups",
        "articleIds": identities,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", default=str(Path(__file__).resolve().parents[1] / "apps/server/data/wewe-rss.db"))
    parser.add_argument("--baseline", help="Optional database backup for read-only preservation comparison")
    parser.add_argument("--output", help="Optional JSON report path (contains public article titles/IDs, no credentials)")
    args = parser.parse_args()
    report = inspect(args.database)
    if args.baseline:
        baseline = inspect(args.baseline)
        report["comparison"] = {
            "baselineTotals": baseline["databaseTotals"],
            "articleCountDelta": report["databaseTotals"]["articles"] - baseline["databaseTotals"]["articles"],
            "lostArticleIds": sorted(set(baseline["articleIds"]) - set(report["articleIds"])),
            "addedArticleIds": sorted(set(report["articleIds"]) - set(baseline["articleIds"])),
        }
    del report["articleIds"]
    result = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(result + "\n", encoding="utf-8")
    print(result)
