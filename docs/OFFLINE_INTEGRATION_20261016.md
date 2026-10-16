# Offline integration on the deployed PR46 baseline

This candidate starts at production commit
`45a3942a8cc56b29e53f66e11aef4acd2f6d101e`. It is development code only: no
deployment, service restart, production configuration change, live backup,
retention execution, or manual provider refresh was performed. The next Shanghai
09:15 natural update remains a separate production observation.

## Selected changes

| Source                                                  | Included scope                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR40 through `687323db6c1b6dccfc1f14ecf87fe287df15074a` | Nine export/media commits: preserve incomplete-media state, validate legacy coverage against the cached body, preserve handwritten content and partial paths, and retain strict download failures outside cached exports.                |
| PR41 through `d63e42aa852f96dfe59f7454ab92ad8b7f75c34b` | Twelve history-preservation commits, including their owner/runtime dependencies, bounded browser cleanup, and sanitized synthetic diagnostics.                                                                                           |
| PR39                                                    | Only `77b1fb14ecf29ca4d5471d70b6e074c0626b6520`, `bdfaad6`, `b99b78b`, and `db1a5c86d826a7d991487d7e7b6ce6b1be7cf8c2`: verified periodic snapshot reuse and explicitly approved bounded rotation with serialized protection publication. |

PR39's unrelated installation/publication/controller changes were excluded. The
only release-builder change adds the history runtime scripts to the existing
package copy list; the deployed baseline's cumulative budgets, output reuse,
reservations, and cleanup rules remain intact. No schema migration, dependency
manifest, lockfile, or frontend source change is required.

## Integration fixes

- Preserve periodic snapshot failure/recovery events while allowing the larger,
  explicitly enabled history-review response. A real-owner regression exercises
  ordinary writes with history review both disabled and enabled.
- Recognize the production producer's exact `.space-budget-status.json` schema
  as capacity telemetry. It supplies no references or authority. Its identity and
  content remain in the review digest; changes invalidate an exact approval.
  Extra fields, invalid values, and other unknown JSON records are still refused.
- Load the actual coordinator's extensionless TypeScript dependency graph in the
  Node integration test with the project's installed compiler. CI installs the
  actual dependency graph and checks the actual server types on both platforms.
- Preserve lazy loading after explicit maintenance opt-in with Node's
  `createRequire`, satisfying the application's lint contract without changing
  the reviewed runtime path or starting maintenance at boot.

## Validation

Windows offline integration results:

- Full server Jest: **135 suites / 2025 tests passed**.
- Synthetic backup, guard, retention, and history Python regression: **183 tests
  passed**, with real offline browser checks required.
- History browser and actual Node coordinator integration: **26 tests passed**,
  including six consecutive real offline browser runs and three actual owner
  IPC/archive/review/approval runs.
- Server typecheck with no output and the explicit backup-call policy passed.

The first combined run retained a browser connection failure and a native Node
TypeScript-resolution failure. The latter was corrected in the test harness;
the browser code was unchanged and passed subsequent serial verification. Do
not erase those earlier diagnostics or describe that first run as successful.
The previously reviewed 170-second real deadline evidence is not claimed as a
new measurement in this integration.

Final lint/format checks and CI are recorded with the integration commit. Local
logs, screenshots, fixtures, databases, and raw diagnostics remain outside Git.

### Classification browser CI follow-up

On integration commit `4870ecf`, [classification attempt 1](https://github.com/Sushi771/wewe-rss-ss/actions/runs/38935626175/attempts/1)
passed the six component browser tests, then failed in the rename test with
`Inspected target navigated or closed`. [Attempt 2](https://github.com/Sushi771/wewe-rss-ss/actions/runs/38935626175/attempts/2)
failed before the cache-status test's business assertions: Chrome did not publish
its debugging port within the existing ten-second limit. Five other browser
tests passed; rename was not reached. The stderr bus messages do not establish
resource contention or prove the cause of either failure.

Local delayed navigation/reload probes did not reproduce the CDP failure. A real
browser regression did reproduce a separate lifecycle gap: the fixture returned
before its own browser's exit was confirmed. The fixture now waits for graceful
exit, then terminates only its own child if needed and confirms exit. Normal and
assertion-failure paths are covered. Existing startup and business-assertion
limits remain unchanged; there is no retry. Failures now retain phase, CDP method,
bounded stderr and child exit state so a future failure can be classified without
guessing. This fix does not claim either original failure's root cause is proven.

The follow-up on `60d44e8` reproduced the rename CDP error with Chrome still
running, during a test `Runtime.evaluate`, after all seven component/lifecycle
checks passed ([run 38938827420](https://github.com/Sushi771/wewe-rss-ss/actions/runs/38938827420)).
A local delayed-script regression then reproduced the synchronization gap:
`Page.reload` returned before the new document's script completed, and the next
evaluation read an undefined fixture. Navigation and reload now enable Page
events and wait for the new load event before allowing the next command. The
existing ten-second command bound remains; no failed command is retried. This
addresses the demonstrated navigation gap. The earlier one-off Chrome startup
timeout still has no proven resource-contention cause.

## Release limits and remaining risk

This is not production deployment approval. No production deployment credit was
reused, and no new release package or dependency copy was generated.

History review remains an explicit internal maintenance API with both opt-in and
maintenance-window checks. Its result is not permission to delete files. Periodic
rotation retains its current single-source producer protocol, fixed protection
manifest requirement, exact approval binding, and refusal while a guard is
active. These are separate phases; this integration does not automatically
quiesce a guard, join approvals, or enable a timer to rotate production files.

Unattributed references, changed protection records, unknown JSON metadata,
missing browser evidence, or incomplete coverage continue to hold the operation.
An export with missing media remains partial rather than becoming a successful
complete export. A future deployment must preserve the existing database and
configuration and separately verify its live behavior.
