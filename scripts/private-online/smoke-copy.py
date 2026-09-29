"""Compare a migrated SQLite copy to the original, then add one offline ZIP fixture.

The second path must be an ignored scratch copy under output/subscription-implementation.
No production file is modified.
"""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path


def rows_digest(connection: sqlite3.Connection, table: str, columns: list[str]) -> str:
    digest = hashlib.sha256()
    selected = ",".join('"' + column + '"' for column in columns)
    for row in connection.execute(f'SELECT {selected} FROM "{table}" ORDER BY id'):
        digest.update(repr(row).encode("utf-8"))
    return digest.hexdigest()


def main() -> None:
    source = Path(sys.argv[1]).resolve(strict=True)
    scratch = Path(sys.argv[2]).resolve(strict=True)
    if source == scratch or "output/subscription-implementation" not in scratch.as_posix():
        raise SystemExit("Scratch database must be an ignored copy under output/subscription-implementation")
    old = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True)
    copy = sqlite3.connect(scratch)
    assert old.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    assert copy.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    counts = {}
    for table in ("feeds", "articles"):
        columns = [row[1] for row in old.execute(f'PRAGMA table_info("{table}")')]
        before = rows_digest(old, table, columns)
        after = rows_digest(copy, table, columns)
        if before != after:
            raise SystemExit(f"{table} old columns changed during copy migration")
        counts[table] = old.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
    feed_id = copy.execute(
        "SELECT mp_id FROM articles WHERE length(coalesce(content_html,''))>0 GROUP BY mp_id ORDER BY count(*) DESC LIMIT 1"
    ).fetchone()[0]
    fixture_id = "private-online-offline-fixture"
    if copy.execute("SELECT 1 FROM articles WHERE id=?", (fixture_id,)).fetchone():
        raise SystemExit("Smoke fixture already exists; start from a new copy")
    image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII="
    body = f'<div class="rich_media_content"><p>离线导出夹具正文</p><img src="data:image/png;base64,{image}"></div>'
    copy.execute(
        "INSERT INTO articles (id,mp_id,title,pic_url,publish_time,content_html) VALUES (?,?,?,?,?,?)",
        (fixture_id, feed_id, "离线导出夹具", "", 1780000000, body),
    )
    copy.commit()
    print(json.dumps({"quick_check": copy.execute("PRAGMA quick_check").fetchone()[0], "preserved": counts, "fixture_feed_id": feed_id}, ensure_ascii=False))
    old.close()
    copy.close()


if __name__ == "__main__":
    main()
