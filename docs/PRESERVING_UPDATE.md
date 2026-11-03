# Preserving update contract

This opt-in operation contract extends the existing release scope. It is not an
installation approval. Policies without `preservingUpdate` retain full reference
coverage requirements, including shortcuts. Retirement, overwrite and cleanup
operations must continue using that original mode.

`preservingUpdate.format` is `1`. `operation` matches the actual `build`,
`install` or `restart` request. Build effects are exactly `new-output-only` and
require the existing build-only source/runtime/command bindings. Existing complete
output reuse is refused in this mode. Allocated failed outputs and their claims
remain held for review; an admission failure before allocation may instead leave
an adopted ledger with no claim or outputs. Inspect the actual receipt and state.

Install/restart policies bind a single `active.pointer`, its `pointerSha256`,
`currentId`, `candidateId`, both manifest SHA-256 values and `oldProcess` PID,
start time and executable SHA-256. Both packages must contain exactly matching
schema and migration manifest entries. This mode does not migrate a database.

Process/pointer/rollback/inflight observations remain required. The strictly
bound build-only/new-output-only operation does not query installation tasks or
launcher closures; task and shortcut coverage are `not_applicable`. Install and
restart retain their task/launcher requirements. Shortcuts
are marked `not_applicable` for these preserving effects; the observation has
`complete: false` and a separate `observationComplete` status. It must never be
presented as complete machine-wide shortcut coverage. Unknown observations,
writers, changed identities and held claims stop the operation.

Only owned fresh outputs and bounded administrative state are writable. Old
packages and rollback packages are retained. The approved active change uses the
existing publication lock and atomic rename; a direct pointer write is refused.
Other entry files are retained, but entries following this same active pointer
will follow its new target. Startup uses the existing backup, readiness and
fallback flow. Failure restores the previous application/active target without
restoring or discarding business database changes.

Synthetic orchestration tests use simulated process/HTTP adapters and an owned
SQLite file. They do not establish native host observation or runnable-package
acceptance. Those checks remain prerequisites before an actual installation.

For strictly preserving build-only, `preservingUpdate.rootRoles.format: 1` may
separate the one new-output accounting root from explicit `readOnlyRoots` and
pinned `controls`. This requires inventory policy format 2. Old roots retain
canonical identity checks, protected manifest/content proof and identity/time
checkpoints; their history is not declared empty or charged as new allocation.
Control paths bind exact file identity and SHA-256. Only the new output root may
receive claims, allocations or writes. Its actual baseline may be zero only when
it is an observed empty directory. Physical free-space and finite growth/runtime
limits remain. Install/restart/full modes cannot select these root roles and
retain their original complete accounting requirements.

## Repairing an existing registration

When a policy-pin change conflicts with an existing registration, inspect its
actual receipt and state before selecting a repair. Keep version and delivery
status in [development](xiaohongshu/DEVELOPMENT.md#本次交付状态2026-10-28);
machine-specific registration and failure details remain private.

A bounded repair must bind the exact old/new policies and state bytes, recheck
the original directory identities, applicable inventory, owner and limits, retain
the original evidence and a verifiable repair receipt, and preserve crash-safe
state handling. Empty outputs do not authorize resetting history or hand-editing
a hash. An unexpected claim, output, identity, policy difference or owner stops
that repair. A new scope, generic continuation or second budget mechanism is not
an automatic substitute for resolving the actual mismatch.

This is a repair criterion, not a claim that such a repair or build has passed.
Required native observation still runs in the actual scope context. Any narrower
applicability needs an explicit operation boundary and counterexample tests;
an actual access denial must not be bypassed or relabeled as success.

Package verification and installation are separate stages. Build does not call
`installPair`; installation checks the actual inventory and may use its existing
`adoptLegacy` interface when applicable. Do not infer a lifecycle conflict from
missing information or make an installation-only check a build prerequisite.
