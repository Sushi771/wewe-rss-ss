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

Malformed or unreadable historical batch receipts stop new remote submissions until history is reconciled. Valid accepted/cache-only work can still continue. Each wave rechecks history after asynchronous preparation. Provider subscription missing/name-change errors fail only that source; account-wide restrictions keep their shared pause behavior.

Cache writes preserve existing article identities, nonempty user edits, saved inline images, metrics, classifications and publication times. Alternate query-string order is canonicalized. Matching an article owned by another feed or multiple ambiguous matches rejects the whole transaction. A payload receipt is evidence, not permission to skip current row checks or future media repair. Legacy `running` feed status is repaired through a cache-only atomic transaction.

## Space and startup

Ordinary writes check the actual Prisma database path and source volume, then recheck after obtaining write admission and inside the transaction. The finite physical margin defaults to 64 MiB plus the database size and twice the bounded payload size, allowing a rollback journal. `SQLITE_INCREMENTAL_MIN_FREE_BYTES` accepts 1 MiB through 16 GiB. SQLITE_FULL, I/O errors, unsafe durability modes and changed database identity fail the operation without claiming success. A PID-owned local lock serializes ordinary writers across same-host clients; stale ownership recovery does not imply remote retry permission.

Recovery-copy byte/count limits, a disabled periodic owner, a failed periodic backup and a full backup quota do not gate ordinary refresh or routine startup. Routine startup keeps schema/migration validation and a pinned read-only integrity/foreign-key audit; it creates no full recovery copy. SQLite may recover its own hot rollback journal before that audit. This is engine crash recovery, not automatic restoration of an older database. The startup audit still rejects schema or integrity failures.

The periodic owner emits `[SQLITE_PERIODIC_SNAPSHOT_FAILED]` on failure/unavailability and `[SQLITE_PERIODIC_SNAPSHOT_RECOVERED]` on recovery. Alerts do not stop ordinary writes. Its interval configuration is unchanged. A protected high-risk operation still fails before its write if its own required backup cannot be verified or admitted.

## Migration and release review

The additive migration `20261015090000_incremental_refresh_commits` creates two small receipt tables and one index. It does not rewrite business rows. Production upgrade remains a high-risk boundary: the release owner must make and verify an independent protected backup before applying migrations, build the exact reviewed commit, and follow the established controlled release procedure. This development PR does not merge, deploy, restart, change environment configuration or delete real files.

Rollback of application binaries requires reviewing these additive tables and durable unknown/accepted claims. Do not restore an old database or replay old queued JSON blindly: that can lose newer articles and repeat an already accepted remote submission. Preserve the current database and receipts for reconciliation before any explicit restore.

## Verification

`incremental-refresh.spec.ts` uses tiny real Prisma/SQLite databases with a deliberately failing snapshot provider. It exercises zero-copy writes under full quota/disabled owner, late SQL failure, actual SQLITE_FULL, process termination before/after cache commit and around remote submission/receipt persistence, truncated history, legacy final-status repair, source isolation, reservation restoration, source changes and concurrent clients. `incremental-crash-fixture.cjs` invokes the real services with a local counter instead of external HTTP.

Existing manual/scheduled batches, preparation intents, cache preservation, media, high-risk backup, startup and retention tests remain part of the complete CI suite. These are isolated fault tests, not evidence of a production deployment or a real-platform refresh.
