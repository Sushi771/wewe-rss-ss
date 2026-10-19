# Startup audit and release readiness

No startup runtime change is proposed. Static inspection and five tiny-fixture
rounds did not establish another startup bottleneck worth changing. This audit
does not authorize a merge, restart, deployment, new backup or production write.

## Frozen runtime candidate

| Order                                                   | Exact source                               | Evidence                                                                                 |
| ------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Deployed source                                         | `8a3141c43b1b09e92ebd75780f26c58939557906` | Active package manifest; startup bundle matched its manifest and candidate source.       |
| [PR71](https://github.com/Sushi771/wewe-rss-ss/pull/71) | `4862fd3a7d7a11a20e783454c7ecd317d7060237` | Compatible adaptation; CI39153667797, five checks passed.                                |
| [PR72](https://github.com/Sushi771/wewe-rss-ss/pull/72) | `7a99f2c6e003b1ecf029e61f0d2031b05c05afaa` | Export stages; CI39155631490, five checks passed.                                        |
| [PR73](https://github.com/Sushi771/wewe-rss-ss/pull/73) | `6b7afe8fb7ef84f22684601cd088487c3de3904f` | Final runtime candidate; CI39158750199, five checks passed, server2308 passed/2 skipped. |

Preserve `8a -> PR71 -> PR72 -> PR73`. PR70 is the reference implementation on
a different base; do not add it again. This documentation-only audit is separate
from that tested runtime SHA. No new release artifact was built.

## Actual startup paths

- Desktop shortcut uses WScript/VBS, then `desktop-start.cjs`. Its progress UI
  and dependency preparation run concurrently and drain both results. Docker
  readiness can wait up to120s and container health up to60s; those are bounds,
  not measured elapsed times. Even `--check` can prepare dependencies, so it was
  not invoked against the installed application.
- The logon task calls `logon-start.cjs start`. A matching running release uses
  one ownership discovery and an HTTP probe; this reuse path does not stop the
  server, preflight SQLite or create a backup.
- With a free port, the controller performs a schema-only startup gate. The
  child runtime verifies its package, repeats the gate after the process boundary,
  then runs pinned-engine metadata/count preflight before Nest starts. These
  repeated gates close different race windows; they are not duplicate full-body
  scans. Keep the fixed engine and `connection_limit=1` policy.
- Nest listens before starting the background audit. The audit worker checks
  integrity/foreign keys and schema, then writes a baseline receipt. Despite
  legacy names containing "backup", this current audit creates no database copy.
  Cached reads remain available while writes are gated. Periodic snapshot
  ownership starts only after successful audit and retains its existing policy;
  that later owner may create a recovery point.
- A controlled restart is a different path: it calls backup protection before
  and after the identity-checked stop. Verified equivalent snapshots can be
  reused, so two calls do not prove two newly copied databases. Do not bypass
  these gates to improve timing.
- Package verification can reuse an identity-bound verification receipt, with
  strict hashing on a miss/change. New candidate readiness still requires the
  existing full20-item check; reduced1-item checks require a matching earlier
  acceptance receipt.

The installed host controller checkout and active packaged source are different
layers. Read-only inspection found an older host checkout with substantive
controller differences, while the active startup bundle matches the candidate.
Do not overwrite that checkout or assume its HEAD names the running package.
The release owner must explicitly resolve compatibility using the existing
release workflow before switching packages.

## Bounded measurements and limitations

Five sequential Windows rounds, one self-created143360-byte SQLite database,
40 articles/2 feeds, no production database access, no backups. Quantiles use
the median and nearest-rank P95 (the maximum with n=5).

| Stage                                                 | P50 ms | P95 ms |
| ----------------------------------------------------- | -----: | -----: |
| Strict verification, synthetic100-file/100KiB package |  49.75 |  54.21 |
| Cached verification, same tiny package                |  52.57 |  64.68 |
| Controller schema gate                                |  26.83 |  32.92 |
| Child schema gate                                     |  24.69 |  26.98 |
| Prisma metadata/count queries plus disconnect         |  27.38 |  90.14 |
| Background audit to ready                             |  80.21 |  84.91 |
| Parent timer during audit                             |   1.05 |   2.30 |
| WScript -> Node stub, including marker receipt        | 444.52 | 620.65 |

These are separate stages, not a full cold-start sum. Prisma construction is
outside its timer; the first preflight includes cold engine work. The WScript
stub never starts Docker or Nest. Each audit used one worker, created only its
baseline JSON and left the synthetic database hash unchanged. Own temporary
fixtures were removed. The small cached-package case is not evidence that
receipt reuse speeds up a real package containing large native binaries.

Existing startup-audit/readiness tests passed25/25. Targeted cached-read/write-gate
tests passed5, with3 explicitly unselected tests, including the real snapshot
owner case. No production startup command or large-backup test was run.

Export and reading evidence remains in
[export stages](EXPORT_STAGE_PROFILE_20261018.md) and
[reading responses](READING_FIRST_RESPONSE_20261018.md). In particular, the
controlled300ms batch wait was removed for summary/body reads; ordinary browser
opening did not show a clear overall speedup. Neither those warm synthetic
measurements nor this startup audit proves a universal150ms target.

Still unmeasured: installed host-controller identity overhead, real Docker cold
startup, full Nest startup under production I/O/pool contention, background audit
on production data, and exact new-package stop-to-ready downtime.

## Recovery and one production approval scope

Read-only metadata inspection found an existing periodic recovery file and its
receipt. Source file identity/size/times matched the current database metadata;
the receipt records successful integrity verification and a digest. No backup
bytes were rehashed, restored or opened as a database in this audit. This is a
candidate recovery point, not a newly certified restore test. The recorded
capacity forecast is not a fresh free-space guarantee. Private machine paths,
receipt identities and runtime audit evidence remain outside Git.

No schema migration is introduced by PR71-73. Reverting application code should
not require restoring an older database, but any later user writes or Vault
changes must survive rollback. A release approval should cover these existing
workflow operations together, with one production owner:

1. Select the exact complete candidate above; resolve host-controller/package
   compatibility, build/verify the artifact and check real capacity.
2. Revalidate and protect the existing recovery point and retained rollback
   package. Allow only the backup calls required by existing release policy;
   stop on insufficient capacity rather than deleting history or weakening gates.
3. Quiesce relevant work, perform the ownership-checked stop/package switch/start,
   verify readiness, and roll back through the existing workflow on failure.
4. Check cached list/summary/body, startup write gates and approved background
   schedule after deployment. New retrieval, configuration changes or actual
   content mutations need their own explicit scope.

Running-instance reuse has no stop interval. A real switch includes post-stop
recovery protection, process startup and readiness before service resumes; this
audit provides no trustworthy numerical downtime bound. Cached reads may become
available before the background audit opens writes. None of the four production
steps above was performed in this audit.
