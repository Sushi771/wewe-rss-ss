"""Explicit cache-only continuation. No network, writes, refresh or media."""
import argparse
import datetime
import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path


def read(database, feed, name):
    if not re.fullmatch(r'MP_WXS_\d{5,15}', feed):
        raise ValueError('CACHE_LOCAL_ID_INVALID')
    source = Path(database)
    if not source.is_absolute() or not source.is_file():
        raise ValueError('CACHE_LOCAL_READ_UNAVAILABLE')
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as cache:
        cache.row_factory = sqlite3.Row
        cache.execute('PRAGMA query_only=ON')
        cache.execute('BEGIN')
        biz = feed.removeprefix('MP_WXS_')
        subscriptions = cache.execute('SELECT name FROM rsses WHERE biz_id = ?', (biz,)).fetchall()
        if len(subscriptions) != 1 or subscriptions[0]['name'] != name:
            raise ValueError('CACHE_LOCAL_IDENTITY_CONFLICT')
        rows = cache.execute('SELECT url,title,created,fulltext,content,pic_url FROM articles WHERE biz_id = ? ORDER BY created DESC LIMIT 1001', (biz,)).fetchall()
        if len(rows) > 1000:
            raise ValueError('CACHE_LOCAL_TOO_LARGE')
        items = []
        for row in rows:
            timestamp = row['created']
            if not isinstance(timestamp, (int, float)):
                parsed = datetime.datetime.fromisoformat(str(timestamp).replace('Z', '+00:00'))
                if parsed.tzinfo is None:
                    raise ValueError('CACHE_LOCAL_TIME_UNVERIFIED')
                timestamp = parsed.timestamp()
            published = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).isoformat()
            items.append({'id': row['url'], 'url': row['url'], 'title': row['title'], 'date_published': published,
                          'content_html': row['content'] or '', 'image': row['pic_url'] or ''})
        return {'items': items}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', required=True)
    parser.add_argument('--feed', required=True)
    parser.add_argument('--name', required=True)
    args = parser.parse_args()
    # ASCII JSON survives Windows code pages while retaining Unicode losslessly.
    print(json.dumps(read(args.database, args.feed, args.name), ensure_ascii=True))
