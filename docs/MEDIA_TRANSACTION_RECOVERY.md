# Media commit recovery

Automatic media repair retains its existing cache, byte quota, request budget, saved-body identity checks and retry checkpoints. Images are fetched before the SQLite transaction. A callback finishing its UPDATE statements is not a successful COMMIT receipt.

For saved-media writes, the existing SQLite coordinator admits one exclusive application write scope through transaction completion and connection cleanup. If Prisma reports a transaction-boundary failure or native panic, new database access and media requests pause. The owner disconnects the failed client, reconnects once and checks a fixed read probe before releasing admission. The callback and image request are never replayed by recovery. The original failure remains visible to the queue, which later reconciles the saved row and reuses retained image bytes.

If disconnect, reconnect or the probe fails, or cleanup exceeds its bounded deadline, database writes and media requests remain paused. The status endpoint reports recovery failure. Late cleanup completion cannot silently reopen dispatch. Operators should inspect the fixed recovery status and retained queue before normal supported recovery; do not delete journals, clear queue state, repeatedly restart the service, or re-download to hide an uncertain commit.

No SQLite journal-mode migration, durability reduction or transaction timeout increase is included. The native library may still emit its panic diagnostic; successful connection cleanup must be proved by a fresh independent SQLite reader/writer, rather than inferred from a caught exception.

Installation acceptance must finish a consistent stopped-service baseline before starting the candidate. Full-table/body hashing runs on the consistent snapshot copy, with connections closed in finally blocks. Online acceptance uses short bounded queries; do not hold a live read transaction across full-database hashing.

Offline regression covers the original long-reader/failed-COMMIT condition, old-body preservation, a later cached-data repair, commit success with lost acknowledgement, exclusive writer admission, no callback replay, cleanup failure, and late timeout completion. Existing media CAS, cache and manual-edit protections remain required.
