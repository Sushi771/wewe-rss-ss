"""Local-only snapshot owner. Never loads a disk receipt as authority."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import sqlite3
import sys
import threading
import time
import uuid
from contextlib import closing

spec = importlib.util.spec_from_file_location(
    "verified_backup", Path(__file__).with_name("backup-sqlite.py")
)
backup_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup_module)


def identity(path):
    stat = path.stat()
    if not stat.st_ino:
        raise ValueError("unprovable-file-identity")
    return [str(stat.st_dev), str(stat.st_ino)]


def fingerprint(path):
    stat = path.stat()
    return [*identity(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]


OwnerLock = backup_module.FileLock


class SnapshotGuard:
    def __init__(self, database, backup_root, interval=900, max_age=900,
                 wall=time.time, monotonic=time.monotonic,
                 backup=backup_module.create_backup):
        self.database = Path(database).resolve(strict=True)
        if str(self.database).startswith("\\\\"):
            raise ValueError("network-database-unsupported")
        self.backup_root = Path(backup_root).resolve()
        self.backup_root.mkdir(parents=True, exist_ok=True)
        # Outside the backup directories; aliases of the same canonical path agree.
        lock_name = hashlib.sha256(str(self.database).encode()).hexdigest()[:24]
        self.lock = OwnerLock(self.database.parent / f".snapshot-{lock_name}.lock")
        try:
            self.source_identity = identity(self.database)
            self.source = sqlite3.connect(
                self.database.as_uri() + "?mode=ro", uri=True, timeout=0.1
            )
            self.source.execute("PRAGMA query_only=ON")
        except BaseException:
            self.lock.close()
            raise
        self.interval, self.max_age = interval, max_age
        self.wall, self.monotonic, self.backup = wall, monotonic, backup
        self.generation = uuid.uuid4().hex
        self.receipt = self.backup_root / f"snapshot-owner-{lock_name}.json"
        self.record = None
        self.reason = "startup-backup-required"
        self.fatal = False
        self.leases = {}
        self.last_wall, self.last_mono = wall(), monotonic()
        self.next_check = self.last_mono

    def close(self):
        self.source.close()
        self.lock.close()

    def invalidate(self, reason, fatal=False):
        self.reason = reason
        self.record = None
        self.leases.clear()
        self.fatal = self.fatal or fatal

    def clock(self):
        wall, mono = self.wall(), self.monotonic()
        # Backwards wall time OR backwards monotonic time invalidates all leases.
        # A frozen/slow wall clock cannot lengthen a monotonic lease either.
        if wall < self.last_wall or mono < self.last_mono:
            self.invalidate("clock-rollback", fatal=True)
            raise ValueError("clock-rollback")
        self.last_wall, self.last_mono = wall, mono
        return wall, mono

    def database_state(self):
        self.lock.check()
        if identity(self.database) != self.source_identity:
            raise ValueError("database-replaced")
        version = self.source.execute("PRAGMA data_version").fetchone()[0]
        schema = self.source.execute("PRAGMA schema_version").fetchone()[0]
        rows = list(self.source.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name"
        ))
        schema_hash = hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        return version, schema, schema_hash

    def persist(self):
        # Compare future reads to bytes held in memory, never to values supplied
        # by JSON. Deleting/editing/truncating this diagnostic disables fast mode.
        self.receipt_bytes = (json.dumps(self.record, sort_keys=True) + "\n").encode()
        temporary = self.receipt.with_name(self.receipt.name + "." + self.generation)
        with temporary.open("wb") as stream:
            stream.write(self.receipt_bytes)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.receipt)

    def check_record(self):
        if self.receipt.read_bytes() != self.receipt_bytes:
            raise ValueError("guard-record-corrupt")
        backup = Path(self.record["backup"])
        if fingerprint(backup) != self.record["backupFingerprint"]:
            raise ValueError("snapshot-file-changed")
        version, schema, schema_hash = self.database_state()
        if (schema, schema_hash) != (self.record["schemaVersion"],
                                    self.record["schemaSha256"]):
            raise ValueError("database-schema-changed")
        return version

    def tick(self):
        """Serialized startup/periodic work. No backup in query/validate/dirty."""
        try:
            wall, mono = self.clock()
            self.next_check = mono + self.interval
            if self.fatal:
                return
            before, schema, schema_hash = self.database_state()
            if self.record:
                self.check_record()
                if (before == self.record["unchangedVersion"]
                        and not self.record["dirty"]):
                    # Rehash existing verified backup periodically. Full integrity
                    # was performed on creation; its exact bytes must still match.
                    if backup_module.sha256(Path(self.record["backup"])) != self.record["sha256"]:
                        raise ValueError("snapshot-checksum-failed")
                    after, after_schema, after_hash = self.database_state()
                    if (before, schema, schema_hash) == (after, after_schema, after_hash):
                        # Use tick START, before the version observation. A write
                        # can commit immediately after the last read; never claim
                        # the later time as a proven unchanged boundary.
                        self.record["coverageAtMs"] = int(wall * 1000)
                        self.record["coverageMono"] = mono
                        self.persist()
                        return
            # Invalidate before any IO: failure cannot leave a previously usable
            # record active. Backup API handles ordinary concurrent source writes.
            self.invalidate("snapshot-in-progress")
            start_wall, start_mono = self.clock()
            report = self.backup(self.database, self.backup_root, prefix="periodic-snapshot")
            completed_wall, completed_mono = self.clock()
            after, after_schema, after_hash = self.database_state()
            backup = Path(report["backup"]).resolve(strict=True)
            if (report["source"] != str(self.database)
                    or report["integrityCheck"] != "ok"
                    or not backup.is_relative_to(self.backup_root)
                    or backup_module.sha256(backup) != report["sha256"]):
                raise ValueError("snapshot-verification-failed")
            # Re-read integrity/schema from the exact saved bytes, independent of
            # a returned report. Never assume the schema remained stable in flight.
            with closing(sqlite3.connect(backup.as_uri() + "?mode=ro", uri=True)) as verify:
                if list(verify.execute("PRAGMA integrity_check")) != [("ok",)]:
                    raise ValueError("snapshot-integrity-failed")
                saved_rows = list(verify.execute(
                    "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name"
                ))
            saved_hash = hashlib.sha256(json.dumps(saved_rows, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
            # The backup API may change the destination schema cookie to expire
            # destination prepared statements. Compare actual schema definitions;
            # leases continue to bind to the SOURCE cookie and schema hash.
            if saved_hash != after_hash:
                raise ValueError("snapshot-schema-mismatch")
            completed_wall, completed_mono = self.clock()
            self.record = {
                "generation": self.generation, "snapshotGeneration": uuid.uuid4().hex,
                "databasePath": str(self.database), "databaseIdentity": self.source_identity,
                "schemaVersion": after_schema, "schemaSha256": after_hash,
                "backup": str(backup), "sha256": report["sha256"],
                "backupFingerprint": fingerprint(backup),
                "backupStartedAtMs": int(start_wall * 1000),
                "backupSucceededAtMs": int(completed_wall * 1000),
                "backupStartedMono": start_mono, "backupSucceededMono": completed_mono,
                "coverageAtMs": int(start_wall * 1000), "coverageMono": start_mono,
                "unchangedVersion": after if before == after else None,
                "dirty": before != after,
            }
            self.persist()
            self.reason = None
        except Exception as error:
            reason = str(error)
            safe = reason if reason in {
                "clock-rollback", "database-replaced", "owner-lock-replaced",
                "database-schema-changed", "guard-record-corrupt",
                "snapshot-file-changed", "snapshot-checksum-failed",
                "snapshot-verification-failed", "snapshot-integrity-failed",
                "snapshot-schema-mismatch",
            } else "snapshot-io-or-verification-failed"
            self.invalidate(safe, fatal=safe in {"database-replaced", "owner-lock-replaced"})

    def query(self):
        try:
            wall, mono = self.clock()
            if not self.record:
                return {"verified": False, "fresh": False, "reason": self.reason}
            self.check_record()
            age = max(wall - self.record["coverageAtMs"] / 1000,
                      mono - self.record["coverageMono"])
            if age >= self.max_age:
                # Do not erase the version proof; the periodic tick may still
                # renew an unchanged snapshot, but this query must fall back.
                return {"verified": True, "fresh": False, "reason": "snapshot-expired"}
            self.leases = {key: value for key, value in self.leases.items()
                           if value[0] > mono and value[1] > wall}
            token = uuid.uuid4().hex
            seconds = min(5, self.max_age - age)
            self.leases[token] = (mono + seconds, wall + seconds,
                                  self.record["snapshotGeneration"])
            lease = {key: self.record[key] for key in (
                "generation", "snapshotGeneration", "databasePath", "databaseIdentity",
                "schemaVersion", "schemaSha256", "backupStartedAtMs",
                "backupSucceededAtMs", "coverageAtMs"
            )}
            lease.update(token=token, validUntilMs=int((wall + seconds) * 1000),
                         snapshotSha256=self.record["sha256"],
                         elapsedSinceBackupSuccessMs=int(max(0, wall * 1000 - self.record["backupSucceededAtMs"],
                             (mono - self.record["backupSucceededMono"]) * 1000)),
                         conservativeRecoveryWindowMs=int(max(0, wall * 1000 - self.record["backupStartedAtMs"],
                             (mono - self.record["backupStartedMono"]) * 1000)))
            return {"verified": True, "fresh": True, "lease": lease}
        except Exception:
            self.invalidate("guard-health-check-failed")
            return {"verified": False, "fresh": False, "reason": self.reason}

    def validate(self, token):
        existing = self.leases.get(token)
        health = self.query()
        # query creates a fresh token: discard it; validation must never renew
        # or lengthen the transaction's original lease.
        if health.get("lease"):
            self.leases.pop(health["lease"]["token"], None)
        wall, mono = self.last_wall, self.last_mono
        if (not existing or not health.get("fresh") or existing[0] <= mono
                or existing[1] <= wall
                or existing[2] != self.record["snapshotGeneration"]):
            return {"verified": False, "fresh": False, "reason": "lease-invalid-or-expired"}
        return {"verified": True, "fresh": True}

    def dirty(self, token):
        # Caller records its batch inside the database transaction. This signal
        # is an optimisation; persistent data_version catches a lost signal.
        if self.record and token in self.leases:
            self.record["dirty"] = True
            try:
                self.persist()
            except Exception:
                self.invalidate("guard-record-write-failed")
        return {"verified": False, "fresh": False, "accepted": bool(self.record)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--backup-root", type=Path, required=True)
    parser.add_argument("--interval-seconds", type=int, default=900)
    parser.add_argument("--max-age-seconds", type=int, default=900)
    args = parser.parse_args()
    if not 60 <= args.interval_seconds <= args.max_age_seconds <= 86400:
        raise SystemExit("invalid snapshot cadence")
    guard = SnapshotGuard(args.database, args.backup_root,
                          args.interval_seconds, args.max_age_seconds)
    requests = queue.Queue()

    def read_requests():
        for line in sys.stdin:
            if len(line) > 8192:
                requests.put(None)
                return
            try:
                requests.put(json.loads(line))
            except ValueError:
                requests.put(None)
                return
        requests.put(None)

    threading.Thread(target=read_requests, daemon=True).start()
    try:
        while True:
            if guard.monotonic() >= guard.next_check:
                guard.tick()
            try:
                request = requests.get(timeout=min(1, max(0, guard.next_check - guard.monotonic())))
            except queue.Empty:
                continue
            if request is None:
                break
            operation = request.get("operation")
            if operation == "query":
                result = guard.query()
            elif operation == "validate":
                result = guard.validate(request.get("token"))
            elif operation == "dirty":
                result = guard.dirty(request.get("token"))
            else:
                result = {"verified": False, "fresh": False, "reason": "unknown-operation"}
            print(json.dumps({"id": request.get("id"), "result": result}), flush=True)
    finally:
        guard.close()


if __name__ == "__main__":
    main()
