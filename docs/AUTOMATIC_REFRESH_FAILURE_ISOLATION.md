# Automatic refresh: independent cache recovery

A successful upstream update receipt and a successful local cache save are
different events. Previously an unclassified cache exception paused the entire
refresh batch, including later accepted subscriptions. A later scheduled intent
could skip every subscription because the original batch still owned the work,
yet record its own state as `completed`.

The queue now isolates ordinary cache failures per subscription. Confirmed
accepted work continues through the local cache reader with `fetchMedia: false`;
it never replays `/add`. Other subscriptions can continue their own preparation,
submission and cache stages. Unknown submission receipts remain unknown and do
not authorize a new update request.

## Durable recovery and truthful status

- Each accepted subscription retains its original `refreshChecks` and batch
  creation time. Cache work has at most 10 checks and an absolute 24-hour window.
  Each check is reserved on disk before the callback, so a lost receipt cannot
  renew the budget. A callback is not started after either budget expires.
- Ordinary cache exceptions switch that item to `cacheOnly`, with exponential
  backoff from 60 seconds to a maximum of 30 minutes. Restart and later scheduled
  rounds retain the count, due time and exhaustion reason.
- Older paused accepted items without an explicit shared restriction are
  converted into bounded cache continuations. This does not infer the lost
  original exception or claim that a cache was successfully saved.
- Exhaustion leaves the accepted receipt and a visible failed item. It does not
  create a fresh upstream update intent. Deleted, paused or changed subscriptions
  stop only their own cache work.
- An all-retained scheduled intent is `deferred`, with `retainedBatchIds` pointing
  to the batches that still own its work. It is not a successful completion.
  New eligible subscriptions can still run while old local cache retries wait.
- Explicit account/rate restrictions and startup protection keep the batch
  paused. Existing instance identity, storage locking, one-shot reservation,
  quiet-hour and explicit stop rules remain authoritative.

Cache failures persist fixed `failureReason` and `failurePoint` categories,
check count, next check time and exhaustion reason. Provider exception text,
SQL, credential values, paths and stack traces are not copied into batch
records. The original exception from an old generic receipt cannot be recovered
from that receipt.

## Offline verification

`refresh-cache-isolation.spec.ts` uses synthetic durable JSON records and rejects
network access. It covers independent completion after a thrown cache callback,
restart of legacy accepted work, later all-retained intents, budget/backoff
persistence, deadline refusal, explicit global gates, unknown receipts, stopped
work and new subscriptions alongside an older retry. Service tests distinguish
feed lookup, cache read and cache save failures without replaying an update or
creating a full database snapshot.

Related existing manual/scheduled queue, preparation retry, coverage and cache-only
tests continue to assert that accepted and uncertain updates are never resubmitted.
No production queue, database, subscription or platform request is required to
run these tests. Deployment and historical queue recovery remain separate
operational decisions.
