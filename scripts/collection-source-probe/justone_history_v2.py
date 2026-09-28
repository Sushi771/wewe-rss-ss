"""Bounded, read-only probe for Just One API's WeChat history V2 endpoint.

Default mode only validates the ignored local seed file. --execute makes paid-or-
trial API requests, never writes WeWe-RSS data, and prints no token, URL, cursor,
article title, response body, or provider error message. The provider's OpenAPI
v0 does not specify data's schema, so this cannot certify archive completion.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


ENDPOINT = "https://api.justoneapi.com/api/weixin/get-account-history-articles/v2"
SHORT_URL = re.compile(r"https://mp\.weixin\.qq\.com/s/[A-Za-z0-9_-]{22}\Z")
LOCAL_ID = re.compile(r"MP_WXS_\d+\Z")
MAX_BYTES = 4_000_000


class ProbeError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise ProbeError("provider redirect refused")


def load_seeds(path):
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, list) or not data:
        raise ProbeError("seed file must be a nonempty list")
    seeds = {}
    for item in data:
        if not isinstance(item, dict):
            raise ProbeError("invalid seed record")
        local_id = item.get("mpId")
        matched = item.get("matched")
        url = matched.get("shortUrl") if isinstance(matched, dict) else None
        if (
            not isinstance(local_id, str)
            or not LOCAL_ID.fullmatch(local_id)
            or not isinstance(url, str)
            or not SHORT_URL.fullmatch(url)
            or local_id in seeds
        ):
            raise ProbeError("invalid or duplicate account seed")
        seeds[local_id] = url
    return seeds


def request_page(opener, token, article_url, offset):
    body = urlencode({"token": token, "ghid": "", "url": article_url, "offset": offset}).encode()
    request = Request(
        ENDPOINT,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        method="POST",
    )
    try:
        with opener.open(request, timeout=120) as response:
            if response.status != 200:
                raise ProbeError("provider HTTP status was not 200")
            if "json" not in response.headers.get("Content-Type", "").lower():
                raise ProbeError("provider did not return JSON")
            payload = response.read(MAX_BYTES + 1)
    except HTTPError as exc:
        raise ProbeError(f"provider HTTP {exc.code}") from None
    except URLError:
        raise ProbeError("provider connection failed") from None
    if len(payload) > MAX_BYTES:
        raise ProbeError("provider response too large")
    try:
        envelope = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ProbeError("provider returned invalid JSON") from None
    if not isinstance(envelope, dict) or type(envelope.get("code")) is not int:
        raise ProbeError("provider envelope invalid")
    if envelope["code"] != 0:
        # The provider may echo submitted values in message/data; never print them.
        raise ProbeError(f"provider business code {envelope['code']}")
    if "data" not in envelope:
        raise ProbeError("provider data missing")
    return envelope["data"]


def response_shape(value, depth=0):
    """Expose only field names and collection sizes, never field values."""
    if isinstance(value, dict):
        keys = sorted(k for k in value if isinstance(k, str))
        if depth >= 3:
            return {"type": "object", "fieldCount": len(keys)}
        fields = [
            {
                "name": k if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", k) else "<other>",
                "shape": response_shape(value[k], depth + 1),
            }
            for k in keys[:20]
        ]
        return {"type": "object", "fields": fields, "truncated": len(keys) > 20}
    if isinstance(value, list):
        return {"type": "array", "count": len(value), "item": response_shape(value[0], depth + 1) if value and depth < 3 else None}
    return {"type": type(value).__name__}


def next_offset(data):
    """Only the documented PagingInfo.Offset path may drive another request."""
    candidates = []
    if isinstance(data, dict):
        candidates.append(data)
        for value in data.values():
            if isinstance(value, dict):
                candidates.append(value)
    found = [obj["PagingInfo"]["Offset"] for obj in candidates
             if isinstance(obj.get("PagingInfo"), dict) and "Offset" in obj["PagingInfo"]]
    if len(found) != 1 or not isinstance(found[0], str):
        return None
    return found[0] or None


def probe(opener, token, article_url, max_pages):
    seen = set()
    offset = ""
    reports = []
    for page in range(1, max_pages + 1):
        data = request_page(opener, token, article_url, offset)
        candidate = next_offset(data)
        if candidate:
            digest = hashlib.sha256(candidate.encode()).hexdigest()
            if digest in seen:
                raise ProbeError("provider repeated a pagination cursor")
            seen.add(digest)
        reports.append({"page": page, "shape": response_shape(data), "nextOffsetPresent": bool(candidate)})
        if not candidate:
            return {"pages": reports, "stop": "cursor_absent_or_empty_unverified"}
        offset = candidate
    return {"pages": reports, "stop": "configured_page_limit"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seeds", type=Path, required=True, help="Ignored official-seeds JSON; never printed")
    parser.add_argument("--account-id", help="One local MP_WXS account ID; required with --execute")
    parser.add_argument("--max-pages", type=int, default=2, help="Hard request cap, 1-5 (default: 2)")
    parser.add_argument("--execute", action="store_true", help="Actually send bounded requests; may consume trial/paid quota")
    args = parser.parse_args(argv)
    if not 1 <= args.max_pages <= 5:
        raise ProbeError("max-pages must be 1-5")
    seeds = load_seeds(args.seeds)
    if not args.execute:
        print(json.dumps({"mode": "offline", "validAccountSeeds": len(seeds), "requests": 0}))
        return 0
    if not args.account_id or args.account_id not in seeds:
        raise ProbeError("select an account ID present in the seed file")
    token = os.environ.get("JUSTONEAPI_TOKEN", "").strip()
    if not token:
        raise ProbeError("JUSTONEAPI_TOKEN is not configured locally")
    report = probe(build_opener(NoRedirect()), token, seeds[args.account_id], args.max_pages)
    print(json.dumps({"mode": "read-only", "accountId": args.account_id, **report}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ProbeError, OSError, ValueError, json.JSONDecodeError) as exc:
        print("HISTORY_PROBE_FAILED: " + str(exc), file=sys.stderr)
        sys.exit(1)
