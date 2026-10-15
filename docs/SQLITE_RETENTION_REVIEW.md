# SQLite recovery-point maintenance

Ordinary incremental refresh uses transactions and durable receipts, with no full snapshot per item or round. See [incremental refresh safety](INCREMENTAL_REFRESH_SAFETY.md). Timed backups keep their current interval. High-risk operations retain an independent verified backup. Single and bulk feed deletion use the same protected backup gate and one cascading transaction; see the linked safety document for concurrency and identity checks. This replaces the earlier 15-minute shared-round recovery design; that design is removed from the implementation.

## Finite budgets and business impact

Production recovery generation defaults remain 32 GiB, 48 copies and 4 GiB free physical space. Declared legacy roots count toward the same budget; aliases are deduplicated and cycles rejected. This PR does not expand global limits, change production configuration, remove a real backup or deploy anything. Full recovery quotas can prevent the next timed/high-risk backup and produce an alert, but do not stop ordinary refresh or routine startup. Actual source-volume shortage still blocks a write safely.

The planner reads recovery metadata and bounded file content, without requesting platform data or modifying subscriptions, articles, images, metrics or groups. It never deletes, moves, archives or restores a database. The optional scanner runs after server listen, fails independently, and defaults off. Registered scanner reports alone rotate to at most three files of 256 KiB each; unknown files and approval documents are never automatically collected.

## Explicit opt-in retention policy

Without `SQLITE_RETENTION_POLICY`, unique historical points remain held for human review. An explicit JSON policy enables a bounded selection proposal, not deletion. Defaults are a target of 48 ordinary points, latest two, minimum one hour, one point per two-hour bucket over the recent 24 hours, daily coverage for seven days, weekly coverage for four weeks, and a maximum ordinary age of 28 days. The legacy `roundDays=7` field applies only to old producer-marked write-before points; current ordinary refresh creates none. Mandatory time windows take priority over the count target, producing an alert if they exceed it.

Only same-source, structurally valid producer-marked ordinary periodic/write-before receipts are eligible. Unknown/unmarked legacy files remain held. Current owner/latest references, newest same-source recovery, explicit protected paths, deployment/migration/identity/manual boundary names and high-risk `recoveryOrigin.kind=protected` receipts are always protected. A high-risk backup may reuse only another verified protected point with fully equal schema and typed rows; it cannot silently borrow an ordinary periodic point that rotation might retire.

A `retention-protected.json` manifest uses format `sqlite-retention-protected-v1` and an explicit `paths` array (at most 256) within declared roots. `SQLITE_RETENTION_PROTECTED_PATHS` also accepts an explicit JSON path array. Source data must remain outside all recovery roots. Newly written high-risk verification receipts contain the protected producer marker; old boundaries must be identified conservatively during release review.

Warnings cover byte/count pressure, mandatory windows exceeding target, physical headroom, reserve-copy threshold and projected retention headroom. Projection uses a configurable expected generations/day value, not a claim about measured production growth. Check the actual periodic interval when selecting it: for example a 15-minute interval generates up to 96 points/day. Warnings never authorize deleting unique history or blocking all subscriptions.

## Read-only planning and action-time validation

Run `python apps/server/scripts/sqlite-retention-plan.py --database <source> --backup-root <root>` from an isolated maintenance context. It reads at most 64 MiB in ten seconds by default and bounds entries/directories; insufficient proof is held or rejected. The server opt-in uses `SQLITE_RETENTION_SCAN_ENABLED=1` and an interval from 3600 to 86400 seconds, default 3600. The script, backup helper and resource query helper can also be inspected/run independently without deploying the server.

Every proposed exact batch binds paths, file identity, actual hashes, representative recovery point, root/reference inventory and policy digest. Before a separately authorized irreversible action, validation requires an exact approval no older than five minutes and a successful empty Windows Restart Manager resource report no older than 60 seconds. Unique expired history additionally requires explicit `uniqueHistoryPaths` approval. Replaced files, new owner/protection references, changed policy/inventory, sidecars, active ownership, resource query failure or changed hashes reject the action. Validation rechecks the retained representative with SQLite quick_check and never performs the deletion itself.

Do not turn a validated list into recursive directory deletion or wire the planner to a timer that deletes files. Any real deletion/move/recycle action still needs an exact current list, independent recovery review and the user's specific authorization. Development build/dependency/cache directories are outside this database planner; no broad cleanup command is provided.

## Recycle-bin limitation

Windows exposes recycling through IFileOperation, but undo is conditional and may be held only for the Explorer session. `SHQueryRecycleBinW` reports current size/count, not a guarantee that a particular large file can be restored. Recycling has not been implemented or demonstrated as a recoverable retirement action here, and is not counted as freed physical space. No recycle, restore or empty-bin operation is part of this PR.

References: [operation flags](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags), [recycle-bin query](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shqueryrecyclebinw), [aborted-operation check](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-getanyoperationsaborted).

## Verification and rollout boundary

Python tests cover finite tiers on tiny SQLite fixtures, protected high-risk receipts, exact unique-history approval, changed references/policy, bounded scanning, junction deduplication/cycles, active users and unchanged business bytes. TypeScript tests cover scanner isolation and periodic failure alerts. Native startup tests cover full quota with zero recovery copies, schema and integrity validation; backup tests retain pre-write refusal on exhausted budgets.

The release owner must review the exact CI-passing SHA against the then-current production commit, reconcile actual recovery inventory and protect upgrade/migration boundaries before any controlled release. This PR is development-only. It does not authorize merging main, force pushing, deployment, restarting services, global configuration changes or irreversible cleanup.
