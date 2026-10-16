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
continue to apply; the automatic mode keeps its frozen background bindings.

For this fixed maintenance mode only, unrelated background process observations
are retained as visible risk rather than an exact PID allowlist. Their additions,
removals and restarts do not require an identical observation digest. Association
by service identity, paths, argv, parent chains and port ownership is still checked
first; related changes and opaque execution hosts still refuse. The existing
automatic mode retains its exact background bindings. Neither mode proves that
all indirect database access has been excluded.

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
exact CI head and independent review, record the acknowledged indirect-access risk,
and obtain approval for that plan digest and maintenance ownership exception.
Only the approved execution may create a real maintenance lock and record.

The existing `--execute` entry also accepts one explicitly approved
`maintenance.continueBeforeStop` checkpoint. It pins the previous maintenance
plan, record and lock (SHA and file identity), and the real recorded controller
PID with the explicit `historicalIdentity: "not-recorded"` declaration. The old
protocol did not retain start/executable/argv; this checkpoint refuses invented
historical identity fields. The new exact plan approval binds this evidence gap.
The native adapter checks only that single PID twice and refuses any
present/reused PID or uncertain query; its result explicitly claims only current
PID absence. It cannot authenticate historical creation identity or globally
exclude unobserved different-PID writers. Existing related-writer checks remain.

The checkpoint also explicitly pins all fourteen previous tool files in its
`tools` map. These files are frozen evidence whose raw hashes must match the old
plan, with canonical file paths and stable file identities. They need not reside
in the original tool directory, which may already contain the upgraded code.
The old approved plan and its original invocation paths remain unchanged.
The frozen evidence pins are rechecked by the shared owner validation.

Only the exact two completed copies followed by the pre-stop input-pin failure
are eligible. Any stop, backup, migration, publication or recovery intent,
partial output, audit/service state or changed package refuses. Old and new
plans must match except the exact runtime pins, plan location, approval and
checkpoint binding. No new package is copied and no allowance is reset.

A fixed `.maintenance.json.pre-stop.json` receipt is exclusively created,
fsynced and read back before replacing the same maintenance record and lock.
It permanently retains the complete previous record/lock text and source pins,
new caller/nonce/plan and current exit observation. It shares the original
1 MiB metadata ceiling, including temporary files. Partial receipt or authority
installation holds; its presence prevents another transfer under a new approval.
The shared owner parser validates the receipt and retained history. Successful
installation continues at the existing pending-migration/process checks before
stop. This checkpoint adds no general resume, cleanup or credit reset.
