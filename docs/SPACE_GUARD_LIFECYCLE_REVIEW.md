# Independent lifecycle review (2026-10-13)

Reviewed clean candidate `abd36c7` in an independent detached worktree. No production database, service, credentials, historical package, or external platform was accessed by the probes. This report does not claim production activation. The source owner's checkout was read only.

## Offline evidence

Run `node scripts/local-release/lifecycle-audit.cjs`. The audit is a characterization probe, **not a passing acceptance gate**: exit zero means the observations completed, not that the gaps below are fixed. It uses 122,880-byte synthetic databases and removes only its own newly created `wewe-lifecycle-audit-*` temp root after stopping its own child. Observed total fixture usage before cleanup: **493,768 bytes**; cleanup confirmed absent. Node 24.11.1 / Python 3.14.

Existing tests selected by `synthetic runs|real-copy opt-in|exclusive run|failed fixture` passed 4/4. Expected missing-migration traceback belongs to the injected fixture failure test.

| Path                                  | Evidence / gap                                                                                                                                                                                               | Minimal integration follow-up                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-artifacts.cjs` ordinary failure | Zero remaining SQLite; 451-byte report; source-independent cleanup works.                                                                                                                                    | Preserve behavior.                                                                                                                                                                                                                                                                                                                                                              |
| Opt-in copy failure                   | `realCopy:true`, default `keep:false`: a new rehearsal copy remains (123,335 bytes including report); source unchanged. `finish()` skips cleanup whenever `source` is set.                                   | Track and remove this run's disposable copies independently of source provenance; require explicit keep for retention. Source and historical recovery points must stay untouched.                                                                                                                                                                                               |
| Forced owner termination              | Killed only probe child after successful `begin()`: 122,880-byte DB, `.test-run.lock`, no report; next run rejects with locked-owner review.                                                                 | Normal SIGINT/SIGTERM handling plus a supervising runner/explicit owned-run recovery for uncatchable termination. Do not automatically delete arbitrary old roots or trust a recycled PID alone. Current stale-lock failure is fail-closed, not a deadlock, but unattended retries cannot progress.                                                                             |
| Case variants                         | `copy.SQLITE` remains after finish although `usage()` counts it.                                                                                                                                             | Align cleanup suffix case handling with accounting, while retaining ownership checks.                                                                                                                                                                                                                                                                                           |
| Different output roots                | Two simultaneous runs accepted under sibling output roots; both independently allow 512 MiB.                                                                                                                 | Define one cumulative parent accounting/lease scope across windows. Same-root mutex alone does not aggregate user-selectable roots.                                                                                                                                                                                                                                             |
| `build.cjs`                           | Timestamp-based new `.local-releases` directory; dependency copies and Node runtime copies have no guard import/preflight/reservation, no whole-build failure cleanup.                                       | Before any generation, estimate dependency/runtime/build footprint, account all existing release/build bytes, serialize reservations, check free reserve and enforce final usage. Stop on quota; never delete existing packages. Compact mode alone does not bound repeated builds. Source owner's one-off estimator is useful evidence, but does not enforce future CLI calls. |
| `resume-legacy.cjs`                   | Explicit `--real-copy` and path containment check, but no shared test lease/preflight or bounded lifecycle. Old package runs with inherited environment rather than an explicit test budget policy.          | Guard the prepared fixture and new outputs before launch; propagate explicit test policy. Do not silently remove retained existing fixtures.                                                                                                                                                                                                                                    |
| `acceptance-real-export.cjs`          | Creates `wewe-real-export-*` temp root and SQLite, then only disconnects Prisma. No artifact guard, no cleanup, unbounded input HTML/images and repeated report roots. Static inspection only; not executed. | Guard synthetic export fixture and media/report generation; finish in outer finally and retain small reports outside deleted disposable files.                                                                                                                                                                                                                                  |

## Entry-point coverage and limits

`rehearse`, rehearsal `restart`, rehearsal `switch`, `benchmark-launch` and parent `album-acceptance-rehearsal` call `test-artifacts.begin`; their normal try/finally calls finish. `cleanEnvironment()` preserves `SQLITE_TEST_BUDGET_ROOT`, so guarded child backups can account the same root. Benchmark delegates two runs and avoids full release-tree cloning. Album baseline-only still generates a backup and copy; because it supplies a source, it inherits the opt-in retention gap even on an early return.

Direct `synthetic-sqlite.py`, small Node/Python unit fixture creation, and `acceptance-real-export` do not universally route through the shared run accounting. Unit fixtures are generally small and cleaned, but this does not establish a cross-window global 512 MiB cap. Historical `build-portable.js` is also outside this guard and deletes existing output paths; it was **not executed or modified**.

`acceptance-audit.py`, `acceptance-builtin.py`, and `acceptance-recent.py` open their source SQLite read only. No full production/release HTTP rehearsal was performed in this independent review: isolated checkout has no dependencies or packaged runtime, and rebuilding/copying packages would consume the budget and duplicate the source owner's acceptance work. Only small synthetic probes and static entry-point inspection support this report.

## Ownership / patch boundary

Initial review commit `3440a19` added only this document and the independent audit probe. The coordinator subsequently authorized lifecycle helper, its tests and an explicit recovery tool; shared `space-budget.cjs` and production backup code remain outside this window's ownership.

## Authorized helper follow-up

All cooperating test windows must set the same `WEWE_TEST_OUTPUT_ROOT` once for the campaign, or use the shared default OS temp `wewe-rss-tests`. `--output-root` now selects only a subdirectory of this managed root. An arbitrary outside output root fails before creating output. The same root lease and cumulative 512 MiB / 12 SQLite / 256 MiB free-reserve preflight apply to sibling window directories, retained reports and explicitly kept evidence. Deliberately selecting different environment-level managed roots, direct writers that never call this helper, old package controllers and build outputs are outside this scope; this is not a machine-wide storage quota. Do not change the managed root per run to evade quota.

```powershell
$env:WEWE_TEST_OUTPUT_ROOT = 'E:/CodexTemp/wewe-guarded-tests'
node scripts/local-release/rehearse.cjs --release <reviewed-package> --output-root E:/CodexTemp/wewe-guarded-tests/window-a
```

Each run creates an exclusive fresh audit directory, nonce-bound root owner lock and `run-manifest.json` **before** starting SQLite generation. The original source is outside the fresh audit and is never registered for cleanup. A successful `begin()` records synthetic file identity. `checkpoint()` records additional disposable SQLite files in this owned audit directory; adapters should call it after creating copies and before long async work. Regular `finish()` checkpoints current-run SQLite files and removes them by default, including opt-in real-source copies and all case variants/SQLite sidecars. Existing files outside this fresh audit, links and replaced registered identities are not removed. Failure details are limited to 4 KiB, with a small manifest and summary retained. Explicit `keep` retains evidence under the cumulative root budget; exceeding that budget at finish removes only current-run registered copies and reports failure. Kept evidence has no automatic expiry or historical deletion policy: reaching quota blocks further generation for manual review.

If the owner is forcibly killed, no in-process helper can guarantee its `finally` runs. After stopping and verifying **only that run's** known children, use the explicit recovery tool:

```powershell
node scripts/local-release/recover-test-run.cjs --root E:/CodexTemp/wewe-guarded-tests --audit <exact-audit-from-manifest> --confirm-children-stopped
```

Recovery never kills a process. It refuses an active/reused PID, mismatched token or manifest, changed audit/file identity, links or an outside path. It checks all registered paths before deletion, removes only recorded run-owned SQLite, writes a small recovery summary, then releases the matching stale owner lock. Unknown/uncheckpointed SQLite is retained and the owner lock stays blocked for manual review; a kill during fixture generation can therefore leave a conservative review case. A separate recovery lease prevents overlapping recoveries. Report-only files and old sources/recovery points remain untouched. No automatic SIGINT handler that could delete a database under a still-live runtime child is installed; cooperative controller `finally` and verified post-termination recovery are the supported cancellation paths.

New offline regression gates cover default cleanup of opt-in copies/case variants, sibling-root contention and cumulative copy/byte refusal, explicit keep, junction refusal, hard-kill recovery and retry, live/reused PID refusal, foreign owner token, replaced file identity, unknown-file preservation, owner-lock changes and environment restoration. All fixtures remain small synthetic data and each test removes only its own new temporary root.

Remaining integration recommendations: checkpoint copies in rehearsal adapters before lengthy child/runtime work; add explicit shared test root/lease to resume; connect export temp/media outputs to bounded lifecycle; enforce package quota before `cpSync`/compiler output and clean only the failed build's fresh output. These are not claimed fixed by the helper patch and no deployment or push is performed by this window.

## Coordinator integration

The coordinator integrated both independent commits and added checkpoint calls after rehearsal copies, guarded legacy resume before spawn, and bounded HTML-export lifecycle (4 MiB HTML / 8 images / 256 MiB reservation, current image downloader 10 MB per image). Release builds now serialize a cumulative .local-releases budget (768 MiB, 4 GiB free reserve), conservatively estimate the full dependency closure before generation, recheck stages/final output, and remove only their own identity-verified failed directory. These adapters are separate from the original review evidence above. Forced termination before a checkpoint, unknown files and changed identities remain manual review cases. The guard scopes participating writers; it is not an OS filesystem quota. No production activation or historical file deletion is included.

## Release package lifetime and existing installations

A self-contained package intentionally pins its own Node executable so startup and rollback do not depend on a mutable machine-wide runtime. Previously `build.cjs` used a new timestamp directory on every invocation and `copyFileSync(process.execPath, release/runtime/node.exe)` created another runtime. Successful packages were never retired: only a failed invocation's owned output was removed. Whole-package installation copied that runtime again into the installation root. The cumulative build quota was not a retrospective cleanup policy, and there was no completed-package count limit or verified-candidate reuse.

### Separate generation and installation boundaries

The build workspace now permits at most three direct package/output directories, a cumulative 768 MiB default across the entire build root, and a 4 GiB post-allocation volume reserve. Registered helper caches and `worktrees` do not consume a package slot but their regular bytes still consume that **build workspace** quota. Unknown/interrupted outputs occupy slots. A reservation for two outputs must use `begin(root, bytes, { packages: 2 })` and register both new direct directories. Exhaustion refuses generation; it never evicts existing output. Inventory limits and early over-count/byte rejection prevent an unbounded historical scan.

Before compiling, the builder can return an existing package only after exact source commit, source-input hash, layout, schema compatibility, Node version and runtime SHA comparison, complete byte/metadata verification and absence of an active build claim. Repeated attempts at the same frozen candidate return the same directory without another Node copy. Corrupt or mismatched packages are preserved and rejected.

An existing production `.local-releases` root can also contain source worktrees, nested build history, helper caches and historical installed packages. It is incorrect to apply the build root's three-output count or cumulative byte quota to that composite directory as though every entry were a live installed role. `install-lifecycle.cjs` therefore provides a distinct installation protocol. It admits the **current running package, one verified compatible rollback and one frozen candidate**, at most three distinct package IDs and **768 MiB total regular-file bytes across those roles**. It checks actual volume free space before and after allocation, including rounded new-file/directory/link overhead, with at least 4 GiB left. All files on the volume, including historical packages and worktrees, affect that physical reserve. This does not raise a threshold, turn the budget into a per-package quota, or relabel historical bytes as freed space.

The first adoption requires the exact reviewed list of existing historical installed IDs outside those roles (`adoptLegacy`, at most 128 IDs). Detection is shallow and bounded: a direct directory with `release.json` or `runtime/node.exe` is an installed artifact; nested worktree/build outputs are governed by their own generation root. `.release-lifecycle.json` freezes this legacy list and the managed role IDs. Legacy packages remain held, physically present and unavailable for implicit promotion. The baseline cannot grow on subsequent attempts. An unknown new installed artifact is rejected. Any previous managed role that drops out of the next three-role plan but remains on disk causes `RELEASE_RETIREMENT_APPROVAL_REQUIRED` before copying. It cannot be silently absorbed into legacy history. After a separately reviewed and approved exact retirement, the next bounded round can proceed. No retirement/delete command is included here.

Thus an old installation can temporarily hold its fixed historical backlog plus the three managed roles. It must not be reported as having only three physical runtimes. The backlog remains a separately inventoried storage debt pending explicit disposition; no automatic deletion or ever-growing exception is permitted. Missing source provenance or unreadable Git objects require preservation and review. Shared read-only, content-addressed runtimes are a possible later change and are not implemented here.

### Reviewed installation protocol

The release owner freezes a private JSON plan before execution. All three proofs must contain the expected 40-character `sourceCommit` and SHA-256 of the complete `release.json`, derived from the independently verified packages. The existing active pointer must be format 1 and match `current`. Candidate and rollback paths refer to existing frozen packages; nothing is rebuilt or downloaded.

```json
{
  "root": "<existing production .local-releases>",
  "plan": {
    "current": "<active-package-id>",
    "candidate": "<absolute frozen-candidate-path>",
    "rollback": "<absolute frozen-compatible-rollback-path>",
    "proofs": {
      "current": { "sourceCommit": "<40 hex>", "manifestSha256": "<64 hex>" },
      "candidate": { "sourceCommit": "<40 hex>", "manifestSha256": "<64 hex>" },
      "rollback": { "sourceCommit": "<40 hex>", "manifestSha256": "<64 hex>" }
    }
  },
  "adoptLegacy": [
    "<each exact historical installed id outside the three roles>"
  ]
}
```

After separate approval of the concrete plan, only the production owner runs:

```powershell
node scripts/local-release/install-lifecycle.cjs --plan <reviewed-private-json>
```

The module has no service, SQLite, backup, process-kill or network operation. It serializes cooperating writers using the same owned `.build-budget.lock`, fully verifies source and existing target manifests/files/links, refuses mismatched targets, and reuses exact already-installed outputs. It persists the exact managed intent before copying so a terminated copy cannot become a new legacy baseline. An incomplete existing copy fails verification and requires review. It checks frozen proofs, active pointer and owner again before completion. Ordinary failure removes only this invocation's new identity-verified directories; a changed owner, active pointer or any changed output identity preserves output for review. It never overwrites a target or deletes a historical package. The caller retains responsibility for the already approved protected upgrade backup, schema compatibility acceptance, controlled switch and rollback protocol.

Installing this host tooling does not change the frozen application candidate. Its tooling SHA and CI evidence must be reviewed separately; it does not authorize rebuilding, changing the approved application SHA, deploying, restarting or deleting real history. Existing handwritten installation scripts must call `installPair(root, plan, options)` (or this reviewed-plan CLI), replacing the incorrect `buildBudget.begin(compositeRoot, pairBytes)` and whole-package `cpSync` path; merely importing the helper while keeping the old installer is insufficient. Nonparticipating historical scripts remain outside the protocol and must not be used for future releases.

Offline fixtures cover 28 tiny historical runtime copies, three-role accounting despite unrelated worktrees, immutable legacy adoption, refusal of unretired/unknown output, a fixture-only separately approved retirement, repeated reuse, frozen proof mismatch, cumulative byte/free-space exhaustion, failed-copy cleanup, replaced identities, concurrent active/lock changes, interrupted partial copies, internal/escaping aliases, and the actual plan CLI. They copy no real database or production package and execute no copied runtime.
