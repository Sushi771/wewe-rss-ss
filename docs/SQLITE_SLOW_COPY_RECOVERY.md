# Large SQLite backup preparation

The application can correctly serialize backups with writes and still fail before
an upstream refresh is submitted. The previous pinned copy had a hard 15-second
budget. A large archive under disk load can exhaust that budget without a single
SQLite busy step. Retrying the same full copy several times does not resolve the
underlying disk cost.

The copy budget now defaults to 45 seconds (configuration range 1–45 seconds).
The entire Python backup still has a 55-second deadline; the Node child deadline
remains 60 seconds and application admission remains bounded at 75 seconds.
Verification and hashing remain mandatory. Source locks close before verification
and hashing. Termination without a close receipt still fences application writes.
No journal mode is changed and transaction callbacks are not replayed.

Repeated preparation checks can reuse a verified snapshot for at most 30 seconds,
only inside the application's exclusive backup admission. The source must be an
unchanged rollback-journal SQLite file: its complete header, file identity, size,
and nanosecond modification/change times must match. WAL, an active journal,
missing proof, a commit, replacement, expiry, or a changed/deleted backup forces
a fresh backup. Failure of that fresh backup propagates; old protection never
masks failure. Reuse is bounded to four process-local entries and is discarded
on restart. Maintenance writers outside the app must remain stopped during
production backup operations, as required by the existing coordinator contract.

This does not allow a snapshot to protect later committed database versions and
does not provide durable retry scheduling. The independent subscription batch
recovery change must handle explicitly unsent items with bounded persistent
backoff and reconcile accepted/uncertain receipts before any new submission.

Offline regressions cover real isolated commits, rollback-journal and WAL copies,
slow copy beyond the old budget, total deadline exhaustion, artifact loss/change,
expiry, a fresh verification failure, and queued writes entering only after backup
admission releases. Private large-archive acceptance records stay local and are
not included in GitHub. No production deployment or platform request is part of
these tests.
