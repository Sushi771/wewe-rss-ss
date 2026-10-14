# Bounded refresh waves

Manual and scheduled subscription refreshes use the same storage-locked worker.
Each wave selects at most five eligible subscriptions; fourteen subscriptions form
5 + 5 + 4. A tail of one to four is submitted in full. There is no independent
timer or per-round concurrency pool that could multiply the account limit.

The default minimum interval between wave launches remains 30 seconds. A wave
must finish its network calls and durable receipt writes before another starts.
Serial preparation of the next wave can extend the interval beyond 30 seconds.
The public upstream API documents individual GET `/add/:id` requests and does
not promise batch acceptance or an internal concurrency level. Five concurrent
client requests do not prove five concurrent upstream crawls.

Preparation checks the account and subscription, creates a verified consistent
backup, and conditionally reserves each feed in SQLite, serially. Prepared
closures contain only the update request. Existing collection guards stay held
until every request has settled. Receipt persistence and cancellation writes run
serially; an individual storage failure cannot release the wave lock while other
requests or receipt writes remain in flight.

Every source has a durable claim before preparation and a separate outcome.
Successful peers retain acceptance. Unknown outcomes remain unknown and are not
resubmitted. A process interrupted with a claim in `submitting` is conservatively
reconciled, preserving the existing retry budget and deadline. All interrupted
wave claims become unknown together. Late callbacks after worker shutdown do
not certify receipts; an explicit batch stop while the worker remains open still
retains live receipts. Safe preparation
failures retain the existing three manual/eight automatic attempt limits and
absolute automatic 24-hour deadline; they rejoin eligible waves after backoff.
Disabled, removed, paused and cooling-down sources are skipped independently.

Account restrictions stop a prepared wave before launch. An HTTP 429 from an
update retains uncertainty, stops subsequent waves of that intent, and persists
a shared minimum two-minute cooldown for other intents. Already issued requests
are allowed to settle and retain their own receipts. A not-submitted receipt proof
never clears the independent restriction or authorizes another wave.

Temporary 429 restrictions use `restrictionKind: rate-limit`. After cooldown, a
separate fresh account-status check may release them; an absent, failed or
unhealthy check keeps the intent paused and extends the read-check backoff.
Known account restrictions use `restrictionKind: account` and require explicit
resume plus a fresh healthy account check. Legacy restriction records without a
kind are conservative and require explicit resume. Both paths retain unknown
receipts, retry counts, absolute deadlines and the scheduled quiet window.
Recovery, wave admission and the compatible serial worker each check the
restriction independently, including after a not-submitted proof.

After an asynchronous account check, coverage and preparation recovery share one
fresh record snapshot. Recovery writes serialize per batch and recheck the latest
stopped state before persistence, preserving cancellations and retry budgets.
The compatible serial rollback worker applies the same protection.
Unknown generic network failures isolate the affected source rather than
inventing an account-wide restriction.

The optional durable `sharedRestriction` flag distinguishes an explicit shared
restriction from an uncertain receipt. Older workers preserve the raw field but
do not honor it, and can resume a restricted round after cooldown.
`scripts/local-release/refresh-wave-rollback-compat.cjs` provides
`compatibleSerialRefreshWorker(source)` for the serial worker in an isolated
rollback checkout based on the actual deployed commit. It adds strict boolean
validation, retains the explicit shared restriction and cooldown, and converts
all interrupted wave claims to unknown without replay. It is idempotent and
rejects a concurrent worker as the rollback base. The helper never reads or
writes a database or durable state. Rebuild and verify that isolated rollback
bundle before a future deployment; preserve new receipts instead of restoring
an older state snapshot.

## Offline evidence and limits

Fixtures cover 1, 4, 5, 6 and 14 sources, an exact tail, no sixth active request,
serial preparation, shared storage admission, receipt uncertainty, restart,
account restrictions, HTTP 429, cancellation and isolated preparation retries.
Service-level fixtures confirm that list checks, backups and reservations finish
before any update closure is invoked; no SQLite reservation is written by a
successful network closure. Provider fixtures use synthetic responses only.
Rollback fixtures load the actual committed serial worker, demonstrate that its
unmodified worker ignores the restriction, then verify the compatible worker against
state produced by the new worker, including a 429 cooldown and five interrupted
claims. The fixture database remains unchanged.

With one-second serial preparation per source and three-second parallel network
responses, the 14-source fixture launches at 5, 40 and 74 seconds and receives
the final network result at 77 seconds. This is a synthetic scheduler example,
not a measured upstream speed or a cache/media completion promise. Cache checks
retain their existing 30-second cadence and single-consumer behavior.

Further measured candidates are page-scoped saved-body flag reads and eliminating
duplicate unchanged-page preflights. These are separate changes. Verified backup
reuse already exists and is not a new gain in this change. Preparation may still
need a fresh backup after another feed reservation changes the database. It must
not reuse an unverified or changed snapshot merely to increase concurrency.

No production deployment, live concurrency experiment, new platform request,
schema migration, media fetch, export directory change or handwritten-body update
is part of this development change.
