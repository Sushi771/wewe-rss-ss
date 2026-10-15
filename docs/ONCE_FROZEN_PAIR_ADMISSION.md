# Frozen pair installation admission

`scripts/local-release/once-pair-admission.cjs --apply` is the installation-only operation. The same exact policy can explicitly authorize the finite publication and rollback path below. Both retain four protected packages, including the held fallback, while current/candidate/compatible rollback remain three managed roles. The held fallback is never demoted, activated or deleted.

The fixed additional allowance is 244,453,376 bytes: at most 243,404,800 bytes of two immutable package copies and 1,048,576 bytes of controller metadata. At most two new package slots and two Node copies exist. At admission, the installation volume needs at least 4,539,420,672 available bytes. The 4 GiB free-space floor remains throughout checks. Publication audit capacity is a separate decision and is not included here.

The policy pins all participating canonical root identities, the single approved registry identity/scope ID, current pointer, four manifests and package identities, compatibility evidence, controller dependencies, reference probe and its collector. Only four immutable packages are inspected and hashed. Other existing workspace/build/backup bytes remain charged through actual volume free space; normal database, WAL and periodic backup changes are not frozen. This does not adopt a large historical content snapshot or permit historical disposal.

Review the private policy and its SHA-256 before use:

```text
node scripts/local-release/once-pair-admission.cjs --review <private-policy.json> <sha256>
node scripts/local-release/once-pair-admission.cjs --apply <approved-private-policy.json> <sha256>
```

`--review` neither writes a registry nor invokes a native query. `--apply` requires explicit approval in that exact policy. It creates the real single-owner lock, checksummed ledger and adoption marker, then invokes the pinned read-only Windows reference collector as its own child. All six reference categories must be complete, every reference must resolve to the four exact package identities/paths, and reference changes refuse installation. The existing directory identity fix remains in the pinned collector.

The native controller's exact launcher mapping can use `--apply <policy>` with its approved digest supplied as the process-local `WEWE_ONCE_PAIR_SHA256` variable. This avoids putting a policy's own digest inside its pinned launcher argv, which would be self-referential. The same digest check applies before adoption. No persistent environment setting is changed.

The existing installation engine checks source/target manifests, local ownership, exact legacy inventory, three managed roles, free space and final outputs. The new mode supplies a bounded 64 KiB copy operation instead of an unrestricted recursive copy. It copies only approved manifest files and verifies each size/hash; only approved internal package links are recreated. Scope effects permit the two exact output directories and bounded lifecycle metadata. Processes, activation, builders, other outputs and generic writers are refused.

This mode can record at most 129 exact existing legacy package directory names; it reads no historical payload to govern that inventory and grants those names no new output credit. The normal engine's default remains 128. Both limits are bounded, and any unlisted historical output still holds. This narrowly accommodates an existing inventory while retaining every historical package.

Claims precede output allocation. An interrupted or uncertain partial copy is held with its credit spent; there is no automatic cleanup, stale-owner recovery, alternate registry or new timestamp target. A completed replay verifies and reuses the same two slots, allocating zero additional Node copies. Foreign locks, changed policy/controller/source bytes, missing evidence, insufficient capacity and unknown references hold rather than weakening the normal scope guard.

Installation alone grants no activation, service restart, database access/restore or migration. The complete path requires its own explicit operation list and finite allowance in the same policy. Neither path grants backup deletion, dependency installation, rebuild, global configuration or main-branch permission. Default release-scope limits remain unchanged.

Synthetic tests exercise the actual CLI dispatcher with only the native read-only query stubbed. They use inert tiny package files and task-owned temporary roots, including internal links. They cover exact admission thresholds, normal mutable business/backup files, unknown references, immutable proof failures, two-slot replay, interrupted-output retention and denied out-of-scope effects. No production package is installed during testing.

## Complete publication and rollback

`--deploy` installs or verifies the two targets, then reacquires the **same** scope lock/ledger for one publication. `--rollback` spends one compatible-rollback credit after successful publication. Both require `approval.operations` exactly `['install','publish','rollback']` and approval fields binding the actual candidate/rollback source commits. An older application approval or compatibility report cannot authorize a different integrated candidate. The controller contains no hardcoded application SHA.

The publication policy pins one owned audit directory, original DB identity, exact old PID/start/executable/command, environment-file hashes, Python/schema-engine hashes, pending migrations, allowed empty new tables and loopback RSS health contract. Observation and unrelated scopes cannot acquire this capability; the native adapter is not exported. This route does not reopen the default full-history gate or change its limits.

For approved source ceiling `S` (multiple of4KiB, at most1GiB), additional peak reservation is:

| Purpose                                                                   | Maximum reservation |
| ------------------------------------------------------------------------- | ------------------- |
| Three snapshots, verification metadata and existing backup working margin | `4*S + 2 MiB`       |
| Database/journal growth                                                   | `S + 64 MiB`        |
| Receipts and diagnostics                                                  | `16 MiB`            |
| Beyond installation                                                       | `5*S + 82 MiB`      |

At `S=768MiB`, publication adds4,112,515,072 bytes; installation plus publication totals4,356,968,448 bytes. Same-volume initial free space must be at least8,651,935,744 bytes, including the4GiB floor. Cross-volume reservations are grouped by actual device identity. Normal deployment uses two snapshots; the third protects later writes before explicit rollback. Three is a lifetime ceiling for this policy, not per retry. No historical backup is deleted or copied into a test workspace.

The complete sequence is:

1. Check final frozen package/compatibility proofs, identities, combined space and approval; install or reuse the fixed pair.
2. Claim the exact audit output, obtain complete references, verify the old process identity and create a verified protected snapshot while that service remains available.
3. Recheck identity/references, stop only the exact owned process using the existing Windows helper, then create the final protected snapshot. Save a read-only typed-row baseline and verify the snapshot against it.
4. Require the exact pending migration list. Apply only approved empty-table/index additions using the pinned Prisma schema engine's `applyMigrations` RPC. Recheck original rows, including attempted/unknown claims, and require the current schema. No reset, shadow DB, automatic SQL generation, restore or dependency installation occurs. See the [Prisma engine implementation](https://github.com/prisma/prisma/blob/5.22.0/packages/migrate/src/SchemaEngine.ts) and [RPC input contract](https://github.com/prisma/prisma/blob/5.22.0/packages/migrate/src/types.ts).
5. Reverify and start only the candidate runtime against the original DB. Require its write gate, dashboard and20-item RSS; private mode also checks anonymous rejection and in-memory login. Then atomically publish the pointer and final receipt. Runtime stdout/stderr is discarded instead of creating an unbounded service log; bounded health, identity, migration and backup receipts remain.
6. Before any migration attempt, cutover failure restarts the verified current package. After migration is attempted, recovery starts only the compatibility-proven rollback against the live DB, preserving upgraded data and unknown claims. Both automatic and explicit recovery force `ENABLE_SCHEDULED_UPDATES=0`, `DISABLE_SCHEDULED_UPDATES=1`, `WECHAT2RSS_ENABLED=0` and `WECHAT2RSS_CACHE_SYNC=0` after environment loading, without saving configuration. Candidate startup keeps its normal inherited settings. Recovery verifies health and publishes the pointer/receipt. Unused primary reservations are released for bounded recovery; no fresh package or snapshot credit appears.
7. Explicit later rollback uses the third snapshot, rechecks/stops the receipt-bound process, then performs compatible recovery. Repeats verify package/pointer proofs and return the stored receipt without another package, backup or start. A stored receipt is not fresh service-health evidence.

Every stage is recorded before its effect. Interrupted/uncertain publication stays held. Each ownership check revalidates the policy roots and the canonical audit ancestor chain as well as the audit leaf. If ledger, lock, policy, registry, audit ancestry or active-pointer ownership changes, exception handling preserves unknown authority and the lock; it never overwrites foreign state from memory. Atomic ledger and pointer publication check the temporary file identity and exact serialized bytes. Pointer replacement or in-place modification cannot be adopted as a successful publication or overwritten through automatic fallback. The candidate may already be running when pointer ownership is lost; the held claim requires owner reconciliation before any further action. There is no alternate registry or automatic credit reset.

Native collection completeness, final integrated package pair and fresh compatibility proof still require owner review and execution approval. Unsupported/destructive migration SQL refuses before stopping the old service. A partial migration or failed compatible startup remains a held incident with protected backups and no automatic DB restore. Synthetic workflow and native SQLite tests do not certify actual production acceptance.
