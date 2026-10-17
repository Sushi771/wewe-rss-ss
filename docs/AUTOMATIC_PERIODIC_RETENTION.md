# Automatic periodic snapshot retention (development candidate)

This opt-in change runs software cleanup after the actual snapshot owner has independently verified a new full recovery point. It reuses the existing Windows retention executor and exact file handles. It does not enable deletion, change a running configuration, deploy, or perform the separately owned historical cleanup.

The source baseline is PR48 `24ac842b84d9db7fa507a971b84ea63a1ed98249`, including its article-history review support. Ordinary PR48 recent collection and cached imports use incremental transactions and durable receipts, independently of periodic snapshot availability. Protected deletion, source replacement and upgrades retain their verified backup requirements. The unused legacy insert-only helper is unchanged.

## Policy proposed for approval

| Setting                                   | Default  | Finite bounds                              |
| ----------------------------------------- | -------- | ------------------------------------------ |
| `SQLITE_PERIODIC_RETENTION_ENABLED`       | disabled | only `1` enables automatic retirement      |
| `SQLITE_PERIODIC_RETENTION_COPIES`        | 4        | 2–16                                       |
| `SQLITE_PERIODIC_RETENTION_BYTES`         | 4 GiB    | 1 byte–32 GiB; a soft target               |
| `SQLITE_PERIODIC_RETENTION_RESERVE_BYTES` | 2 GiB    | 2 MiB–8 GiB, one staging allocation        |
| `SQLITE_PERIODIC_RETENTION_READ_BYTES`    | 8 GiB    | 1 byte–16 GiB, 20-second rotation deadline |

At least two distinct verified recovery files remain before any deletion. Recent points under one hour and a daily representative are retained, so necessary windows can exceed the four-copy target. Each pass considers at most eight eligible points and reserves read budget for the irreversible step before attempting another proof. Unique historical state, protection references, unsupported publishers and unknown artifacts can also keep usage above the target. A target is never permission to discard them.

The existing global defaults remain 48 database files, 32 GiB of managed storage and 4 GiB free space. All declared historical physical roots and failed files still count. A source too large for the proposed staging allowance is refused; increasing that allowance requires a deliberate bounded policy choice.

## One verified replacement, then covered old points

1. The real owner creates or independently revalidates a snapshot through the existing full-snapshot OS lock and verification code.
2. The fixed `.space-budget.lock` is exclusively created and fsynced before a new physical copy. Its actual opened-file identity is passed only in memory to the same owner invocation. A saved report, matching PID, edited marker, or a new owner cannot adopt this staging allocation.
3. If ordinary preflight is already over quota, exactly one staging copy may proceed within its explicit byte reserve while preserving minimum free space. The online SQLite API checks source pages before copying and on each bounded progress step; 1 MiB of the reserve covers the bounded page-step overshoot and control overhead. Growth beyond the data allowance aborts. Protected-operation backups cannot borrow this periodic allowance.
4. After the new point verifies, the same owner reacquires the existing publisher lock. The current protection manifests must already exist, and all supported references and ancestor directories are pinned. Article-history maintenance windows hold automatic retirement. No machine-wide resource scan runs.
5. Before selecting any old point, another retained same-source recovery file passes actual hash, integrity and schema checks. For each old periodic candidate, native read pins bind both proof files. Schema must match and every old typed durable row must survive unchanged in the new snapshot; new rows may be added. Only the explicit feed summary columns `sync_time`, `update_time`, `updated_at`, `has_history`, `last_collection_result` and `provider_refresh_attempt_time` are excluded. Every article field, note, metric, account/group value and unknown table/column is protected. Unprovable nullable duplicate keys, unsupported row identities and oversized proofs hold the point.
6. The shared native deletion helper exclusively pins and rehashes all selected data/receipt files and both recovery files before its first delete. It checks for SQLite sidecars after exclusive data acquisition. It deletes only those verified handles, their exact verification receipts and their now-empty managed periodic directories. It does not recurse, delete a source DB, or fall back to pathname deletion. Protected-origin and historical/unknown backups cannot enter this executable scope.
7. Only a completed pass that restores the original stored-data limits may remove its unchanged staging marker under the publisher lock. An 8 KiB control-file margin is retained before the final owner status publication. Otherwise the same marker remains, preventing repeated overflow copies. A failed or interrupted copy/deletion never automatically resets the marker or retries by another name.

A cleanup refusal does not invalidate the newly verified point. Its safe status records `held` and a bounded reason/count summary. A later changed source may lose periodic freshness while that marker is held; ordinary incremental ingestion still does not depend on the marker. Required protected operations can remain refused until recovery storage is resolved. This change does not claim to preserve historical process identity, repair release-authority replacement windows, or exclude unsupported third-party publishers.

## Historical layout registration and diagnostics

An unlisted link remains a distinct layout refusal before the capacity gate. `--preview-layout` on the existing retention planner emits only a metadata proposal: it does not follow historical targets, inventory their data, write registration, raise limits or authorize deletion. Aliases are deduplicated to exact physical directory identities.

The optional `SQLITE_PRODUCTION_LEGACY_ROOTS_FILE` accepts a local, bounded (256 KiB), confirmed `sqlite-legacy-roots-v1` document binding the managed root identity and at most 256 exact physical roots. Its opened identity/hash is checked and it becomes a pinned reference during rotation. Simultaneous nonempty legacy-list configuration is refused. New links to unregistered children still fail. Existing list configuration remains compatible; no production registration was created here.

Python and Node distinguish safe layout, storage, copy and rotation failures. Node strips raw errors, paths, SQL and argv. A cleanup hold is reported separately from snapshot failure and repeated equal status is coalesced. The diagnostic can identify the current gate; it cannot reconstruct historical discarded raw errors.

## Validation and release boundary

Tests use small owned synthetic databases, actual SQLite online backup and Windows exact file handles. They cover repeated append/derived-summary rotation, original data preservation, unique body/note/metric/unknown state, protected references, active readers, late reference publication, copy failure, growth during copy, interruption immediately after an exact delete, marker replacement and restart replay refusal. Existing manual rotation and protection regressions remain required.

The delivery report records exact local results, retained failed attempts and head-specific CI. Failed dependency/permission setup runs are not successes. No full production DB or dependency tree is copied, and no private inventory or business content is uploaded.

Before production activation, the production owner must approve the exact candidate SHA, these retention/staging settings, exact physical-root registration, preexisting recovery protections and any actual historical cleanup. The current historical batch remains under its separately authorized production window. This candidate neither performs that cleanup nor automatically enables a running service.
