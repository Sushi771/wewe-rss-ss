"""Tiny public-schema fixture; never reads a production database."""
import argparse
import hashlib
import sqlite3
from pathlib import Path

def create(database, migrations, legacy=False):
    if database.exists():
        raise ValueError('Fixture must be new')
    with sqlite3.connect(database) as db:
        db.execute('CREATE TABLE _prisma_migrations(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, finished_at DATETIME, migration_name TEXT NOT NULL, logs TEXT, rolled_back_at DATETIME, started_at DATETIME DEFAULT CURRENT_TIMESTAMP, applied_steps_count INTEGER DEFAULT 1)')
        for file in sorted(migrations.glob('*/migration.sql')):
            if legacy and file.parent.name >= '20260928020000_article_body_status':
                break
            sql = file.read_text(encoding='utf-8')
            db.executescript(sql)
            db.execute('INSERT INTO _prisma_migrations(id,checksum,finished_at,migration_name) VALUES(?,?,CURRENT_TIMESTAMP,?)', (file.parent.name, hashlib.sha256(file.read_bytes()).hexdigest(), file.parent.name))
        for feed in ['MP_WXS_3895431412', 'MP_WXS_3922744618']:
            db.execute('INSERT INTO feeds(id,mp_name,mp_cover,mp_intro,update_time,collection_channel) VALUES(?,?,?,?,?,?)', (feed, 'Synthetic feed', '', 'Offline fixture', 1, 'wechat2rss'))
            for index in range(20):
                body = '<div id="js_content"><p>Offline synthetic cached body for export verification.</p></div>'
                db.execute('INSERT INTO articles(id,mp_id,title,pic_url,publish_time,content_html) VALUES(?,?,?,?,?,?)', (f'{feed}_{index}', feed, f'Synthetic article {index}', '', 1700000000 + index, body))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--migrations', type=Path, required=True)
    parser.add_argument('--legacy', action='store_true')
    args = parser.parse_args()
    create(args.database, args.migrations, args.legacy)
