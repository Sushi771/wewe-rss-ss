# Cache reconciliation and bounded refresh waves

This candidate starts from the deployed frontend commit
`3974a1c041e333945bfb0f5a106a1858bf5962d5`. It combines the unchanged-page
cache reconciliation optimization with bounded waves of five update requests.
Frontend folder navigation remains at that deployed version.

Preparation, account checks, backups and reservations stay serial. Network
submissions run in waves of five, including the complete final partial wave.
Cooldown, account restrictions, unknown receipts, retry budgets and user stops
remain authoritative. The same post-check stopped-state protection is applied
to the serial rollback worker.

The rollback must start from the deployed frontend commit and apply the worker
and service transformations in `refresh-wave-rollback-compat.cjs`. Keep the
current database and durable task records when switching binaries; never restore
an old task snapshot over newer accepted or unknown receipts.

Build and fingerprint both packages from clean committed checkouts. Verify them
against an isolated synthetic SQLite database with upstream access disabled,
including cached reads, the deployed frontend assets, durable receipts, retry
counts, restrictions and stopped tasks. Production activation requires approval.
No real upstream request is part of this candidate's offline verification.

## Shipped code and documentation

The approved runtime is pinned to
`d8c35aa9ca2e1d74bedd1ab30cbd0acea4ec5434`. Later documentation commits do not
change that frozen runtime. Its exact CI passed five jobs, including 125 server
suites and 1826 tests; the folder classification browser workflow also passed.
The combined local regression passed eight suites and 101 tests. Candidate and
compatible serial rollback packages both passed isolated startup, cached-read,
frontend fingerprint and durable-state preservation checks.

Implementation and recovery rules are in [Bounded refresh waves](BOUNDED_FIVE_REFRESH_WAVES.md).
Product status and remaining media limits are in [Refresh completion and media](REFRESH_COMPLETION_AND_MEDIA.md).

## Validation interpretation

Measure from durable intent creation to the final persisted list/text completion.
Report request acceptance, unknown receipts, list readiness, text readiness and
media completeness separately. Serial preparation claims precede actual dispatch.
The durable wave boundary immediately before dispatch supplies spacing evidence;
it is not a packet trace. Fast responses may already have persisted when an
observer first sees that boundary, so reconstruct membership from all claims in
that wave and its receipts instead of counting only currently in-flight items.

A comparison needs the same source set, completion definition and media outcome.
Record differences in time, cache contents and newly discovered articles. A single
real round cannot isolate the individual contribution of parallel dispatch and
reduced preflight work, or guarantee later upstream performance. Operational
evidence, source identities, local paths and credentials stay outside Git.
