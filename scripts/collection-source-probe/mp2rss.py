"""Read-only local acceptance probe for a user's Mp2RSS subscriptions.

The caller registers the two target accounts in Mp2RSS first. This script
never changes provider subscriptions or the WeWe-RSS database. It reads the
Feed Key from the environment and sends it only to the fixed provider host.
"""

import argparse
import json
import os
import re
import sys
import unicodedata
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


BASE = "https://mp2rss.bugcode.dev"
TARGETS = (
    ("MP_WXS_3895431412", "妈妈部落畅聊阁", 20, "mama-latest20-20260928.json"),
    ("MP_WXS_3922744618", "苏洵书院升学指导", 5, "suxun-latest20-20260928.json"),
)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise ValueError("provider redirected; Feed Key was not sent to another host")


def normalized(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value or ""))


def official_url(value):
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return (
        parsed.scheme == "https"
        and parsed.netloc == "mp.weixin.qq.com"
        and parsed.path == "/s"
        and not parsed.fragment
        and bool(parsed.query)
    ) or (
        parsed.scheme == "https"
        and parsed.netloc == "mp.weixin.qq.com"
        and bool(re.fullmatch(r"/s/[A-Za-z0-9_-]{22}", parsed.path))
        and not parsed.query
        and not parsed.fragment
    )


def get_json(opener, key, path):
    req = Request(
        BASE + path,
        headers={"Authorization": "Bearer " + key, "Accept": "application/json"},
    )
    try:
        with opener.open(req, timeout=25) as response:
            if response.status != 200:
                raise ValueError("unexpected provider status")
            data = response.read(2_000_001)
            if len(data) > 2_000_000:
                raise ValueError("provider response too large")
            return json.loads(data)
    except HTTPError as exc:
        # Do not print response bodies: they can echo account data or tokens.
        raise ValueError(f"provider HTTP {exc.code}") from None
    except URLError:
        raise ValueError("provider connection failed") from None


def provider_id(opener, key, name):
    found = []
    for page in range(1, 4):
        data = get_json(
            opener,
            key,
            "/open-api/subscriptions?sourceType=mp&page="
            + str(page)
            + "&pageSize=50&q="
            + quote(name),
        )
        items = data.get("items")
        if not isinstance(items, list):
            raise ValueError("subscription list shape invalid")
        found.extend(
            item
            for item in items
            if item.get("sourceType") == "mp" and item.get("mpName") == name
        )
        if len(items) < 50:
            break
    if len(found) != 1 or type(found[0].get("mpId")) is not int:
        raise ValueError("exactly one matching subscribed account required")
    return found[0]["mpId"]


def validate_articles(data, mp_id):
    items = data.get("items")
    if not isinstance(items, list) or len(items) != 20:
        raise ValueError("provider did not return 20 articles")
    urls = set()
    times = []
    for item in items:
        if type(item) is not dict or item.get("mpId") != mp_id:
            raise ValueError("provider account identity mismatch")
        url = item.get("originalUrl")
        if not isinstance(url, str) or not official_url(url) or url in urls:
            raise ValueError("invalid or duplicate official article URL")
        urls.add(url)
        if not isinstance(item.get("title"), str) or not normalized(item["title"]):
            raise ValueError("missing article title")
        when = item.get("publishedAt")
        if type(when) is not int or when < 946684800000:
            raise ValueError("invalid publication time")
        times.append(when)
    if times != sorted(times, reverse=True):
        raise ValueError("provider articles are not latest-first")
    return items


def reference_titles(path, sample_count):
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    articles = data.get("articles")
    if not isinstance(articles, list) or len(articles) < sample_count:
        raise ValueError("local official reference is incomplete")
    return {normalized(article["title"]) for article in articles[:sample_count]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reference-dir",
        type=Path,
        required=True,
        help="Ignored directory containing the two verified desktop reference JSON files",
    )
    args = parser.parse_args()
    key = os.environ.get("MP2RSS_FEED_KEY", "").strip()
    if not key:
        raise ValueError("MP2RSS_FEED_KEY is not configured")
    opener = build_opener(NoRedirect())
    reports = []
    for local_id, name, sample_count, filename in TARGETS:
        mp_id = provider_id(opener, key, name)
        data = get_json(
            opener,
            key,
            f"/open-api/subscriptions/{mp_id}/articles?page=1&pageSize=20",
        )
        items = validate_articles(data, mp_id)
        expected = reference_titles(args.reference_dir / filename, sample_count)
        observed = {normalized(item["title"]) for item in items}
        overlap = len(expected & observed)
        reports.append(
            {
                "localMpId": local_id,
                "providerMpId": str(mp_id),
                "returned": len(items),
                "referenceSample": sample_count,
                "referenceMatched": overlap,
                "samplePassed": overlap == sample_count,
            }
        )
    print(json.dumps({"provider": "Mp2RSS", "reports": reports}, ensure_ascii=False))
    return 0 if all(item["samplePassed"] for item in reports) else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, KeyError, json.JSONDecodeError, OSError) as exc:
        print("SOURCE_PROBE_FAILED: " + str(exc), file=sys.stderr)
        sys.exit(1)
