"""Bounded, offline article preservation. This module has no deletion operation.

Database connections are read-only/autocommit. No SQLite backup or upstream
request is made. The host owns recovery verification and batch approval.
"""

import argparse
import base64
from contextlib import closing
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import tempfile
from urllib.parse import unquote, urlsplit


class CoverageError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    if isinstance(value, bytes):
        return {"sqliteBlobBase64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, dict):
        return {k: encode(v) for k, v in value.items()}
    return value


def canonical(value):
    return json.dumps(encode(value), ensure_ascii=True, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def regular(path, roots=None):
    path = Path(os.path.abspath(path))
    for part in [path, *path.parents]:
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise CoverageError("symlink/reparse path rejected")
    if not path.is_file() or path.stat().st_nlink != 1:
        raise CoverageError("expected a regular file with one link")
    if roots is not None and not any(path.is_relative_to(Path(r).resolve()) for r in roots):
        raise CoverageError("file outside declared roots")
    return path


def identity(path):
    path = regular(path)
    info = path.stat()  # Path.stat, not cached Windows DirEntry.stat.
    if not info.st_ino:
        raise CoverageError("filesystem does not expose stable file identity")
    return {"path": str(path), "device": info.st_dev, "inode": info.st_ino,
            "size": info.st_size, "mtimeNs": info.st_mtime_ns,
            "ctimeNs": info.st_ctime_ns}


def database_identity(path):
    main = identity(path)
    sidecars = {}
    for suffix in ("-wal", "-journal"):
        side = Path(str(path) + suffix)
        sidecars[suffix] = identity(side) if side.exists() else None
    return {"main": main, "sidecars": sidecars}


class Budget:
    def __init__(self, maximum):
        self.maximum = maximum
        self.used = 0

    def charge(self, count):
        self.used += count
        if self.used > self.maximum:
            raise CoverageError("archive/read byte budget exceeded")


def read_file(path, budget, limit=32 * 1024 * 1024):
    before = identity(path)
    if before["size"] > limit:
        raise CoverageError("individual file limit exceeded")
    budget.charge(before["size"])
    # Bound the read even if a writer grows the file after the initial stat.
    with Path(path).open("rb") as handle:
        opened = os.fstat(handle.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size) != (before["device"], before["inode"], before["size"]):
            raise CoverageError("opened file identity changed")
        data = handle.read(min(limit, before["size"]) + 1)
        after = os.fstat(handle.fileno())
        if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns):
            raise CoverageError("file changed through read handle")
    if identity(path) != before or len(data) != before["size"]:
        raise CoverageError("file changed during read")
    return data


def read_articles(path, budget, visit, *, maximum_rows=100000, _after_batch=None):
    """Keep ONE connection through final data_version; never hold a long txn."""
    before = database_identity(path)
    uri = Path(path).as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True, isolation_level=None, timeout=0.1)) as db:
        db.execute("PRAGMA query_only=ON")
        version = db.execute("PRAGMA data_version").fetchone()[0]
        db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 32 * 1024 * 1024)
        cols = [r[1] for r in db.execute("PRAGMA table_info(articles)")]
        if not {"id", "mp_id", "content_html"}.issubset(cols):
            raise CoverageError("unsupported articles schema")
        # Small keyset pages release each SELECT before hashing/copying media.
        last = None
        count = 0
        while True:
            query = "SELECT * FROM articles "
            args = ()
            if last is not None:
                query += "WHERE id > ? "
                args = (last,)
            rows = db.execute(query + "ORDER BY id LIMIT 2", args).fetchall()
            if not rows:
                break
            for values in rows:
                count += 1
                if count > maximum_rows:
                    raise CoverageError("article row limit exceeded")
                row = dict(zip(cols, values))
                budget.charge(len(canonical(row)))
                visit(row)
            last = rows[-1][cols.index("id")]
            if _after_batch:
                _after_batch()
        # Only selected feed context; never accounts or credentials tables.
        context = {}
        available = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table, allowed in (("feeds", ("id", "mp_name", "group_id", "public_album_ids", "collection_channel")),
                               ("management_groups", ("id", "name", "platform", "order"))):
            if table not in available:
                continue
            present = {r[1] for r in db.execute('PRAGMA table_info("' + table + '")')}
            fields = [c for c in allowed if c in present]
            quoted = ",".join('"' + c + '"' for c in fields)
            context[table] = []
            cursor = db.execute('SELECT ' + quoted + ' FROM "' + table + '" LIMIT 10001')
            for row in cursor:
                item = dict(zip(fields, row))
                budget.charge(len(canonical(item)))
                context[table].append(item)
                if len(context[table]) > 10000:
                    raise CoverageError("context row limit exceeded")
            cursor.close()
        if db.execute("PRAGMA data_version").fetchone()[0] != version:
            raise CoverageError("database committed during archive scan")
        if database_identity(path) != before:
            raise CoverageError("database/WAL identity changed during scan")
    return before, context


def body_bytes(row):
    body = row.get("content_html")
    if body is None:
        return b""
    if not isinstance(body, str):
        raise CoverageError("body must be SQLite TEXT or NULL")
    return body.encode("utf-8")


def row_key(row):
    return digest(canonical([row["mp_id"], row["id"]]))


def metadata(row):
    return {k: v for k, v in row.items() if k != "content_html"}


def image_type(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp"
    raise CoverageError("unsupported or corrupt image signature")


class Reader(HTMLParser):
    """Render an allowlisted reader; raw HTML remains a separate exact object."""
    tags = {"p", "div", "span", "br", "h1", "h2", "h3", "h4", "ul", "ol", "li",
            "strong", "em", "b", "i", "blockquote", "pre", "code", "table", "tr", "td", "th"}

    def __init__(self, store, media_roots, issues, unknown):
        super().__init__(convert_charrefs=True)
        self.store = store
        self.media_roots = media_roots
        self.issues = issues
        self.unknown = unknown
        self.output = []
        self.assets = []
        self.suppressed = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in {"script", "style", "iframe", "object", "embed", "svg", "math"}:
            if tag != "script":
                self.issues.append("unsupported-active-or-vector-media")
            self.suppressed += 1
            return
        if self.suppressed:
            return
        if attrs.get("data-wewe-image-pending", "0") not in {"0", "", "false"}:
            self.issues.append("pending-image-marker")
        css = attrs.get("style", "").lower()
        if any(k in attrs for k in ("srcset", "poster", "background")) or any(marker in css for marker in ("url", "image", "background", "\\", "@")):
            self.issues.append("unsupported-image-reference")
        if tag in {"source", "video", "audio", "link"}:
            self.issues.append("unsupported-media-reference")
        if tag == "img":
            # A verified inline src takes precedence over stale remote data-src.
            address = attrs.get("src") or attrs.get("data-src")
            if not address:
                self.issues.append("empty-image-reference-unknown")
                self.output.append("<span>[empty image placeholder]</span>")
                return
            try:
                if address.startswith("data:"):
                    match = re.fullmatch(r"data:image/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\r\n]+)", address, re.I)
                    if not match:
                        raise CoverageError("invalid data image")
                    data = base64.b64decode(re.sub(r"\s", "", match[2]), validate=True)
                    kind = image_type(data)
                    if match[1].lower().replace("jpg", "jpeg") != kind:
                        raise CoverageError("image MIME mismatch")
                else:
                    parsed = urlsplit(address)
                    if parsed.scheme in {"http", "https"} or address.startswith("//"):
                        self.unknown.append(address)
                        self.output.append("<span>[external image: historical pixels unknown]</span>")
                        return
                    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
                        raise CoverageError("unsupported local image URL")
                    decoded = unquote(address)
                    if "%" in decoded or "\\" in decoded or "\x00" in decoded or any(p == ".." for p in Path(decoded).parts):
                        raise CoverageError("unsafe local image path")
                    if not self.media_roots or Path(decoded).is_absolute() or ":" in decoded:
                        raise CoverageError("local image requires relative path and media roots")
                    candidates = [Path(root) / decoded for root in self.media_roots]
                    matches = [regular(p, self.media_roots) for p in candidates if p.exists()]
                    if len(matches) != 1:
                        raise CoverageError("local image missing or ambiguous")
                    data = read_file(matches[0], self.store.budget)
                    kind = image_type(data)
                asset = self.store.put(data, "assets", kind)
                self.assets.append(asset)
                self.output.append('<img loading="eager" src="../' + asset + '" alt="archived image">')
            except (CoverageError, ValueError, OSError) as error:
                self.issues.append(type(error).__name__ + ":image-uncovered")
                self.output.append("<span>[uncovered image]</span>")
        elif tag in self.tags:
            self.output.append("<" + tag + ">")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in {"img", "br"}:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in {"script", "style", "iframe", "object", "embed", "svg", "math"} and self.suppressed:
            self.suppressed -= 1
        elif not self.suppressed and tag in self.tags and tag != "br":
            self.output.append("</" + tag + ">")

    def handle_data(self, data):
        if not self.suppressed:
            self.output.append(html.escape(data))


CSP = "default-src 'none'; img-src 'self'; style-src 'none'; base-uri 'none'; form-action 'none'"


def page(title, content):
    return ('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' +
            CSP + '"><title>' + html.escape(str(title)) + '</title></head><body><h1>' +
            html.escape(str(title)) + '</h1>' + content + '</body></html>').encode("utf-8")


def render_row(reader, row):
    # Cover references are article metadata too; preserve local/inline pixels.
    if row.get("pic_url"):
        reader.feed('<img src="' + html.escape(str(row["pic_url"]), quote=True) + '">')
    reader.feed(body_bytes(row).decode("utf-8"))
    reader.close()


class Store:
    def __init__(self, root, budget):
        self.root, self.budget, self.files = root, budget, {}

    def put(self, data, folder, suffix):
        name = folder + "/" + digest(data) + "." + suffix
        if name not in self.files:
            self.budget.charge(len(data))
            target = self.root / name
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(data)
            self.files[name] = {"sha256": digest(data), "bytes": len(data)}
        return name


def prepareArchive(sources, current, archive_root, *, source_roots, media_roots=(),
                   max_bytes=128 * 1024 * 1024, maximum_rows=100000):
    """Create a NEW bounded archive; never overwrite an existing archive."""
    if not sources or len(sources) > 64:
        raise CoverageError("expected 1..64 source files")
    current = regular(current)
    sources = [regular(p, source_roots) for p in sources]
    physical_sources = {(p.stat().st_dev, p.stat().st_ino) for p in sources}
    if len(physical_sources) != len(sources) or (current.stat().st_dev, current.stat().st_ino) in physical_sources:
        raise CoverageError("duplicate source or current supplied as retirement source")
    destination = Path(os.path.abspath(archive_root))
    if destination.exists() or any(destination.is_relative_to(Path(r).resolve()) for r in source_roots):
        raise CoverageError("archive must be new and outside retirement roots")
    destination.parent.mkdir(parents=True, exist_ok=True)
    for parent in [destination.parent, *destination.parent.parents]:
        if parent.is_symlink() or getattr(parent.lstat(), "st_file_attributes", 0) & 0x400:
            raise CoverageError("archive parent reparse path rejected")
    budget = Budget(max_bytes)
    staging = Path(tempfile.mkdtemp(prefix=".article-history-building-", dir=destination.parent))
    store = Store(staging, budget)
    current_rows = {}

    def remember(row):
        current_rows[row_key(row)] = {"body": digest(body_bytes(row)), "metadata": digest(canonical(metadata(row)))}

    current_fp, _ = read_articles(current, budget, remember, maximum_rows=maximum_rows)
    ledger, provenance, issues, unknown = [], [], [], []
    for source in sources:
        first = len(ledger)

        def archive(row):
            raw = body_bytes(row)
            body = store.put(raw, "bodies", "html")
            meta = store.put(canonical(metadata(row)), "metadata", "json")
            reader = Reader(store, media_roots, issues, unknown)
            render_row(reader, row)
            reading = store.put(page(row.get("title", row["id"]), "".join(reader.output)), "readers", "html")
            key = row_key(row)
            ledger.append({"source": len(provenance), "key": key, "body": body,
                           "bodySha256": digest(raw), "metadata": meta,
                           "metadataSha256": digest(canonical(metadata(row))),
                           "reader": reading, "assets": reader.assets,
                           "currentMatch": current_rows.get(key), "bodyWasNull": row["content_html"] is None})

        fp, context = read_articles(source, budget, archive, maximum_rows=maximum_rows)
        if len(ledger) == first:
            issues.append("empty-source-not-qualified")
        provenance.append({"identity": fp, "rows": len(ledger) - first,
                           "context": store.put(canonical(context), "context", "json")})
    for item in provenance:
        if database_identity(item["identity"]["main"]["path"]) != item["identity"]:
            raise CoverageError("source changed before publication")
    if database_identity(current) != current_fp:
        raise CoverageError("current changed before publication")
    links = "".join('<p><a href="' + entry["reader"] + '">Historical version ' + str(i + 1) + '</a></p>'
                    for i, entry in enumerate(ledger))
    index = page("Preserved article history", links)
    budget.charge(len(index))
    (staging / "index.html").write_bytes(index)
    store.files["index.html"] = {"sha256": digest(index), "bytes": len(index)}
    manifest = {"schemaVersion": 1, "scope": "wechat-articles-only", "current": current_fp,
                "sources": provenance, "entries": ledger, "files": store.files,
                "issues": sorted(set(issues)), "externalUnknown": sorted(set(unknown)),
                "mediaRoots": [str(Path(r).absolute()) for r in media_roots],
                "maximumBytes": max_bytes, "readAndWriteBytes": budget.used}
    payload = canonical(manifest)
    if len(payload) > 16 * 1024 * 1024:
        raise CoverageError("manifest limit exceeded; split the batch")
    budget.charge(len(payload))
    (staging / "manifest.json").write_bytes(payload)
    staging.rename(destination)
    return {"archive": str(destination), "manifestSha256": digest(payload),
            "articles": len(ledger), "issues": manifest["issues"],
            "externalUnknownCount": len(manifest["externalUnknown"])}


def load_manifest(root):
    root = Path(root).absolute()
    manifest_identity = identity(root / "manifest.json")
    raw = read_file(regular(root / "manifest.json"), Budget(16 * 1024 * 1024), 16 * 1024 * 1024)
    manifest = json.loads(raw)
    if manifest.get("schemaVersion") != 1 or manifest.get("scope") != "wechat-articles-only":
        raise CoverageError("unsupported manifest")
    budget = Budget(manifest["maximumBytes"])
    read_identities = []
    for name, spec in manifest["files"].items():
        candidate = Path(name)
        if candidate.is_absolute() or ".." in candidate.parts or "\\" in name or ":" in name:
            raise CoverageError("unsafe manifest path")
        target = regular(root / candidate, [root])
        before = identity(target)
        data = read_file(target, budget)
        read_identities.append((target, before))
        if len(data) != spec["bytes"] or digest(data) != spec["sha256"]:
            raise CoverageError("archive file hash/size mismatch")
    for entry in manifest["entries"]:
        for field, sha in (("body", "bodySha256"), ("metadata", "metadataSha256")):
            if entry[field] not in manifest["files"] or manifest["files"][entry[field]]["sha256"] != entry[sha]:
                raise CoverageError("ledger object not covered")
        if entry["reader"] not in manifest["files"] or any(a not in manifest["files"] for a in entry["assets"]):
            raise CoverageError("reader/image closure missing")
    for target, expected in read_identities:
        if identity(target) != expected:
            raise CoverageError("archive file changed during final scan")
    repeated = read_file(root / "manifest.json", Budget(16 * 1024 * 1024), 16 * 1024 * 1024)
    if identity(root / "manifest.json") != manifest_identity or repeated != raw:
        raise CoverageError("manifest changed during archive scan")
    return root, manifest, digest(raw)


def browser_check(root, pages):
    script = Path(__file__).with_name("article-history-browser.cjs")
    request = canonical({"root": str(root), "pages": pages}).decode("ascii")
    result = subprocess.run(["node", str(script)], input=request, text=True,
                            capture_output=True, timeout=180,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise CoverageError("offline browser validation failed: " + result.stderr[-400:])
    return json.loads(result.stdout)


def verifyCoverage(archive_root):
    """Read back objects AND decode images in an isolated offline browser."""
    root, manifest, sha = load_manifest(archive_root)
    if manifest["issues"]:
        return {"verified": False, "manifestSha256": sha, "issues": manifest["issues"]}
    # Reconcile against source rows, not just an archive's self-reported counts.
    # Connections close before Chromium starts. No full database copy is made.
    budget = Budget(manifest["maximumBytes"])
    matches = {}
    rebuilt_issues, rebuilt_unknown = [], []

    class ReadbackStore:
        def __init__(self):
            self.budget = budget

        def put(self, data, folder, suffix):
            name = folder + "/" + digest(data) + "." + suffix
            expected = {"sha256": digest(data), "bytes": len(data)}
            if manifest["files"].get(name) != expected:
                raise CoverageError("reconstructed image/object missing")
            return name

    readback = ReadbackStore()

    def remember(row):
        matches[row_key(row)] = {"body": digest(body_bytes(row)), "metadata": digest(canonical(metadata(row)))}

    current_fp, _ = read_articles(manifest["current"]["main"]["path"], budget, remember)
    if current_fp != manifest["current"]:
        raise CoverageError("current identity changed")
    for number, source in enumerate(manifest["sources"]):
        actual = []
        expected = [e for e in manifest["entries"] if e["source"] == number]

        def compare(row):
            actual.append((row_key(row), digest(body_bytes(row)), digest(canonical(metadata(row))), row["content_html"] is None))
            if len(actual) > len(expected):
                raise CoverageError("source article coverage mismatch")
            entry = expected[len(actual) - 1]
            reader = Reader(readback, manifest.get("mediaRoots", []), rebuilt_issues, rebuilt_unknown)
            render_row(reader, row)
            expected_page = page(row.get("title", row["id"]), "".join(reader.output))
            expected_reader = "readers/" + digest(expected_page) + ".html"
            if entry["assets"] != reader.assets or entry["reader"] != expected_reader:
                raise CoverageError("reader/image reference closure changed")
            if manifest["files"].get(expected_reader) != {"sha256": digest(expected_page), "bytes": len(expected_page)}:
                raise CoverageError("reconstructed reader not preserved")

        fp, context = read_articles(source["identity"]["main"]["path"], budget, compare)
        preserved = [(e["key"], e["bodySha256"], e["metadataSha256"], e["bodyWasNull"]) for e in expected]
        if fp != source["identity"] or actual != preserved or len(actual) != source["rows"]:
            raise CoverageError("source article coverage mismatch or identity changed")
        if any(e["currentMatch"] != matches.get(e["key"]) for e in expected):
            raise CoverageError("current article comparison changed")
        if source["context"] not in manifest["files"] or manifest["files"][source["context"]]["sha256"] != digest(canonical(context)):
            raise CoverageError("feed/group context not covered")
    if any(not isinstance(e["source"], int) or e["source"] < 0 or e["source"] >= len(manifest["sources"]) for e in manifest["entries"]):
        raise CoverageError("invalid ledger source")
    if sorted(set(rebuilt_issues)) != manifest["issues"] or sorted(set(rebuilt_unknown)) != manifest["externalUnknown"]:
        raise CoverageError("image coverage status changed")
    pages = sorted({entry["reader"] for entry in manifest["entries"]} | {"index.html"})
    if len(pages) > 128:
        raise CoverageError("browser page limit exceeded; split the batch")
    result = browser_check(root, pages)
    image_counts = {entry["reader"]: len(entry["assets"]) for entry in manifest["entries"]}
    if result.get("pages") != len(pages) or result.get("images") != sum(image_counts.values()) or result.get("remoteRequests") != 0 or not result.get("decoded"):
        raise CoverageError("incomplete browser coverage")
    if load_manifest(root)[2] != sha:
        raise CoverageError("manifest changed during verification")
    for fp in [manifest["current"], *[source["identity"] for source in manifest["sources"]]]:
        if database_identity(fp["main"]["path"]) != fp:
            raise CoverageError("database changed during browser validation")
    return {"verified": True, "manifestSha256": sha, "articles": len(manifest["entries"]),
            "externalUnknownCount": len(manifest["externalUnknown"]), "browser": result}


def planRetirements(archive_root, *, protections=(), non_article_coverage=None,
                    accept_external_unknown=False):
    """Return a review manifest only. No apply/delete executor exists.

    Host contract: protections contain fresh verified owner/previous recovery
    point receipts; non_article_coverage is a fresh host receipt covering tables
    outside this article-only archive. These are review evidence, not approval.
    """
    root, manifest, sha = load_manifest(archive_root)
    held, candidates = [], []
    result = verifyCoverage(root)  # never trust a caller-supplied old report
    if result.get("manifestSha256") != sha:
        raise CoverageError("coverage report belongs to a different manifest")
    held.extend(manifest["issues"])
    if not result["verified"]:
        held.extend(result["issues"])
    if manifest["externalUnknown"] and not accept_external_unknown:
        held.append("external-historical-pixels-unknown")
    valid_roles = set()
    recovery_paths = set()
    def physical(fp):
        return (fp["main"]["device"], fp["main"]["inode"])

    protected_paths = {physical(manifest["current"])}
    for receipt in protections:
        if receipt.get("role") not in {"owner", "previous"} or not re.fullmatch(r"[0-9a-f]{64}", receipt.get("verificationSha256", "")):
            raise CoverageError("invalid recovery receipt")
        if database_identity(receipt["identity"]["main"]["path"]) != receipt["identity"]:
            raise CoverageError("protected recovery changed")
        valid_roles.add(receipt["role"])
        if any(receipt["identity"]["sidecars"].values()):
            held.append("recovery-point-has-unresolved-sidecar")
        recovery_paths.add(physical(receipt["identity"]))
        protected_paths.add(physical(receipt["identity"]))
    if valid_roles != {"owner", "previous"} or len(recovery_paths) < 2:
        held.append("two-distinct-verified-recovery-points-required")
    if not isinstance(non_article_coverage, dict) or non_article_coverage.get("manifestSha256") != sha or not re.fullmatch(r"[0-9a-f]{64}", non_article_coverage.get("verificationSha256", "")):
        held.append("host-non-article-state-coverage-required")
    if database_identity(manifest["current"]["main"]["path"]) != manifest["current"]:
        held.append("current-database-changed")
    for source in manifest["sources"]:
        fp = source["identity"]
        path = fp["main"]["path"]
        reason = None
        if physical(fp) in protected_paths:
            reason = "protected-recovery-point"
        elif database_identity(path) != fp:
            reason = "source-identity-changed"
        elif any(fp["sidecars"].values()):
            reason = "source-has-live-or-unresolved-sidecar"
        if reason:
            held.append(reason)
        candidates.append({"identity": fp, "rows": source["rows"]})
    if load_manifest(root)[2] != sha:
        raise CoverageError("archive changed while planning")
    if database_identity(manifest["current"]["main"]["path"]) != manifest["current"]:
        held.append("current-database-changed")
    for source in manifest["sources"]:
        if database_identity(source["identity"]["main"]["path"]) != source["identity"]:
            held.append("source-identity-changed")
    for receipt in protections:
        if database_identity(receipt["identity"]["main"]["path"]) != receipt["identity"]:
            held.append("protected-recovery-changed")
    plan = {"schemaVersion": 1, "archive": str(root), "manifestSha256": sha,
            "requiresSpecificBatchApproval": True, "executable": False,
            "eligible": candidates if not held else [], "heldReasons": sorted(set(held)),
            "protections": list(protections), "nonArticleCoverage": non_article_coverage,
            "acceptedExternalUnknown": accept_external_unknown,
            "coverage": result}
    plan["batchSha256"] = digest(canonical(plan))
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--current", required=True)
    prepare.add_argument("--source", action="append", required=True)
    prepare.add_argument("--source-root", action="append", required=True)
    prepare.add_argument("--media-root", action="append", default=[])
    prepare.add_argument("--archive", required=True)
    prepare.add_argument("--max-bytes", type=int, default=128 * 1024 * 1024)
    for name in ("verify", "plan"):
        sub.add_parser(name).add_argument("--archive", required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            result = prepareArchive(args.source, args.current, args.archive,
                                    source_roots=args.source_root, media_roots=args.media_root,
                                    max_bytes=args.max_bytes)
        elif args.command == "verify":
            result = verifyCoverage(args.archive)
        else:
            # CLI intentionally cannot assert host recovery/other-table proofs.
            result = planRetirements(args.archive)
        print(json.dumps(result, ensure_ascii=True))
        if args.command == "verify" and not result.get("verified"):
            raise SystemExit(1)
    except (CoverageError, OSError, sqlite3.Error, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"verified": False, "eligible": [], "error": str(error)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
