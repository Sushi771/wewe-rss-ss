# Persistent automatic preparation retries

An automatic subscription refresh can fail while reading the subscription,
checking the account, preparing its verified backup, or acquiring its local
reservation. A confirmed failure before submission must remain durable work;
the user should not need to click each failed subscription individually.

## Eligibility and limits

The automatic queue retries only an explicit preparation outcome with
`retryable: true`, `accepted: false`, `submissionUnknown` absent or false, and
`stopBatch: false`. The outcome must be `failed` or `queued`. Error text, an
absent acceptance flag, an arbitrary thrown error, and a completed batch alone
are never evidence of a safe retry.

- Each item has at most eight preparation attempts in its original automatic
  intent. Existing preparation counts are retained.
- The persisted delays after failures are 60, 120, 240, 480, 960, 1800 and
  1800 seconds. The delay never shortens on restart or duplicate scheduling.
- The absolute retry deadline is the original batch creation time plus 24
  hours. Restart and receipt reconciliation do not extend it.
- A pending preparation retry may cross Shanghai midnight within that
  deadline. Automatic submissions still stop during 00:00–05:59 and when
  scheduling is disabled. Ordinary unsent items still expire at midnight.
- Exhaustion persists as `failed` with `retryExhausted: attempt-limit` or
  `deadline`. It does not keep its own polling timer alive or reset on a
  repeated delivery of the same slot. A new scheduled intent has its own
  ordinary round budget.

Manual refresh retains its existing three-attempt preparation limit. Stopped
and cache-only rounds do not authorize automatic submission recovery.

## Recovery and deduplication

Initialization wakes eligible legacy records, including `completed` records
whose unsent items reached the old three-attempt limit. Under the existing
storage mutex, only those items return to `queued`; successes, accepted work,
unknown receipts and explicit account restrictions retain their safeguards.
Old records discovered after their absolute deadline finish without any
submission. The migration does not depend on private data or error messages.

The original batch ID, intent key, per-item count and `retryAfter` remain
authoritative. Repeated delivery of one automatic slot reuses the same record.
Pending legacy retries are restored before overlapping later slots are
deduplicated. A delayed item cannot prevent independent items in another
round from running; the existing global submission spacing remains in force.
Completed successes in a still-running older round may join a new automatic
slot. Pending retries and accepted-but-incomplete or uncertain requests stay
with their original intent; one failed peer cannot suppress the next update
of an already successful subscription.

Before a retry callback runs, the queue persists its incremented count and
`submitting` state atomically. A crash at that boundary consumes the claim and
leaves an uncertain submission. Recovery cannot replay the callback merely
because the previous attempt was safely retryable. The existing read-only
reconciliation callback must independently return `not-submitted` before
another bounded preparation attempt can run. `unknown` or a reconciliation
error leaves that item isolated. Confirmed acceptance is never cleared by
preparation flags or a later cache-stage failure; accepted cache work never
re-enters submission.

## Integration and validation

The batch module uses the existing `attachRefresh` and `attachReconciliation`
contracts. The service must classify `retryable` only before its committed
reservation and platform call; exceptions after those boundaries remain
unknown. No preparation or submission operation is replayed by a read-only
status endpoint. This change does not alter backup or database coordination.

Offline tests use synthetic subscription IDs, temporary state files, a
controlled clock and callback doubles. They cover eleven legacy terminal
failures alongside three successes, retry budget exhaustion, deadline expiry,
restart, duplicate slot delivery, two-worker claims, cross-slot isolation,
midnight silence, disabled schedules, stopped/cache-only work, instance
changes, accepted cache failures and crash-before-result receipt checks.
These tests validate the queue protocol, not real subscription recovery.

Run the relevant regression suites with:

```sh
pnpm --filter server exec jest --runInBand --runTestsByPath \
  src/collection/durable-refresh-retries.spec.ts \
  src/collection/scheduled-refresh-batches.spec.ts \
  src/collection/manual-refresh-batches.spec.ts \
  src/collection/wechat2rss-subscription-batches.spec.ts \
  src/trpc/manual-refresh.spec.ts \
  src/feeds/active-refresh-schedule.spec.ts
```

Production activation and observation belong to the integration owner. No
production state migration, platform request or service restart is performed
by these offline tests.

Use one worker version for this state directory. Older releases that validate
preparation counts only up to three cannot read records with larger retry
counts. Preserve those records when preparing a rollback; running a legacy
worker alongside the updated queue can bypass its deduplication view.
