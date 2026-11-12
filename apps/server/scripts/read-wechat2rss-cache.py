"""Read committed local cache only. No network, writes, refresh or media."""
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



def list_subscriptions(database):
    source = Path(database)
    if not source.is_absolute() or not source.is_file():
        raise ValueError('CACHE_LOCAL_READ_UNAVAILABLE')
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as cache:
        cache.execute('PRAGMA query_only=ON')
        cache.execute('BEGIN')
        rows = cache.execute('SELECT biz_id,name FROM rsses LIMIT 1001').fetchall()
        if len(rows) > 1000:
            raise ValueError('CACHE_LOCAL_TOO_LARGE')
        result = []
        seen = set()
        for biz, name in rows:
            biz = str(biz)
            if not re.fullmatch(r'\d{5,15}', biz) or not isinstance(name, str) or not name.strip() or biz in seen:
                raise ValueError('CACHE_LOCAL_IDENTITY_CONFLICT')
            seen.add(biz)
            # These optional upstream fields are deliberately unknown. Local
            # reading does not infer a successful source request or account state.
            result.append({'feedId': 'MP_WXS_' + biz, 'name': name,
                           'feedUrl': '/feed/' + biz + '.json',
                           'checkTime': None, 'nextUpdateTime': None, 'paused': None})
        return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', required=True)
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--feed')
    parser.add_argument('--name')
    args = parser.parse_args()
    # ASCII JSON survives Windows code pages while retaining Unicode losslessly.
    if args.list:
        if args.feed is not None or args.name is not None:
            parser.error('--list cannot be combined with --feed or --name')
        result = list_subscriptions(args.database)
    else:
        if args.feed is None or args.name is None:
            parser.error('--feed and --name are required')
        result = read(args.database, args.feed, args.name)
    print(json.dumps(result, ensure_ascii=True))
