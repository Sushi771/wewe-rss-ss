# Compatible serial rollback

Base: deployed frontend commit 3974a1c041e333945bfb0f5a106a1858bf5962d5.

Restores serial update submissions and previous cache reconciliation while retaining
the deployed frontend, current SQLite data and durable task records. Compatibility
comes from the reviewed v4 worker and service transforms in the five-wave candidate.
It preserves account restrictions, unknown receipts, retry budgets and stopped tasks.
Switch only binaries: never restore old task snapshots over current receipts.

Build from this clean commit and verify with isolated synthetic data before activation.
Production activation requires approval. No upstream request is part of verification.
