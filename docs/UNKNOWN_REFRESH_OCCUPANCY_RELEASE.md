# Explicit release of a historical unknown's future occupancy

A historical unknown request remains unknown even when access logs or later cache
activity show upstream work. It must never be relabeled accepted/completed or
retried as the original intent merely to admit a later scheduled round.

This local control separates historical uncertainty from future occupancy. It
adds only an explicit disposition to the existing item. It does not modify the
original unknown fields, SQL claim, cooldown, result, coverage anomaly or intent.
No upstream request, enqueue, wake or cache worker runs as part of disposition.

## Supported local control

Both procedures require the existing authentication, and `ctx.isLocal`. Mutation
also retains startup write and acceptance-mode gates. There is no automatic
disposition and no UI that treats ordinary stop, restart or expiry as approval.

1. Query `feed.unknownRefreshReleaseBinding` with the exact `batchId` and `feedId`.
   It returns instance digest, original intent, item index, item snapshot SHA256
   and current source SHA256. The batch must be a terminal completed/stopped
   refresh with no queued/submitting/waiting work or shared restriction. The
   original item must explicitly be unknown and unaccepted, with valid claim
   chronology. A read-only SQL check must find its matching attempted/unknown
   claim and the active Wechat2RSS source. Feed creation time, channel, name and
   status bind source identity; a changed source cannot inherit approval.
2. An authorized local operator reviews private evidence and prepares a UTF-8 JSON
   approval file containing exactly the fields below. `authorized: true` records
   the operator's explicit decision; possession of an HTTP200 log is not itself
   authorization or an accepted response. The software checks evidence bytes and
   identity bindings; it does not independently establish the meaning of a log or
   prove remote quiescence. Approval must not be issued without that review.
3. Call `feed.releaseUnknownRefreshOccupancy` with `batchId`, `feedId`,
   `approvalFile`, the SHA256 of that file's exact bytes as `approvalSha256`, and
   `evidenceFile`. The approval is bounded to 8 KiB and evidence to 1 MiB; files
   must be nonempty regular files, with matching hashes. Paths and evidence text
   stay private and are omitted from the product projection.

| Approval field                                                                      | Required value                                                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `version`                                                                           | `1`                                                                            |
| `action`                                                                            | `release-future-rounds-only`                                                   |
| `authorized`                                                                        | `true`, only after explicit operator authorization                             |
| `instance`, `batchId`, `intentKey`, `feedId`, `index`, `itemSha256`, `sourceSha256` | Exact values from the binding query                                            |
| `evidenceSha256`                                                                    | SHA256 of the exact reviewed evidence bytes                                    |
| `approvedAt`                                                                        | Current approval epoch milliseconds; no more than one hour old at first commit |
| `futureRoundNotBefore`                                                              | Explicit future admission boundary, at or after disposition commit             |

The same-host queue mutex excludes an active old worker during disposition; local
collection guards reject other active executors. The item/source are rechecked
before the existing fsynced atomic batch write. A concurrent snapshot change
rejects approval. Commit-ACK loss and repeated identical calls are idempotent;
repetition cannot change the cutoff, evidence or approved scope. No manual JSON
or SQL editing is part of this control.

## Future admission and old-executor fence

Both the global unknown exclusion and retained-item predicate use the same future
occupancy rule. Only an explicitly different intent, newly created after the
disposition and at/after its boundary, may pass it. The original intent still
returns its original durable batch, even if its requested feed list changed.
Anonymous intents do not acquire this exception. Time alone never releases an
unresolved item.

Admission rechecks the current instance/source and the same approval/evidence
files. Preserve those private files; missing or changed evidence restores the
occupancy hold. A queued new source carries the approved source digest into both
serial and prepared admission. Source replacement after enqueue is refused before
a request; SQL reservation and feed creation identity are checked before launch.
All ordinary account, stop, time-window, cooldown and deduplication gates remain.

Serialized persistence refuses stale writes that would erase or alter the sealed
unknown item or resurrect its terminal parent. Background reconciliation skips
the sealed historical item, so it does not mutate its SQL unknown into accepted.
New future batches use distinct claims; they never replay the old claim.

The existing same-host mutex also serializes each batch's read/replace boundary
across manager instances. This covers stop writes, which intentionally bypass the
worker mutex. A bounded lock wait may return busy; it never expires a live owner's
lock or releases unknown occupancy based on elapsed time.

The original coverage remains anomalous, for example 13 completed plus one
unknown. A future 14-source round can proceed without claiming that the prior
round, new articles, cache generation, bodies or media have completed. A malformed
disposition remains a history/proof refusal, not permission to bypass a gate.

## Verification and release boundary

Owned synthetic tests cover completed/stopped parents, full next-round admission,
original-intent reuse, process restart, repeated approval/ACK loss, missing or
changed evidence, instance/source/item/intent mismatch, stale writers, a live
worker mutex and unchanged historical coverage. Real tiny SQLite integration
checks both ledgers: the old claim stays unknown and only a distinct future batch
submits once after normal cooldown. Transport is mocked; no production operation
is needed to verify the code.

This code does not authorize an actual disposition, deployment, cleanup activation
or production write. The exact candidate SHA and final regression results belong
to its draft PR. Periodic retention remains disabled under the separate release
policy.
