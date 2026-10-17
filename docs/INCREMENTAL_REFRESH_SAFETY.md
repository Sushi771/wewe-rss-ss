# Ordinary incremental refresh and recovery

Ordinary Wechat2RSS updates use atomic SQLite transactions and durable remote-attempt receipts. They do not create per-write or per-round full snapshots. Periodic backups retain the configured interval. Upgrades, migrations, source changes and bulk deletion retain their independent verified-backup gate.

## Commit and retry contract

| Boundary                              | Durable evidence                                                                  | Retry behavior                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Prepared, no remote request           | `refresh_submission_claims.prepared` plus feed reservation                        | Reuse the same batch/feed claim after checking the source and reservation            |
| Before HTTP starts                    | Transaction changes prepared to attempted                                         | Only the winning claimant may call the provider                                      |
| Accepted response                     | Claim changes to accepted before the batch JSON receipt                           | Restart repairs local batch status and reads cache; never submits again              |
| Unknown response or crash around HTTP | attempted/unknown stays durable                                                   | Block that item's automatic submission; other sources can continue                   |
| Cache save                            | Articles, feed timing/final result and `cache_refresh_commits` in one transaction | Roll back all on failure; repeated canonical identities use existing CAS/merge rules |

Remote state cannot be proved exactly across a crash between local durable commit and an external server. Conservatively retaining an unknown claim can require manual reconciliation even if no HTTP request actually reached the server. It must never be treated as an automatic retry permission. Receipts remain in SQLite; this change does not prune them or reset unknown history.

Validated responses now have a bounded private proof bridge before the SQL
accepted receipt. Only a matching durable proof can automatically repair that
same unknown claim, without resubmission; absent proof still remains unknown.
See [response reconciliation](REFRESH_RESPONSE_RECONCILIATION.md) for the exact
validation, diagnostics, cleanup and cache/content limits.

Malformed or unreadable historical batch receipts stop new remote submissions until history is reconciled. Valid accepted/cache-only work can still continue. Each wave rechecks history after asynchronous preparation. Provider subscription missing/name-change errors fail only that source; account-wide restrictions keep their shared pause behavior.

Cache writes preserve existing article identities, nonempty user edits, saved inline images, metrics, classifications and publication times. Alternate query-string order is canonicalized. Matching an article owned by another feed or multiple ambiguous matches rejects the whole transaction. A payload receipt is evidence, not permission to skip current row checks or future media repair. Legacy `running` feed status is repaired through a cache-only atomic transaction.

## Space and startup

Ordinary writes check the actual Prisma database path and source volume, then recheck after obtaining write admission and inside the transaction. The finite physical margin defaults to 64 MiB plus the database size and twice the bounded payload size, allowing a rollback journal. `SQLITE_INCREMENTAL_MIN_FREE_BYTES` accepts 1 MiB through 16 GiB. SQLITE_FULL, I/O errors, unsafe durability modes and changed database identity fail the operation without claiming success. A PID-owned local lock serializes ordinary writers across same-host clients; stale ownership recovery does not imply remote retry permission.

Recovery-copy byte/count limits, a disabled periodic owner, a failed periodic backup and a full backup quota do not gate ordinary refresh or routine startup. Routine startup keeps schema/migration validation and a pinned read-only integrity/foreign-key audit; it creates no full recovery copy. SQLite may recover its own hot rollback journal before that audit. This is engine crash recovery, not automatic restoration of an older database. The startup audit still rejects schema or integrity failures.

The periodic owner emits `[SQLITE_PERIODIC_SNAPSHOT_FAILED]` on failure/unavailability and `[SQLITE_PERIODIC_SNAPSHOT_RECOVERED]` on recovery. Alerts do not stop ordinary writes. Its interval configuration is unchanged. A protected high-risk operation still fails before its write if its own required backup cannot be verified or admitted.

## Single and bulk feed deletion

`feed.delete` and `feed.batchDelete` share a protected deletion gate. They freeze the selected feed versions before waiting for exclusive application admission, recheck them after admission, and keep that admission through the independent verified protected backup and the cascading delete transaction. No delete is attempted when backup verification, quota admission or child-exit proof fails. A missing single target is rejected; an empty/nonexistent batch is a no-op. Batches are bounded to 1000 input IDs and duplicate IDs are deleted only once.

The backup must prove the actual Prisma source and carry the protected high-risk marker. The transaction checks actual durability/foreign keys, canonical source path, main/WAL/journal file identity/version and all selected feed fields again before deletion. Concurrent application writes wait outside the engine. An external edit or file replacement during backup rejects the operation; The transaction first acquires SQLite's writer reservation with a zero-row update before reading business rows. This excludes competing external writers and avoids a stale WAL read-to-write upgrade; a change committed before admission is detected by the recheck. A trigger/error while deleting a later target rolls back preceding cascades too. Successful deletion intentionally removes the selected feeds and their articles while retaining nonselected rows, classifications, durable remote claims and the verified recovery point. It does not remove exported files or restore a database automatically.

The route regressions use real SQLite, the actual Prisma admission middleware, a verified tiny backup and external clients. They exercise both backup-failure zero-delete routes, selected-only success, data/identity changes, late SQL failure, queued writers, overlapping deletes, disabled foreign keys, uncertain-child fences and external WAL conflict. Ordinary refresh remains on its separate zero-snapshot path.

## Migration and release review

The additive migration `20261015090000_incremental_refresh_commits` creates two small receipt tables and one index. It does not rewrite business rows. Production upgrade remains a high-risk boundary: the release owner must make and verify an independent protected backup before applying migrations, build the exact reviewed commit, and follow the established controlled release procedure. This development PR does not merge, deploy, restart, change environment configuration or delete real files.

Rollback of application binaries requires reviewing these additive tables and durable unknown/accepted claims. Do not restore an old database or replay old queued JSON blindly: that can lose newer articles and repeat an already accepted remote submission. Preserve the current database and receipts for reconciliation before any explicit restore.

## Verification

`incremental-refresh.spec.ts` uses tiny real Prisma/SQLite databases with a deliberately failing snapshot provider. It exercises zero-copy writes under full quota/disabled owner, late SQL failure, actual SQLITE_FULL, process termination before/after cache commit and around remote submission/receipt persistence, truncated history, legacy final-status repair, source isolation, reservation restoration, source changes and concurrent clients. `incremental-crash-fixture.cjs` invokes the real services with a local counter instead of external HTTP.

Existing manual/scheduled batches, preparation intents, cache preservation, media, high-risk backup, startup and retention tests remain part of the complete CI suite. These are isolated fault tests, not evidence of a production deployment or a real-platform refresh.
