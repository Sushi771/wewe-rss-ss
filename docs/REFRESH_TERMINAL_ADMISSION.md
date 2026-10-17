# Terminal refresh work and admission of a later round

Refresh history records both upstream submission receipts and local cache work.
A historical child label must not permanently reserve a subscription after its
work has ended. Previously the cross-round fallback and receipt-coverage set
kept every accepted item whose state was not `succeeded`, even when its parent
was completed and its cache budget was exhausted. Later scheduled rounds then
skipped those subscriptions indefinitely.

The admission predicate now uses the same existing lifecycle bounds as recovery:

| Existing evidence                                                                                                            | Later scheduled intent                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown submission, an interrupted submitting claim, claimed queued work without not-submitted proof, or unconfirmed waiting | Reserve the subscription until the existing read-only ledger can establish a result; age and terminal parent labels do not authorize replay |
| Confirmed accepted cache work within its original budget                                                                     | Keep its cache continuation and reserve the subscription                                                                                    |
| Accepted cache work that exhausted its checks or original deadline                                                           | Preserve the accepted receipt and failed/exhausted result; it no longer blocks a distinct later intent                                      |
| Explicit known-not-submitted preparation retry within its original budget                                                    | Resume the original intent and reserve its subscription, including a terminal parent with a fully populated queued retry                    |
| Plain known-unsent queued child of a closed parent, or an expired ordinary scheduled tail                                    | Retire the old unsent intent without submitting it; a new round can create its own claim                                                    |
| Active ordinary queued work in the current round                                                                             | Keep its original owner; do not create a second claim                                                                                       |

Normalization runs only under the existing batch storage lock, before recovery
and cross-round deduplication in acceptance and the worker. It uses existing
states and exhaustion fields; no new journal format or database schema is added.
The worker's midnight exemption requires actual safe preparation-retry evidence,
not merely the presence of a deadline field. Deadline validation still binds
that field to the original batch's 24-hour window.

An old intent is not resubmitted or converted into a fabricated success. Its
accepted flag, claim identity, attempt count and exhaustion evidence remain.
Repeated delivery of the same intent still returns its original batch. A later
scheduled intent has a distinct batch/claim and continues through the unchanged
per-feed database reservation, one-shot receipt and account/window protections.
Ending a cache budget does not declare the original update unsubmitted.

Unknown outcomes are never released because they are old. Explicit stop,
instance guards, shared account/rate/startup gates and bounded preparation/cache
budgets remain in force. Explicit cache-only recovery retains its unsent history
and cannot inherit permission to submit it. A durable accepted receipt paired
with a stale queued or interrupted submitting label can continue only as cache work.

`refresh-terminal-admission.spec.ts` uses synthetic durable records and mocked
callbacks with network access rejected. It covers a full 14-source later round,
completed queued tails, current active parents, explicit valid/expired retry
evidence, exhausted cache receipts, ambiguous outcomes, ledger proof, real
storage-lock contention and restart/idempotency. Existing preparation, cache,
five-request wave and stop regressions remain authoritative. No production queue
edit, database copy, platform refresh or full database backup is needed.

Deployment and verification are separate operational decisions. This patch does
not deploy or alter production records during development. After a reviewed
deployment, the next natural scheduler intent exercises the corrected admission;
historical batches need not be manually replayed to create that new intent.

## Parent completion and source coverage

The explicit `resumeCacheOnly` path and its cache-result settlement previously
considered only remaining `waiting` children. It could mark the parent completed
while leaving an ordinary unsent `queued` tail, since cache-only mode deliberately
cannot submit that tail. Conversion now cancels explicitly known-unsent children;
the worker applies the same repair to legacy cache-only records under its lock.
The accepted flag and original input remain, so cancellation cannot masquerade as
an upstream update or erase evidence. An ambiguous claim is never cancelled this way.
This is a reproducible code path, not a claim about an undocumented historical call.

Every refresh response/list derives a coverage audit from the original source
list and the current durable receipts. Scheduled admission retains unknown-held
sources in its input even when it cannot claim them. Counts distinguish expected,
submitted in this round, completed, pending, legitimate skips, exclusions and
anomalies. A skipped label requires a structured source-change/pause result or
a valid retained owner/verified completion. Active retained work remains pending;
unconfirmed or missing owner evidence remains an anomaly. A legal exclusion is
not an update. `fullyUpdated` is true only when every input has completion evidence.
The progress page also displays terminal coverage, so a completed parent with
12 successes and two unproved skips cannot disappear as apparent full coverage.

Coverage is a read projection, not a new persisted queue format or permission to
send a request. Synthetic regressions include 128 sources, 14-source partial
coverage, owner completion after restart, retained unknowns and legal exclusions.
The parent record's `updatedAt` is not a per-source completion receipt. A retained
owner's completed source counts as a current update only when its own claim is
at or after the new intent. A proven earlier claim is a separate prior-round
exclusion; missing claim evidence remains an anomaly. Neither earns full-update
wording merely because some other child updated the parent record.
