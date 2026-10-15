"""In-process snapshot-owner integration. Never accepts proof digests as input.

Only explicit owner stdio requests run this code. No timer, deletion or backup
creation is added. Review results are private local metadata, not capabilities
to delete files. The existing owner remains the source of snapshot authority.
"""
from collections import Counter
from contextlib import closing, contextmanager
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import threading
import time
import uuid
from urllib.parse import unquote, urlsplit

import article_history as history


class HostError(history.CoverageError):
    pass


def wire(value):
    """Keep Windows file indices/nanoseconds exact through JavaScript JSON."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and abs(value) > 9007199254740991:
        return str(value)
    if isinstance(value, dict):
        return {key: wire(child) for key, child in value.items()}
    if isinstance(value, list):
        return [wire(child) for child in value]
    return value


def physical(fp):
    return fp['main']['device'], fp['main']['inode']


class Limit(history.Budget):
    def __init__(self, maximum, seconds):
        if not 65536 <= maximum <= 16 * 1024**3 or not 5 <= seconds <= 300:
            raise HostError('INVALID_HOST_LIMIT')
        super().__init__(maximum)
        self.deadline = time.monotonic() + seconds

    def tick(self):
        if time.monotonic() > self.deadline:
            raise HostError('HOST_DEADLINE')

    def charge(self, count):
        self.tick()
        super().charge(count)


def file_sha(path, budget):
    before = history.identity(path)
    budget.charge(before['size'])
    result = hashlib.sha256()
    with Path(path).open('rb') as handle:
        opened = os.fstat(handle.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size) != (before['device'], before['inode'], before['size']):
            raise HostError('FILE_HANDLE_CHANGED')
        remaining = before['size']
        while remaining:
            budget.tick()
            chunk = handle.read(min(1024**2, remaining))
            if not chunk:
                raise HostError('FILE_TRUNCATED')
            remaining -= len(chunk)
            result.update(chunk)
        if handle.read(1):
            raise HostError('FILE_GREW')
    if history.identity(path) != before:
        raise HostError('FILE_CHANGED')
    return result.hexdigest()


def closed_identity(path, roots):
    path = history.regular(path, roots)
    if any(Path(str(path) + suffix).exists() for suffix in ('-wal', '-shm', '-journal')):
        raise HostError('RECOVERY_OR_SOURCE_SIDECAR')
    return history.database_identity(path)


def verified_state(path, roots, budget):
    """Independent exact-byte/integrity/schema/non-article-row verification.

    Raw account/configuration values exist only during hashing, never in reports.
    Schema and row multiplicities must fit in ONE retained point, not a lossy
    union assembled from incompatible states. No real DB is copied.
    """
    fp = closed_identity(path, roots)
    path = Path(fp['main']['path'])
    sha = file_sha(path, budget)
    budget.charge(fp['main']['size'])  # reserve a full integrity-check pass
    tables = {}
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True, isolation_level=None)) as db:
        db.execute('PRAGMA query_only=ON')
        db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 32 * 1024**2)
        db.set_progress_handler(lambda: int(time.monotonic() > budget.deadline), 1000)
        if db.execute('PRAGMA integrity_check').fetchmany(2) != [('ok',)]:
            raise HostError('SQLITE_INTEGRITY_FAILED')
        schema = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').fetchall()
        budget.charge(len(history.canonical(schema)))
        for kind, name, _, _ in schema:
            if kind != 'table' or name == 'articles':
                continue
            if len(tables) >= 128:
                raise HostError('TABLE_COUNT_LIMIT')
            escaped = name.replace('"', '""')
            cursor = db.execute('SELECT * FROM "' + escaped + '"')
            rows = Counter()
            count = 0
            for row in cursor:
                count += 1
                if count > 100000:
                    raise HostError('STATE_ROW_LIMIT')
                raw = history.canonical([history.encode(value) for value in row])
                budget.charge(len(raw))
                rows[history.digest(raw)] += 1
            cursor.close()
            tables[name] = rows
    if closed_identity(path, roots) != fp:
        raise HostError('DATABASE_CHANGED_DURING_STATE_CHECK')
    return {'identity': fp, 'sha256': sha, 'schemaSha256': history.digest(history.canonical(schema)),
            'tables': tables}


def state_covers(point, source):
    return (point['schemaSha256'] == source['schemaSha256'] and
            all(name in point['tables'] and all(point['tables'][name][row] >= count for row, count in rows.items())
                for name, rows in source['tables'].items()))


class ActiveReferences:
    """Process-local registrations. Private owner IPC is the only remote writer.

    The owning service registers queued restore/export/migration paths BEFORE
    use. Disk reference records supplement these pins; they never clear them.
    """
    def __init__(self):
        self.lock = threading.RLock()
        self.generation = 0
        self.pins = {}
        self.runtime_paths = None

    def sync_runtime(self, value):
        if value.get('format') != 'wewe-history-runtime-v1' or value.get('scope') != 'sqlite-coordinator-held':
            raise HostError('LIVE_RUNTIME_SCOPE_REQUIRED')
        paths = value.get('paths')
        if not isinstance(paths, list) or len(paths) > 64:
            raise HostError('RUNTIME_REFERENCE_LIMIT')
        resolved = sorted({str(history.regular(p)) for p in paths})
        with self.lock:
            if self.runtime_paths != resolved:
                self.runtime_paths = resolved
                self.generation += 1

    def pin(self, token, path):
        if not re.fullmatch('[a-zA-Z0-9_-]{1,64}', token):
            raise HostError('INVALID_REFERENCE_TOKEN')
        with self.lock:
            if token in self.pins:
                raise HostError('REFERENCE_TOKEN_ALREADY_PINNED')
            self.pins[token] = str(history.regular(path))
            self.generation += 1

    def unpin(self, token):
        with self.lock:
            if token not in self.pins:
                raise HostError('REFERENCE_TOKEN_UNKNOWN')
            del self.pins[token]
            self.generation += 1

    def snapshot(self):
        with self.lock:
            return {'generation': self.generation, 'pins': dict(self.pins), 'runtimePaths': self.runtime_paths}


def reference_snapshot(files, registry, budget, roots=()):
    if not files or len(files) > 32:
        raise HostError('EXPLICIT_REFERENCE_CATALOG_REQUIRED')
    runtime = registry.snapshot()
    if runtime['runtimePaths'] is None:
        raise HostError('LIVE_RUNTIME_REFERENCES_NOT_CONNECTED')
    records, targets = [], list(runtime['pins'].values()) + runtime['runtimePaths']
    # Include newly-created root-level owner/latest/protection JSON; a static
    # filename list must not miss a new generation published during the review.
    inventory = []
    found = {Path(file) for file in files}
    for root in sorted({Path(file).parent for file in files} | {Path(r) for r in roots}):
        entries = list(root.iterdir())
        if len(entries) > 512:
            raise HostError('REFERENCE_DIRECTORY_LIMIT')
        if any(e.name in {'.space-budget.lock', '.backup.lock'} for e in entries):
            raise HostError('REFERENCE_MAINTENANCE_ACTIVE')
        names = sorted(e.name for e in entries if e.suffix == '.json' and e.is_file())
        inventory.append({'root': str(root.resolve()), 'jsonFiles': names})
        found.update(root / name for name in names)
    files = sorted(found)
    if len(files) > 64:
        raise HostError('REFERENCE_CATALOG_LIMIT')

    def paths(value, base):
        if isinstance(value, str):
            if value.startswith('file:'):
                parsed = urlsplit(value)
                if parsed.netloc:
                    raise HostError('NETWORK_REFERENCE_UNPROVED')
                value = unquote(parsed.path)
                if os.name == 'nt' and re.match(r'^/[A-Za-z]:/', value):
                    value = value[1:]
            if value.startswith(('\\\\', '//')):
                raise HostError('NETWORK_REFERENCE_UNPROVED')
            candidate = Path(value)
            if not candidate.is_absolute():
                candidate = base / candidate
            # Directory references protect their complete subtree too.
            if not candidate.exists():
                raise HostError('REFERENCE_TARGET_MISSING')
            for part in [candidate, *candidate.parents]:
                if part.is_symlink() or getattr(part.lstat(), 'st_file_attributes', 0) & 0x400:
                    raise HostError('REFERENCE_REPARSE_POINT')
            targets.append(str(candidate.resolve()))
        else:
            raise HostError('REFERENCE_PATH_NOT_STRING')

    for file in files:
        file = history.regular(file)
        raw = history.read_file(file, budget, 128 * 1024)
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise HostError('REFERENCE_RECORD_NOT_OBJECT')
        if value.get('format') == 1 and file.name == 'active.json':
            if set(value) != {'format', 'id'} or not re.fullmatch('[A-Za-z0-9T.Z-]+', value.get('id', '')):
                raise HostError('ACTIVE_RELEASE_POINTER_INVALID')
            release = file.parent / value['id']
            paths(str(release), file.parent)
            release_manifest = history.regular(release / 'release.json')
            release_raw = history.read_file(release_manifest, budget, 128 * 1024)
            if json.loads(release_raw).get('id') != value['id']:
                raise HostError('ACTIVE_RELEASE_MANIFEST_MISMATCH')
            records.append({'identity': history.identity(release_manifest), 'sha256': history.digest(release_raw)})
        elif value.get('format') in {'article-history-references-v1', 'sqlite-retention-protected-v1'}:
            if set(value) != {'format', 'paths'} or not isinstance(value.get('paths'), list) or len(value['paths']) > 256:
                raise HostError('REFERENCE_CATALOG_INVALID')
            for target in value['paths']:
                paths(target, file.parent)
        elif file.name.startswith(('snapshot-owner-', 'refresh-recovery-owner-', '.latest-')):
            if not isinstance(value.get('backup'), str):
                raise HostError('OWNER_REFERENCE_INVALID')
            paths(value['backup'], file.parent)
        elif file.name == 'release.json' and value.get('id') == file.parent.name:
            paths(str(file.parent), file.parent)
        elif file.name == 'verification.json':
            origin = value.get('recoveryOrigin', {})
            if origin.get('format') != 'sqlite-recovery-origin-v1' or origin.get('kind') not in {'periodic', 'write-before', 'protected'}:
                raise HostError('RECOVERY_ORIGIN_UNKNOWN')
            target = history.regular(value.get('backup', ''))
            if target.parent != file.parent:
                raise HostError('RECOVERY_RECEIPT_SCOPE_CHANGED')
            if origin['kind'] == 'protected':
                paths(str(target), file.parent)
        else:
            raise HostError('REFERENCE_FORMAT_UNSUPPORTED')
        records.append({'identity': history.identity(file), 'sha256': history.digest(raw)})
    snapshot = {'runtime': registry.snapshot(), 'records': records, 'targets': sorted(set(targets)), 'catalogInventory': inventory}
    snapshot['sha256'] = history.digest(history.canonical(snapshot))
    return snapshot


def resource_probe(paths):
    """Fresh OS query. No caller-supplied occupancy JSON is accepted."""
    if os.name != 'nt':
        # No claim of complete cross-user /proc visibility. Unsupported => hold.
        return {'querySucceeded': False, 'reason': 'RESOURCE_PROBE_UNSUPPORTED', 'files': []}
    script = Path(__file__).with_name('article-history-resources.ps1')
    request = json.dumps([str(p) for p in paths])
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(script)],
                            input=request, text=True, encoding='utf-8', capture_output=True, timeout=40,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode or len(result.stdout) > 65536:
        raise HostError('RESOURCE_PROBE_FAILED')
    report = json.loads(result.stdout)
    if report.get('querySucceeded') is not True or sorted(x['path'] for x in report['files']) != sorted(str(p) for p in paths):
        raise HostError('RESOURCE_SCOPE_UNPROVED')
    if not 0 <= time.time() - report.get('checkedAtEpoch', 0) <= 45:
        raise HostError('RESOURCE_REPORT_STALE')
    return report


class HistoryReviewHost:
    def __init__(self, owner, config, registry=None):
        # owner is the ACTUAL existing in-process SnapshotGuard, never deserialized.
        self.owner = owner
        self.config = copy.deepcopy(config)
        self.registry = registry if registry is not None else ActiveReferences()
        self.sources = [Path(p).resolve() for p in config['sourceRoots']]
        self.recoveries = [Path(p).resolve() for p in config['recoveryRoots']]
        self.archive_root = Path(config['archiveRoot']).resolve()
        if not self.sources or not self.recoveries or any(self.archive_root.is_relative_to(p) for p in self.sources + self.recoveries):
            raise HostError('INVALID_HOST_ROOTS')
        self.previous = history.regular(config['previous'], self.recoveries)
        self.references = [history.regular(p) for p in config['referenceFiles']]
        if not self.references:
            raise HostError('EXPLICIT_REFERENCE_CATALOG_REQUIRED')
        self.issued = {}  # approval validation only accepts plans issued by THIS owner

    def owner_proof(self):
        owner = self.owner
        owner.lock.check()
        health = owner.query()
        if health.get('lease'):
            owner.leases.pop(health['lease']['token'], None)
        if not health.get('verified') or not health.get('fresh') or not owner.record:
            raise HostError('TRUSTED_OWNER_NOT_FRESH')
        version = owner.check_record()
        if owner.record.get('dirty') or version != owner.record.get('unchangedVersion'):
            raise HostError('OWNER_SOURCE_HAS_UNSNAPSHOTTED_WRITES')
        record = owner.record
        return {'generation': record['generation'], 'snapshotGeneration': record['snapshotGeneration'],
                'sourceIdentity': history.database_identity(owner.database),
                'backup': record['backup'], 'sha256': record['sha256'],
                'sourceVersion': version, 'ownerIdentity': history.database_identity(record['backup'])}

    def review(self, sources):
        if not isinstance(sources, list) or not 1 <= len(sources) <= 16:
            raise HostError('SOURCE_BATCH_LIMIT')
        budget = Limit(self.config.get('maxReadBytes', 256 * 1024**2), self.config.get('seconds', 240))
        sources = [history.regular(p, self.sources) for p in sources]
        catalog_roots = self.sources + self.recoveries + [p.parent for p in sources]
        # Same serialized owner request thread, plus lock against local pin changes.
        with self.registry.lock:
            owner = self.owner_proof()
            refs = reference_snapshot(self.references, self.registry, budget, catalog_roots)
            owner_state = verified_state(owner['backup'], self.recoveries, budget)
            previous_state = verified_state(self.previous, self.recoveries, budget)
            if owner_state['sha256'] != owner['sha256'] or physical(owner_state['identity']) == physical(previous_state['identity']):
                raise HostError('RECOVERY_PAIR_UNPROVED')
            points = [('owner', owner_state), ('previous', previous_state)]
            protected = [Path(p) for p in refs['targets']] + [self.owner.database, Path(owner['backup']), self.previous]
            for source in sources:
                if any(source == path or source.is_relative_to(path) or (path.is_file() and source.samefile(path)) for path in protected):
                    raise HostError('ACTIVE_OR_PROTECTED_REFERENCE')
                if re.search('identity|migration|rollback|release|deploy|manual|protected', source.parent.name, re.I):
                    raise HostError('RECOVERY_BOUNDARY_NAME')
            states = [verified_state(source, self.sources, budget) for source in sources]
            covered = []
            for source in states:
                match = next((role for role, point in points if state_covers(point, source)), None)
                if match is None:
                    raise HostError('NON_ARTICLE_STATE_UNCOVERED')
                covered.append({'identity': source['identity'], 'sha256': source['sha256'], 'coveredBy': match,
                                'schemaSha256': source['schemaSha256'],
                                'stateDigest': history.digest(history.canonical({k: dict(v) for k, v in source['tables'].items()}))})
            # The archive chooses its output, not an untrusted IPC request.
            archive = self.archive_root / ('history-' + uuid.uuid4().hex)
            prepared = history.prepareArchive(sources, owner['backup'], archive, source_roots=self.sources,
                                              media_roots=self.config.get('mediaRoots', ()),
                                              max_bytes=self.config.get('archiveBytes', 128 * 1024**2))
            receipts = [{'role': role, 'identity': point['identity'],
                         'verificationSha256': history.digest(history.canonical({k: v for k, v in point.items() if k != 'tables'}))}
                        for role, point in points]
            state_receipt = {'manifestSha256': prepared['manifestSha256'],
                             'verificationSha256': history.digest(history.canonical(covered))}
            plan = history.planRetirements(archive, protections=receipts, non_article_coverage=state_receipt)
            budget.tick()
            final_refs = reference_snapshot(self.references, self.registry, budget, catalog_roots)
            if self.owner_proof() != owner or final_refs != refs:
                raise HostError('OWNER_OR_ACTIVE_REFERENCES_CHANGED')
            resources = resource_probe(sources + [Path(owner['backup']), self.previous])
            if resources.get('querySucceeded') is not True or any(x.get('users') != [] for x in resources.get('files', [])):
                plan['heldReasons'].append('RESOURCE_OCCUPANCY_UNPROVED_OR_BUSY')
                plan['eligible'] = []
            for state in [owner_state, previous_state, *states]:
                if closed_identity(state['identity']['main']['path'], self.sources + self.recoveries) != state['identity']:
                    raise HostError('FILE_CHANGED_BEFORE_HOST_PUBLICATION')
                if file_sha(state['identity']['main']['path'], budget) != state['sha256']:
                    raise HostError('FILE_BYTES_CHANGED_BEFORE_HOST_PUBLICATION')
            if history.load_manifest(archive)[2] != prepared['manifestSha256']:
                raise HostError('ARCHIVE_CHANGED_BEFORE_HOST_PUBLICATION')
            if resources.get('querySucceeded') and not 0 <= time.time() - resources.get('checkedAtEpoch', 0) <= 45:
                raise HostError('RESOURCE_QUERY_EXPIRED')
            if reference_snapshot(self.references, self.registry, budget, catalog_roots) != refs or self.owner_proof() != owner:
                raise HostError('REFERENCES_CHANGED_BEFORE_HOST_PUBLICATION')
            entries = {physical(state['identity']): state for state in states}
            for entry in plan['eligible']:
                entry['sha256'] = entries[physical(entry['identity'])]['sha256']
            plan.pop('batchSha256')
            now = int(time.time())
            plan.update(hostFormat='article-history-host-v1', createdAtEpoch=now, expiresAtEpoch=now + 300,
                        owner=owner, referenceDigest=refs['sha256'], referenceSnapshot=refs,
                        sourceStateCoverage=covered, resources=resources, permanentDeletionPerformed=False)
            plan = wire(plan)
            plan['batchSha256'] = history.digest(history.canonical(plan))
            encoded = history.canonical(plan)
            if len(encoded) > 256 * 1024:
                raise HostError('REVIEW_OUTPUT_LIMIT')
            self.issued = {plan['batchSha256']: encoded}  # previous local review expires
            return plan

    def validate_approval(self, plan, approval):
        """No executor: exact approval + full fresh re-review, then handle recheck required."""
        raw = history.canonical(plan)
        sha = plan.get('batchSha256')
        if self.issued.get(sha) != raw:
            raise HostError('PLAN_NOT_ISSUED_BY_THIS_OWNER')
        now = int(time.time())
        expected_paths = sorted(e['identity']['main']['path'] for e in plan['eligible'])
        if (not expected_paths or approval.get('batchSha256') != sha or
                approval.get('action') != 'permanent-delete-exact-files' or
                sorted(approval.get('paths', [])) != expected_paths or
                not isinstance(approval.get('approvedAtEpoch'), int) or
                not plan['createdAtEpoch'] <= approval['approvedAtEpoch'] <= now <= plan['expiresAtEpoch']):
            raise HostError('EXACT_FRESH_BATCH_APPROVAL_REQUIRED')
        budget = Limit(self.config.get('maxReadBytes', 256 * 1024**2), self.config.get('seconds', 240))
        catalog_roots = self.sources + self.recoveries + [Path(entry['identity']['main']['path']).parent for entry in plan['sourceStateCoverage']]
        with self.registry.lock:
            if wire(self.owner_proof()) != plan['owner'] or reference_snapshot(self.references, self.registry, budget, catalog_roots)['sha256'] != plan['referenceDigest']:
                raise HostError('APPROVED_REFERENCES_CHANGED')
            check = history.verifyCoverage(plan['archive'])
            if not check['verified'] or check['manifestSha256'] != plan['manifestSha256']:
                raise HostError('APPROVED_ARCHIVE_CHANGED')
            for entry in plan['eligible']:
                path = entry['identity']['main']['path']
                if wire(closed_identity(path, self.sources)) != entry['identity'] or file_sha(path, budget) != entry['sha256']:
                    raise HostError('APPROVED_SOURCE_CHANGED')
            # Independently recheck actual retained bytes/integrity, not receipt shape.
            for receipt in plan['protections']:
                point = verified_state(receipt['identity']['main']['path'], self.recoveries, budget)
                proof = history.digest(history.canonical({k: v for k, v in point.items() if k != 'tables'}))
                if wire(point['identity']) != receipt['identity'] or proof != receipt['verificationSha256']:
                    raise HostError('APPROVED_RECOVERY_CHANGED')
            resources = resource_probe([Path(p) for p in expected_paths] + [Path(x['identity']['main']['path']) for x in plan['protections']])
            if resources.get('querySucceeded') is not True or any(x.get('users') != [] for x in resources.get('files', [])):
                raise HostError('APPROVED_RESOURCE_CHECK_FAILED')
            if wire(self.owner_proof()) != plan['owner'] or reference_snapshot(self.references, self.registry, budget, catalog_roots)['sha256'] != plan['referenceDigest']:
                raise HostError('APPROVED_REFERENCES_CHANGED')
            for entry in [*plan['eligible'], *plan['protections']]:
                if wire(closed_identity(entry['identity']['main']['path'], self.sources + self.recoveries)) != entry['identity']:
                    raise HostError('APPROVED_FILE_CHANGED_AT_FINAL_CHECK')
            if history.load_manifest(plan['archive'])[2] != plan['manifestSha256'] or time.time() > plan['expiresAtEpoch']:
                raise HostError('APPROVED_ARCHIVE_CHANGED_OR_EXPIRED')
            if wire(self.owner_proof()) != plan['owner'] or reference_snapshot(self.references, self.registry, budget, catalog_roots)['sha256'] != plan['referenceDigest']:
                raise HostError('APPROVED_REFERENCES_CHANGED')
            if time.time() > plan['expiresAtEpoch'] or not 0 <= time.time() - resources.get('checkedAtEpoch', 0) <= 45:
                raise HostError('APPROVAL_OR_RESOURCE_EXPIRED_AT_FINAL_CHECK')
        return {'batchSha256': sha, 'approvedForReview': True, 'permanentDeletionPerformed': False,
                'executorMustRecheckVerifiedHandles': True, 'executable': False}


def from_environment(owner):
    """Trusted process configuration only; IPC cannot choose roots or receipts."""
    if os.environ.get('SQLITE_ARTICLE_HISTORY_REVIEW_ENABLED') != '1':
        raise HostError('HISTORY_REVIEW_DISABLED')
    if os.environ.get('SQLITE_ARTICLE_HISTORY_MAINTENANCE_WINDOW') != '1':
        raise HostError('EXPLICIT_MAINTENANCE_WINDOW_REQUIRED')
    raw = os.environ.get('SQLITE_ARTICLE_HISTORY_HOST_CONFIG', '')
    if len(raw) > 8192:
        raise HostError('HOST_CONFIG_LIMIT')
    return HistoryReviewHost(owner, json.loads(raw))
