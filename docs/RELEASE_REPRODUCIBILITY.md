# Release and recovery evidence

## Source and artifact contract

Current releases use one committed tree for application code, migrations, fourteen
server helpers and nine runtime wrappers. The reviewed historical feed-column
normalization and host-write evidence hooks belong in that tree, rather than
being copied from an installed application. The normalization only accepts the
two unconstrained nullable TEXT additions in their known reversed order; type,
default, constraint, trigger, index and migration drift remain rejected.

`build.cjs` records `sourceCommit`, `toolingCommit`, source input hashes and
`provenance`. Current builds declare `composition: single-source`; supported
historical rollback builds explicitly declare their composed provenance.
Runtime/helper UTF-8 text is normalized from CRLF to LF. The manifest records
each copied path, its source path and SHA256, Node version/hash, compiler entry
hashes/versions and Prisma engine identity. Python is an existing external
runtime selected by `SQLITE_BACKUP_PYTHON`; it is not silently bundled or
installed. Startup disables Python bytecode writes inside immutable packages.

This is reproducible source attribution and closure verification, not a claim of
bit-identical build timestamps across different toolchains. Existing installed
dependencies are reused; a rebuild must not install or update dependencies.

## Backup display contract

The existing `backup-space-status.py` report and snapshot-owner stdio status keep
their fields. `periodicLifecycle` / `lifecycle` adds the following finite fields,
also allowlisted by `safePeriodicLifecycleStatus`:

| Field                   | Meaning                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `generationPaused`      | New generation is held unless lifecycle status is ready. Independently proven unchanged copies may still be reused. |
| `generationPauseReason` | `pending-confirmation`, `lifecycle-held`, or null.                                                                  |
| `lastGeneratedAtMs`     | Creation completion from the newest indexed, hash-bound receipt; never status-read time.                            |
| `lastVerifiedAtMs`      | Initial verification from that receipt, or a later successful recheck by the active owner.                          |
| `verificationBasis`     | `creation-receipt`, `current-owner-hash`, or `unknown`.                                                             |
| `coverageAtMs`          | Conservative copy start, or the current owner's independently proven unchanged boundary.                            |
| `coverageBasis`         | `copy-start`, `verified-unchanged`, or `unknown`.                                                                   |

Unknown times are null. Reading indexed metadata does not perform a fresh full
integrity check. Verification time must never replace generation time or imply
that intervening writes are covered. These display fields never authorize a
write, lease, restore or deletion. The existing read-only /startup-status response includes a sanitized periodicBackup snapshot from the latest owner event; no new route is introduced. Owner exit clears the display snapshot. The tools page separates generation, verification, coverage, their bases, and observation time; reading status never starts backup work or acquires a lease.
An owner's later verification updates periodic timestamps only when its backup
path and hash match the indexed periodic point. Reusing another protected point
does not refresh the older periodic point's verification or coverage. This
private identity binding is excluded from public status.

Capacity forecasting adds `capacityAllowsNextBackup`; `nextBackupAllowed` also
accounts for lifecycle holds. Capacity estimates remain estimates under
continuous changes, not permission to allocate another generation or a promise
that a backup is due now. Rotation warnings take precedence over capacity text.

## Generation and retirement are separate

The policy remains three normal copies and at most one pending copy. A pending
fourth copy holds new generations across restart. No reset, lock deletion,
automatic retention switch or fifth-copy exception is introduced.

For maintenance, first prepare the existing exact retirement plan using
`sqlite-retention-plan.py` with periodic-only selection. The plan binds the
specific source/root, lifecycle state, object identities, hashes, references,
protected recovery windows and read/time budget. Plan creation is not deletion
authorization. Execution still needs its separate exact, time-bound approval
and native resource proofs. Replacement, stale approval, reference changes or
partial deletion remain held. After a successful approved retirement the pending
copy is promoted and the original allocation is released. Production actions
require a separately authorized maintenance window.

## Reproducible counterexamples and recovery drill

- `reproducible-release.test.cjs`: missing helper cannot yield a successful
  five-helper package; LF/CRLF closure hashes agree; reordered manifest keys do
  not change identity; changed payload is rejected; host-write evidence commits
  only after the actual write and binds descriptor access mode.
- `startup-sqlite.test.cjs`: reversed historical additions pass both independent
  Python/Node gates; changed types, defaults, constraints, migrations, triggers
  and indexes fail. Historical fixtures contain only their declared migrations.
- `test_periodic_lifecycle.py`: a full pending set cannot create a fifth point;
  later verification does not change original generation; status preserves all
  points; ample disk space cannot override a rotation hold; exact retirement and
  interrupted/replayed actions retain the original protections.
- `rebuild-recovery.test.cjs` (opt-in, Windows + existing dependencies): builds
  an isolated package from committed source using the regular builder and its
  bounded build-only scope, verifies the helper/runtime closure, generates one
  tiny synthetic recovery point, restores to a new path and starts the restored
  application under the external-operation guard. All table digests must agree
  immediately after restore. The fixture also contains one XHS cached body/image
  and one running list checkpoint: after startup, every non-task table remains
  identical and only the task's expected blocked/interrupted recovery fields may
  change. It never reads a production database/session.

Run the drill with `WEWE_OFFLINE_REBUILD=1` and Node's test runner. Artifacts are
retained beneath ignored `output/release-repro/` for local inspection; they are
not release/install pointers. No service switch or deployment occurs. A passing
drill proves this source/toolchain and synthetic recovery case, not unattended
production recovery or a new real-platform acceptance.

## Exact coverage exception

Periodic retirement comparison ignores only the ordinary stored column
`feeds.sync_time`. The earlier six-column summary exception is narrowed: feed
`update_time`, `updated_at`, `has_history`, `last_collection_result` and
`provider_refresh_attempt_time` remain strict, as do unknown columns, article
identity/body/media references, notes, metrics, generated values and schema.
A sync-time column used in a primary key still binds identity. This comparison
never grants permission to delete or overrides a protected-point reference.

Removing one specifically approved manual protection only permits fresh planning.
Generate the existing exact batch without calling its executor; keep the
three-normal/one-pending allowance and automatic deletion disabled. Before any
separate irreversible approval, the batch must retain exact source/root/object
identities, receipt hashes, reference records and a fresh resource check. All
other protected points remain protected. A current-content coverage proof does
not reconstruct a deleted historical whole-database snapshot. Production package
code is not changed by a development-branch commit.

`test_snapshot_covers.py` uses in-memory SQLite only. It proves the one-column
positive case without mutation, rejects every former extra exception, changed
bodies/media/identities/types/schema, missing rows, unknown tables and generated
or primary-key sync-time changes. The focused CI runs it on Linux and Windows.
