# Reviewed XHS collection continuation

The continuation path appends a narrower review when an unknown nested receipt
can be attributed to the same marker, phase, and valid note identity as its
parent. It retains the old review, unknown records, cumulative request use,
other exclusions, and current authentication or source restrictions.

## Execution path and acceptance boundary

`XhsWholeCreatorService.executeWholeCreatorFullHistory` creates a subscription
task through `XhsSubscriptionService.refreshFull` with the reviewed context.
The child waits for the existing-job checkpoint transaction to commit before
source work is released. A failed checkpoint cancels the queued child without
dispatching source work. This path is separate from the legacy whole-job
generation executor.

Before confirming a narrower review, the service checks the current runtime
session and local source activity, checks queued/running task rows, obtains a
verified protected snapshot, and rechecks the database identity, fingerprint,
review state, and idle state inside the transaction. A new review does not
mark the session authenticated or refund old request use.

The continuation must exclude only the proved individual unknown notes. A
known article-local failure must leave other eligible notes in the same
creator available. A new unknown request outcome or current source-wide
authentication, verification, or throttling restriction still stops work.

Cancellation acceptance must exercise the subscription task's `cancelTask`
entry point. A test of the legacy whole-job cancellation method alone does
not establish cancellation safety for the full-history child task. Interrupted
or unconfirmed requests must remain fenced and must not be replayed.

## Evidence limits

Offline tests use isolated SQLite and synthetic source responses. A synthetic
backup witness tests ordering and rejection at the snapshot interface; it is
not evidence that a real installation backup or rollback succeeded. Those
checks remain prerequisites of the supported installer.

Source equality and a shared error message do not establish that a failing
test is harmless. Baseline controls must use the same selected test,
dependencies, working directory, database setup, and runtime conditions, or
state the differences explicitly. Passing scoped tests must not be described
as a passing full CI run.

Deployment acceptance also retains the configured backup-copy limit, verified
recovery capacity, exact candidate/current release bindings, and source-idle
checks. No test result authorizes deleting a backup, clearing an unknown
record, or bypassing a platform refusal.

## Scoped regression checks

`xhs-full-history-narrow-product.spec.ts` uses the real review service,
subscription worker, runtime, request ledger, and SQLite transactions. Its
synthetic directory contains 23 notes and three historical exclusions:

- Normal continuation saves the other 20 notes; an active runtime or queued
  task rejects confirmation before the snapshot interface is called.
- An invalid snapshot witness creates no new review or budget rows.
- One identity/time-bound synchronous content parse failure leaves the other
  19 notes complete, including the final note. The failed request stays charged.
- HTTP 429 stops subsequent details, preserves the blocked risk state, and
  retains charges for the requests already sent.
- Previous unknown records and old budgets remain intact. Reusing the same
  reviewed execution is rejected.

This fixture covers body and metric storage. It does not issue media requests
or validate a real backup. `xhs-full-history-cancellation.spec.ts` separately
checks the actual full-history subscription child's cancellation entry point:
before-dispatch cancellation sends nothing and consumes no request use;
in-flight cancellation retains unknown outcome, global/scoped charges, and
pending/blocked durable risk. Reconstructing the service does not replay the
request. This is not a full process-crash or installation-recovery rehearsal.

The real synthetic rollback-journal contention case in
`media-transaction.spec.ts` observed `P1008` on both the installed-source
baseline and the candidate under matching conditions. Its assertion recognizes
that timeout and `P2028`, while retaining every subsequent check of old-body
preservation, released connections, one cached-data repair, and no callback
replay. This changes a test precondition, not production recovery behavior.

Original legacy whole-job cancellation/missing-mock cases were also run on
both pinned source versions with matching runtime, dependencies, package
configuration, and synthetic databases. Their matching failures establish
baseline failures for those selected cases. They do not establish that every
remaining full-suite failure is harmless. The full CI result must continue to
be reported independently from these scoped checks.
