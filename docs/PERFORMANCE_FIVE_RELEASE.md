# Cache reconciliation and five-request candidate

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
