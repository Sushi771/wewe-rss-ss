# Preserving update contract

This opt-in operation contract extends the existing release scope. It is not an
installation approval. Policies without `preservingUpdate` retain full reference
coverage requirements, including shortcuts. Retirement, overwrite and cleanup
operations must continue using that original mode.

`preservingUpdate.format` is `1`. `operation` matches the actual `build`,
`install` or `restart` request. Build effects are exactly `new-output-only` and
require the existing build-only source/runtime/command bindings. Existing output
reuse is refused; failed output and its claim remain held for review.

Install/restart policies bind a single `active.pointer`, its `pointerSha256`,
`currentId`, `candidateId`, both manifest SHA-256 values and `oldProcess` PID,
start time and executable SHA-256. Both packages must contain exactly matching
schema and migration manifest entries. This mode does not migrate a database.

Process/task/pointer/rollback/inflight observations remain required. Shortcuts
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
