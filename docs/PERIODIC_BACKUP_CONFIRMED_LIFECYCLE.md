# Bounded periodic backups with exact retirement confirmation

Development baseline: `aeb7483c85db8d13f1345011266ae7ee6046adc0`. This change is prepared separately from the current integration/production acceptance. It does not deploy, stop a service, read a production database, change machine configuration, or retire existing recovery points.

## Activation and compatibility

The new Windows lifecycle is explicitly enabled with `SQLITE_PERIODIC_LIFECYCLE_ENABLED=1`. It is off by default, so source installation alone must not be described as enabling the three-point bound. Keep `SQLITE_PERIODIC_RETENTION_ENABLED=0`: the new lifecycle refuses the old unattended deletion switch. Existing behavior remains available before lifecycle initialization; turning the new flag off **after** initialization holds periodic generation instead of restoring legacy allocation. Tagged copies also prevent readoption after accidental loss of both control files. No reset/resume endpoint is provided.

For the approved daily configuration use interval/max-age `86400`, regular-copy target `3`, and the existing finite regular-byte/read/staging limits. The implementation validates and freezes these settings in its initialization record. This change does not enable any of them in production. POSIX activation is refused before creating artifacts because the irreversible boundary uses the existing Windows object-handle implementation; existing default compatibility remains unchanged there.

## Physical copies and cadence

The count bound is **three normal periodic points plus at most one pending-confirmation point**, so at most four explicit periodic database files can exist in a new bounded cycle. It is not a claim that only three physical database files exist. The regular byte target may cause the pending state earlier. Protected upgrade, migration, write-before and unknown-origin files are separate, retained, and included in the same cumulative global caps. Existing default global limits remain 48 database files, 32 GiB stored bytes, and 4 GiB free reserve. The pending allocation has no exemption from these caps and has its own finite byte limit, including a conservative metadata allowance.

The fixed per-source `.init` and `.json` control pair binds the source/root identities, initial policy and state object. Each file is bounded to 128 KiB and remains in the same managed-byte accounting. The mutable state is opened by its actual Windows read/write handle, with replacement and other writes denied. Before replacing state bytes, truncate and fsync an invalid state; a partial common-prefix overwrite cannot restore the old valid allowance. Then write, fsync and read back the complete envelope. Initialization, copy intent, marker publication, copy verification, marker release and final state failures remain held. There are no alternate scope names or automatic reconstruction of missing/partial state.

Only receipts with explicit verified periodic origin are admitted; filenames alone never reclassify legacy files. Existing known points are hash/integrity checked. The last physical periodic start timestamp comes from the original copy receipt and is verified against the retained points. Fresh coverage, owner restart, reuse, retry and exact retirement do not advance that timestamp. Changed data before the next configured boundary gets `SQLITE_PERIODIC_NOT_DUE` and no fresh owner lease. Unchanged data can still pass an independent schema/all-typed-stored-row/integrity/hash proof and reuse the same file, including while a pending point exists. Stored generated values are part of this proof.

Copy intent is durably consumed before marker/copy I/O. A fourth verified file becomes the same fixed pending allocation; changed-source retries and restarts cannot produce a fifth. Unknown or partial copy/delete results do not acquire another credit. A source-object replacement, invalid control/receipt identity, extra untracked periodic point or policy change holds this lifecycle for explicit review. Preexisting explicit periodic counts above three also hold further copying; this version does not automatically reconcile historical overages. Never remove controls or retag historical files to bypass such a hold.

## Retirement uses the existing exact action protocol

Planning and validation remain non-destructive. The existing `sqlite-retention-plan.py --periodic-only` recognizes the current pending marker and binds the exact state/init digest, state object and pending identity into the plan. Only the oldest admitted normal point may be proposed, subject to all existing age, live-reference, protection-manifest and resource checks. The pending file is the precise recovery representative, including when creation timestamps tie.

An example **review policy**, not production authorization, is:

```json
{"maxOrdinaryCopies":3,"maxOrdinaryBytes":4294967296,"keepLatest":2,"minimumAgeHours":1,"roundDays":7,"recentHours":1,"bucketHours":1,"dailyDays":1,"weeklyWeeks":0,"maximumAgeDays":365,"warningPercent":80,"reserveCopies":2,"expectedGenerationsPerDay":1}
```

The operator must separately review the exact plan and supply the existing short-lived approval binding its batch/digest/action, database paths, receipt paths, directories and unique-history paths, plus a fresh bound resource report. `--batch`, `--approval` and `--resources` validate without deleting. Only separately approved `--execute-periodic` executes that exact action. It acquires the full-snapshot and owner lifetime OS locks; this is not a service-stop endpoint. Existing activation owners must separately arrange an approved maintenance window. Missing protection manifests, unknown reference publishers or occupied files continue to refuse execution.

Approval never waives preservation: every durable old typed row, note, body, metric and stored generated value must remain covered. Two distinct verified recovery points remain, and the existing native executor pins data, receipts, directories and reference publishers. The retirement intent is fsynced/read back before the delete call. A partial or unknown result holds the consumed record; a new approval cannot replay it. On complete exact retirement, the same pending file is promoted only if both normal count and byte targets are met. Otherwise the same allocation remains pending for another separately reviewed exact action. It cannot allocate a replacement pending copy. No data is moved into an unbounded archive.

## Status and business effect

Owner IPC includes a finite, path-free lifecycle status and failure code. A not-due/held owner does not manufacture a lease from disk metadata. Product diagnostics explain pending confirmation and incomplete operations, and show the actual configured 15-minute/24-hour cadence in capacity estimates. Node/Python forecasts use `headroom * interval / 86400`, distinguish continuously changing data from unchanged reuse, and retain the existing hard ceilings. These estimates describe global space, not authority to bypass the separate pending gate or a guarantee of future successful copies.

Ordinary additive collection remains on the existing incremental path. Startup audits, protected replacement/migration operations, and other callers requiring protected recovery retain their existing gates; a shared pending marker can defer a new protected copy. This patch neither disables all subscriptions nor promises every write is permitted while storage/recovery evidence is held. Resolve the exact pending action or evidence gap through the production owner; do not enable unattended deletion to clear a warning.

## Owned synthetic verification

`python -m unittest discover -s apps/server/scripts -p test_periodic_lifecycle.py -v` covers persistent daily boundaries, repeated real owner CLI restarts, unchanged complete reuse, one fourth/no fifth, configuration downgrade, missing/changed controls and origin, copy size limits, partial state writes, durable-intent crashes, real marker/state pin contention, release/save interruption, explicit exact retirement and promotion, denial/reference changes, separate notes/generated values, partial native deletion, and replay refusal. Tests create only tiny owned temporary SQLite files. Existing backup/retention/lease regressions remain applicable. Node budget tests compare 900/86400 forecasts; product tests cover safe status and cadence text. The Windows CI job runs the new lifecycle fixture. Local and remote results must be tied to the delivered head SHA before activation is considered.
