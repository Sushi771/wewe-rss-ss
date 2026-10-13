import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

SCRIPT = Path(__file__).with_name('read-wechat2rss-cache.py')
spec = importlib.util.spec_from_file_location('cache_read', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReadCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / 'cache.db'
        with closing(sqlite3.connect(self.database)) as db:
            db.execute('CREATE TABLE rsses(biz_id INTEGER,name TEXT)')
            db.execute('CREATE TABLE articles(biz_id INTEGER,url TEXT,title TEXT,created TEXT,fulltext TEXT,content TEXT,pic_url TEXT)')
            db.execute('INSERT INTO rsses VALUES(1234567890,?)', ('测试公众号',))
            db.execute('INSERT INTO articles VALUES(1234567890,?,?,?,?,?,?)', ('https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=9&idx=1', '标题😱', '2026-10-11 13:27:00+08:00', 1, '<p>正文😱</p>', ''))
            db.commit()

    def tearDown(self):
        self.temp.cleanup()

    def test_unicode_and_timezone_survive_ascii_transport_without_writes(self):
        before = self.database.read_bytes()
        output = subprocess.check_output([sys.executable, str(SCRIPT), '--database', str(self.database), '--feed', 'MP_WXS_1234567890', '--name', '测试公众号'])
        self.assertTrue(output.isascii())
        item = json.loads(output)['items'][0]
        self.assertEqual(item['title'], '标题😱')
        self.assertEqual(item['content_html'], '<p>正文😱</p>')
        self.assertEqual(item['date_published'], '2026-10-11T05:27:00+00:00')
        self.assertEqual(self.database.read_bytes(), before)

    def test_wrong_publisher_name_or_identity_is_rejected(self):
        with self.assertRaises(ValueError):
            module.read(str(self.database), 'MP_WXS_1234567890', '另一个号')
        with self.assertRaises(ValueError):
            module.read(str(self.database), 'MP_WXS_2234567890', '测试公众号')
        with self.assertRaises(ValueError):
            module.read(str(self.database), '1234567890', '测试公众号')


if __name__ == '__main__':
    unittest.main()
