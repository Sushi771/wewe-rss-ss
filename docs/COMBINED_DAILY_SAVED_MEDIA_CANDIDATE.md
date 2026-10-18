# Combined daily-backup and exact saved-media baseline

This candidate combines production base `aeb7483c85db8d13f1345011266ae7ee6046adc0`, PR55 head `91c37aab51eb5ea196f9406f7f78549b833ea8b4`, and PR57 head `b7eb2796afa68a004db1af68f483dceeab3fe75a`. The two changes have no overlapping runtime files. Beyond that union this branch adds only bounded combination tests, CI registration and this handoff. It has no schema migration. Automatic missing-media discovery and scheduling belong to the separate implementation that will start from this frozen baseline.

## Single upgrade and recovery-copy impact

Prepare one combined program candidate before any approved production stop. Rebind the existing read-only activation proposal to this exact candidate, its package/raw pins and a lifecycle-aware rollback package. No production activation is performed by this integration work.

The existing current-schema startup audit allocates no database copy. If the approved upgrade/preparation path requires a fresh full-state recovery point, an older point that differs in claims or any durable row cannot be asserted reusable. Budget and approve that protection separately. The actual native `prepareStart` synthetic fixture creates exactly one protected point, then the real Python lifecycle owner fully verifies and reuses that same point without a second database copy. This is conditional evidence for that path, not permission to switch audit modes or a promise every production start creates zero copies. Failure recovery remains separately bounded and approved.

Once the combined service is running, exact saved-media writes use the existing incremental coordinator and transaction. They do not create a full backup. The crossed real-Prisma/Python fixture verifies five writes, no-op reentry, concurrent/failed CAS rollback, no network call, no new recovery file, and no lifecycle-state mutation. Restart with changed source inside the existing periodic boundary returns `NOT_DUE` without a fresh lease or another copy. Turning off the flag after initialization holds allocation; it does not restore the old allowance.

`SQLITE_PERIODIC_LIFECYCLE_ENABLED=1` remains explicit; retain the fixed daily/count/read/staging settings and unattended-retention switch `0`. After initialization an old aeb-only rollback cannot be assumed to understand the new controls. The already tested PR55 head is a lifecycle-aware business rollback reference; preserve the controls, data and policy, and recheck its actual package/startup/DB compatibility. Never restore an older database or delete controls to make a rollback appear compatible.

## Existing downloaded bytes

The media RPC accepts only up to five distinct stored IDs through existing authentication, local-control and startup gates. The administrator binds a canonical private flat resource root and the raw SHA256 of its strict UTF-8 `manifest.json`. Article original identity and current body hash, exact asset URL/basename/size/MIME/SHA and prior full-decode SHA must all match. Runtime container validation does not replace the prior full-frame decode evidence. All writes retain transaction CAS and explicit unconfirmed results for unsupported/missing media.

A separate private read-only structural inspection of the prepared cache found a flat layout and manifest fields compatible with this interface. It did not read image bytes or the production database, authenticate the operator's evidence, prove current-body equality, or execute a write. The production owner must freshly bind the current selected articles and configuration before one exact call. Keep the global media-off/stop controls unchanged; the verified cache is used without fallback HTTP on a miss. No real downloaded file is moved, copied or renamed by this integration.

## Limited verification

The saved-media suite adds two Windows cross-tests for actual Python lifecycle initialization/flag hold and real-Prisma incremental/CAS behavior, plus a six-ID rejection. Existing media/archive/incremental/collection suites remain applicable. `scripts/local-release/combined-backup-media.test.cjs` checks actual native startup audit/preparation, reuse by the actual Python CLI owner, and preservation of the lifecycle/media bindings through the existing runtime environment sanitizer. Its initial fixture incorrectly expected row counts from schema-only audit; that assertion was corrected, and the original failure log is retained. No runtime behavior was changed to pass the fixture.

Keep the combination draft and outside the current main merge. The next media implementation should start from the exact frozen combination commit rather than remerge PR55/57. CI of either parent alone does not substitute for the combination's own exact-head results.
