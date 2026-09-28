"""Offline contract and quota-boundary checks for the history probe."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("probe", Path(__file__).with_name("justone_history_v2.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Response:
    status = 200
    headers = {"Content-Type": "application/json"}

    def __init__(self, payload):
        self.payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, *_):
        return self.payload


class Opener:
    def __init__(self, pages):
        self.pages = pages
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        assert timeout == 120
        return Response(self.pages.pop(0))


class HistoryProbeTests(unittest.TestCase):
    def test_offline_seed_validation_and_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "seeds.json"
            seed = {"mpId": "MP_WXS_1", "matched": {"shortUrl": "https://mp.weixin.qq.com/s/" + "a" * 22}}
            path.write_text(json.dumps([seed]), encoding="utf-8")
            self.assertEqual(len(probe.load_seeds(path)), 1)
            path.write_text(json.dumps([seed, seed]), encoding="utf-8")
            with self.assertRaises(probe.ProbeError):
                probe.load_seeds(path)

    def test_bounded_pages_and_secret_stays_in_post_body(self):
        opener = Opener([
            {"code": 0, "data": {"ArticleList": [{"title": "private"}], "PagingInfo": {"Offset": "next"}}},
            {"code": 0, "data": {"ArticleList": [], "PagingInfo": {"Offset": ""}}},
        ])
        report = probe.probe(opener, "secret-token", "https://mp.weixin.qq.com/s/" + "a" * 22, 2)
        self.assertEqual(report["stop"], "cursor_absent_or_empty_unverified")
        self.assertEqual(len(opener.requests), 2)
        self.assertNotIn("secret-token", opener.requests[0].full_url)
        self.assertIn(b"token=secret-token", opener.requests[0].data)
        self.assertIn(b"offset=next", opener.requests[1].data)
        self.assertNotIn("private", json.dumps(report))

    def test_business_error_does_not_echo_provider_message(self):
        opener = Opener([{"code": 601, "message": "secret-token", "data": "private"}])
        with self.assertRaisesRegex(probe.ProbeError, "business code 601") as caught:
            probe.request_page(opener, "secret-token", "https://mp.weixin.qq.com/s/" + "a" * 22, "")
        self.assertNotIn("secret-token", str(caught.exception))

    def test_repeated_cursor_is_rejected(self):
        page = {"code": 0, "data": {"PagingInfo": {"Offset": "same"}}}
        with self.assertRaisesRegex(probe.ProbeError, "repeated"):
            probe.probe(Opener([page, page]), "secret", "https://mp.weixin.qq.com/s/" + "a" * 22, 5)


if __name__ == "__main__":
    unittest.main()
