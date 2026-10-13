# Independent lifecycle review (2026-10-13)

Reviewed clean candidate `abd36c7` in an independent detached worktree. No production database, service, credentials, historical package, or external platform was accessed by the probes. This report does not claim production activation. The source owner's checkout was read only.

## Offline evidence

Run `node scripts/local-release/lifecycle-audit.cjs`. The audit is a characterization probe, **not a passing acceptance gate**: exit zero means the observations completed, not that the gaps below are fixed. It uses 122,880-byte synthetic databases and removes only its own newly created `wewe-lifecycle-audit-*` temp root after stopping its own child. Observed total fixture usage before cleanup: **493,768 bytes**; cleanup confirmed absent. Node 24.11.1 / Python 3.14.

Existing tests selected by `synthetic runs|real-copy opt-in|exclusive run|failed fixture` passed 4/4. Expected missing-migration traceback belongs to the injected fixture failure test.

| Path | Evidence / gap | Minimal integration follow-up |
| --- | --- | --- |
| `test-artifacts.cjs` ordinary failure | Zero remaining SQLite; 451-byte report; source-independent cleanup works. | Preserve behavior. |
| Opt-in copy failure | `realCopy:true`, default `keep:false`: a new rehearsal copy remains (123,335 bytes including report); source unchanged. `finish()` skips cleanup whenever `source` is set. | Track and remove this run's disposable copies independently of source provenance; require explicit keep for retention. Source and historical recovery points must stay untouched. |
| Forced owner termination | Killed only probe child after successful `begin()`: 122,880-byte DB, `.test-run.lock`, no report; next run rejects with locked-owner review. | Normal SIGINT/SIGTERM handling plus a supervising runner/explicit owned-run recovery for uncatchable termination. Do not automatically delete arbitrary old roots or trust a recycled PID alone. Current stale-lock failure is fail-closed, not a deadlock, but unattended retries cannot progress. |
| Case variants | `copy.SQLITE` remains after finish although `usage()` counts it. | Align cleanup suffix case handling with accounting, while retaining ownership checks. |
| Different output roots | Two simultaneous runs accepted under sibling output roots; both independently allow 512 MiB. | Define one cumulative parent accounting/lease scope across windows. Same-root mutex alone does not aggregate user-selectable roots. |
| `build.cjs` | Timestamp-based new `.local-releases` directory; dependency copies and Node runtime copies have no guard import/preflight/reservation, no whole-build failure cleanup. | Before any generation, estimate dependency/runtime/build footprint, account all existing release/build bytes, serialize reservations, check free reserve and enforce final usage. Stop on quota; never delete existing packages. Compact mode alone does not bound repeated builds. Source owner's one-off estimator is useful evidence, but does not enforce future CLI calls. |
| `resume-legacy.cjs` | Explicit `--real-copy` and path containment check, but no shared test lease/preflight or bounded lifecycle. Old package runs with inherited environment rather than an explicit test budget policy. | Guard the prepared fixture and new outputs before launch; propagate explicit test policy. Do not silently remove retained existing fixtures. |
| `acceptance-real-export.cjs` | Creates `wewe-real-export-*` temp root and SQLite, then only disconnects Prisma. No artifact guard, no cleanup, unbounded input HTML/images and repeated report roots. Static inspection only; not executed. | Guard synthetic export fixture and media/report generation; finish in outer finally and retain small reports outside deleted disposable files. |

## Entry-point coverage and limits

`rehearse`, rehearsal `restart`, rehearsal `switch`, `benchmark-launch` and parent `album-acceptance-rehearsal` call `test-artifacts.begin`; their normal try/finally calls finish. `cleanEnvironment()` preserves `SQLITE_TEST_BUDGET_ROOT`, so guarded child backups can account the same root. Benchmark delegates two runs and avoids full release-tree cloning. Album baseline-only still generates a backup and copy; because it supplies a source, it inherits the opt-in retention gap even on an early return.

Direct `synthetic-sqlite.py`, small Node/Python unit fixture creation, and `acceptance-real-export` do not universally route through the shared run accounting. Unit fixtures are generally small and cleaned, but this does not establish a cross-window global 512 MiB cap. Historical `build-portable.js` is also outside this guard and deletes existing output paths; it was **not executed or modified**.

`acceptance-audit.py`, `acceptance-builtin.py`, and `acceptance-recent.py` open their source SQLite read only. No full production/release HTTP rehearsal was performed in this independent review: isolated checkout has no dependencies or packaged runtime, and rebuilding/copying packages would consume the budget and duplicate the source owner's acceptance work. Only small synthetic probes and static entry-point inspection support this report.

## Ownership / patch boundary

This commit adds only this document and the independent audit probe. No helper or production code fix is included pending explicit modification ownership from the coordinating thread. Recommended regression gates after owner fixes: source unchanged plus zero disposable copies on failure; SIGINT cleanup and supervised hard-kill recovery; cross-root cumulative refusal before generation; resume refusal before process spawn; package quota refusal before `cpSync` or compiler output; failed build cleans only current-run artifacts; uppercase SQLite cleanup.
