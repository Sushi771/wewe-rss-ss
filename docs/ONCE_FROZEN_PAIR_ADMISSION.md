# Frozen pair installation admission

`scripts/local-release/once-pair-admission.cjs` is an explicit installation-only mode. It keeps four exact protected packages (current, held fallback, frozen candidate and compatible rollback), while the existing lifecycle layer manages current/candidate/rollback. The held fallback remains both protected and physically preserved. It is never activated, demoted or deleted by this mode.

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

This mode grants no activation, service restart, database access/restore, migration, backup deletion, dependency installation, rebuild, global configuration or main-branch permission. The regular release scope and its default three-protected-ID/cumulative budget behavior remain intact. A separate owner reviews any later publication/restart operation and its budget.

Synthetic tests exercise the actual CLI dispatcher with only the native read-only query stubbed. They use inert tiny package files and task-owned temporary roots, including internal links. They cover exact admission thresholds, normal mutable business/backup files, unknown references, immutable proof failures, two-slot replay, interrupted-output retention and denied out-of-scope effects. No production package is installed during testing.
