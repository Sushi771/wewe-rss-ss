# Fixed maintenance entry

`scripts/local-release/fixed-maintenance.cjs` prepares one finite maintenance
operation after a verified pre-copy continuation was consumed and held before
either package slot started. Development acceptance does not approve the
maintenance ownership exception or a production run.

The entry accepts only `--review PLAN FULL_SHA256` and
`--execute PLAN FULL_SHA256`. Review is read-only and accepts an unapproved
proposal. Execution additionally requires the maintenance approval in that exact
plan. There is no resume, retry, cleanup, arbitrary step selection, new scope,
new continuation, or credit reset. Automatic apply/deploy/rollback reject a
maintenance plan before writing a lock.

The maintenance closure consists of the existing thirteen pinned protocol files
plus this entry. The original thirteen-file protocol retains its meaning. The
plan binds the retained approved policy, exact ledger/adopted/continuation bytes
and file identities, and the full fourteen-file closure. Only the reviewed tool
pins, probe binding, collector hashes and explicitly approved background process
bindings may differ from the retained policy. Process, task and Startup rules
continue to apply; an updated background list requires a separate risk decision.

Execution owns the original scope's exclusive lock with an explicit maintenance
kind and uses one fixed `<scope>.maintenance.json` record. It never modifies the
old held ledger, adopted anchor or continuation receipt. Those records retain
their failed-attempt history. The fixed record and lock remain after completion
or failure, so a subsequent invocation cannot acquire another allowance.

The operation uses the original remaining allowance: two package copies, one
backup, one migration attempt, one candidate publication and at most one recovery.
It reuses the existing package copy/link helpers, native operations and atomic
pointer publication. Intent is written, fsynced and read back before each credit
is used. Failure also spends the credit. The old control bytes, fixed record,
lock, metadata proofs and their temporary files share the original 1 MiB metadata
ceiling. Package, backup, database-growth and audit ceilings remain unchanged.

The sequence is fixed: preflight; copy and verify both frozen packages; verify
the exact existing process and auxiliaries; stop; verify no associated writer;
create the sole protected backup and baseline; recheck pending migrations;
attempt migration; check preserved business rows and schema; start and health
check the candidate; atomically publish. Before any migration attempt, the sole
recovery uses the retained current package. After an attempt, it uses only the
fixed compatible recovery commit on the same live database. It never restores
an old business database. Recovery disables scheduled and upstream work using
the existing process-local overrides.

Unknown ownership, interrupted control persistence, an unconfirmed migration
child exit, or uncertain publication holds the operation. It does not start a
second recovery. Bounded reference diagnostics are retained privately in the
fixed record; CLI output contains safe codes and summary fields only.

Validation uses the existing inert publication fixture family, including a
genuinely consumed synthetic continuation and the full reference parser. It
covers concurrency/replay, changed source authority, partial copies, failed
credit persistence, backup failure, migration timeout with confirmed and unknown
exit, changed migration lists, health failure, uncertain publication, shared
metadata limits and diagnostic redaction. Existing Windows fixtures separately
verify the actual Node → Node probe → PowerShell synchronous process chain.
Synthetic results do not establish production admission or subscription recovery.

Before a production decision, freeze the fourteen files and plan, verify the
exact CI head and independent review, resolve the background-list risk decision,
and obtain approval for that plan digest and maintenance ownership exception.
Only the approved execution may create a real maintenance lock and record.
