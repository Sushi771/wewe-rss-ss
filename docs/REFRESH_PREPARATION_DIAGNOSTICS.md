# Refresh preparation diagnostics

Before a refresh network closure is exposed, preparation checks the feed, prior
claim, provider configuration, account, subscription and reservation. A failure
now retains `preparationFailure: { code, stage }` in the batch item and its public
view. Both fields use fixed allowlists. Exception messages, stacks, causes,
URLs, credentials, database paths and SQL are never copied into this diagnostic.

`WECHAT2RSS_SOURCE_STOPPED` is a source-protection block, not a successful skip.
The item remains unaccepted and not an uncertain submission. Its round pauses
without automatic preparation retries. This does not authorize clearing a
pending source gate, changing unknown claims, forcing protection open, or
requesting the source again. The reason for retained protection still requires
separate evidence; a blocked gate alone does not identify a historical error.

Unknown exceptions and temporary network/timeouts retain the existing bounded
retry policy. Code/stage survive retry messages, restart and exhaustion. Once
a later closure is accepted or uncertain, stale preparation diagnostics are
removed: invoked requests retain the original unknown-submission protection
and are never reclassified as safely retryable preparation.

The regression uses the real Trpc method, provider and source gate with mocked
Prisma returning zero affected rows for the gate's idle-only update. It proves
that this rejection occurs before fetch, backup or reservation, not that a real
production pending row or the original hidden exception has been reconstructed.
Batch regressions use only temporary synthetic files. Production data, source
requests, installed releases and the nine-backup ceiling are unchanged.

The exact installed schema35 manifest e24a1b70ea81017c177f4087ef757ae8d8ea5841340d540ed8f395b1feca9377 is admitted in both root and installer role and prewrite gates. Admission still requires the identical rollback manifest and unchanged schema, migration history and Prisma engine. Validate the actual installed artifact and manifest with same-schema35.test.cjs before preparing an installed update; this synthetic test does not replace full installer and rollback acceptance.
