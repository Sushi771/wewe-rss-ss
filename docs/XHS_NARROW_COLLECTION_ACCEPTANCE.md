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

Scheduled clock observations may also read an exactly bound, settled basic
task marked `XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED`: its row and document must
both be partial, failed and remaining must both be zero, and historical
exclusions must be present. This observation creates no task, session binding,
review or request budget. It lets the runner proceed to the existing media and
later-creator checks without reopening basic collection or retrying excluded
notes. Active or new unknown source work and other failure protections remain
unchanged. The round remains incomplete, and synthetic observation regressions
do not establish complete live collection or cross-session continuation.

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

## Cross-platform identity fixture correction

The writer gate already identifies a Linux process using its boot UUID and
kernel start ticks. The legacy maintenance validator now accepts that exact
existing format as well as the previous Windows forms; holder comparisons,
executable and command hashes, and quiescence observations remain required.
The test preparation helper observes `/proc/self` on Linux instead of returning
no identity. Windows still uses the existing native observation tool.

Local checks passed 16 identity-fixture cases and 50 legacy maintenance,
controller, and project-adapter cases. Synthetic Linux cases reject a changed
boot, ticks, PID, executable, malformed command bytes, and a conflicting cached
identity. Actual Linux execution remains subject to the exact candidate's CI;
these local results do not establish a passing full CI or installation.

## Provider and AppModule fixture alignment (2026-11-07)

The bounded Wechat2RSS response and prepared-refresh tests now provide the
real persistent source gate with explicit temporary SQLite databases. Failed
response scenarios use independent fixture gates; service restarts within a
single subscription test retain their pending gate. The subscription transport
also supplies a valid synthetic RSS response for optional avatar reads. Its
previous missing route incorrectly left the real source gate pending and
caused later cases to stop before their intended requests.

The assertions follow the current bounded failure contract: HTTP 429 remains
a source-wide restriction, ordinary HTTP errors retain their status, and an
oversized article body preserves proved article metadata with BODY_TOO_LARGE.
An uncertain request remains durably pending, including after service restart;
the tests retain no-replay, no-native-fallback and no-secret-disclosure checks.

Startup middleware now receives an owned SQLite file and real writer lease
instead of relying on an ambient DATABASE_URL. The browser opt-in and recovery
hold AppModule fixtures use actual PrismaService instances and migrated,
isolated SQLite schemas required by the newer local recovery hooks. The hold
fixture uses the real startup guard and verifies unchanged database bytes,
directory entries and queued-state content with zero outbound fetch calls.
App shutdown, Prisma disconnection and writer-lease closure complete before
fixture cleanup. No platform requests or production database/backup access
were used; any snapshot checks operate only on owned temporary fixtures.

Local targeted Jest results on Node 24.11.1 / Windows:

| Suite                                 | Passed | Existing skipped |
| ------------------------------------- | -----: | ---------------: |
| wechat2rss-response.spec.ts           |     17 |                0 |
| wechat2rss-prepared-refresh.spec.ts   |      8 |                0 |
| wechat2rss-restriction.spec.ts        |      5 |                0 |
| subscription-source-selection.spec.ts |     39 |                0 |
| startup-audit.spec.ts                 |      9 |                0 |
| browser-task.opt-in.spec.ts           |      9 |                0 |
| recovery-hold-app-integration.spec.ts |      1 |                1 |

These seven suites passed 88 tests. The recovery-hold HTTP case was already
skipped in the baseline; this change adds no skip and does not claim that case
passed. Prettier, scoped ESLint and diff whitespace checks passed. These scoped
results do not establish a passing full CI, Linux execution or installation.

### UI 与媒体导出 fixture 的有限归因证据

UI 的 6 个目标 suite 共 74 个用例分批通过。修正仅涉及过期测试合同：VM 加载真实官方原文 URL 校验与共享选择控件；文章列表按现有 container 布局、官方原文链接和共享排序验证；小红书批量操作按现有持久批次与回执推进验证。原有选择、禁用、取消和完成回执断言保留。模块注册及 recovery bootstrap 在当前候选原样通过，没有为旧日志盲改产品。

媒体/导出 4 个目标文件共 67 条业务断言通过。其中 article-export-status、article-local-layout、wechat2rss-single-download 三个完整 suite 共 45 个用例通过。前两者原失败来自缺失测试自有 DATABASE_URL，导致真实媒体安全锁按设计默认关闭；现在使用临时文件绑定，未 mock 掉安全锁。严格单篇下载明确断言 WECHAT2RSS_SINGLE_IMAGES_UNAVAILABLE、无 Markdown 发布、源缓存不变、私有错误不泄露及无原文回退；没有将媒体失败放宽为成功。

channel-routing 的完整 22 条业务断言通过，包括解析正文与实际 PNG 附件字节核对，但本机 Windows 在套级清理时仍返回临时数据库 EBUSY。已调用并 await 测试自有服务的生命周期关闭返回（该方法停止 continuation timers），Prisma disconnect 已 await；有限重试与有界清理时间未解决文件锁，未杀进程或绕锁。因此该 suite 仍是清理环境阻塞，不能记录为完整 suite 通过。锁的实际持有者尚未证明，若需继续应只读识别本测试及其原生数据库子进程的文件句柄。

以上为定向、合成来源和临时输出证据，不代表完整 CI、真实平台采集或生产安装验收通过。

## XHS request safety and fixture isolation

The scheduled review reader casts only `approved_at` to text for Prisma's
SQLite INTEGER decoder. Ordering still uses the original numeric column and
ID. The request admission projection now includes the review ID required by
the existing exact-binding check. Tests cover 9, 10 and a real millisecond epoch,
wrong review rejection, and a correctly persisted started receipt.

Repeated observation of an exactly bound completed task, or an exhausted
article-local partial task with an explicitly allowed code, grants no new
review, request budget, session binding or work. New unknown evidence, wrong
bindings and unsupported partial outcomes remain blocked. Synthetic terminal
observations verify unchanged review, request and budget rows.

Bounded reviewed-context transport starts after the entry transaction commits.
A fresh database reader rechecks the durable stage, marker, owner, unresolved
requests, writers, budgets and source risk before transport. Missing readers,
failed commits and failed readers stop before sending; consumed charges and
attempt markers are retained. Port tests prove this ordering and failure
control flow. A separate real SQLite bounded-context case changes durable risk
after entry commits and verifies zero subsequent API calls; port assertions
alone are not represented as durable database evidence.

A typed detail identity mismatch is article-local only when the runtime can
prove this operation's exact review/task/creator/target receipt was settled as
`response-received`, with all durable source-risk restriction fields clear.
An older settled response cannot substitute for the current operation. Reader
failure, an unknown outcome or a changed binding preserves the ordinary stop.
Session generation and restrictions are checked again after the reader awaits.

The risk fixtures now create and destroy a separate migrated temporary SQLite
database per case. Immutable review history is retained throughout each case;
no audit deletion or guard bypass is used to isolate subsequent tests. The
scheduled Redbook suite passed all 17 cases, retaining same-account continuation
after a proved article-local parse failure, cross-account continuation, and
source-wide stops for uncertain or restricted responses. Every synthetic GET
and POST remains charged, including failed requests. No workflow changes or
new test skips are included in these XHS corrections. Complete candidate CI
and production installation remain separate acceptance results.

The complete risk and original-link group passed 185/185 tests across
`xhs-source-risk-store.spec.ts`, `xhs-p0-source-risk-full.spec.ts` and
`xhs-original-link-access.spec.ts` in the normal isolated test environment.
This includes the existing scheduled-comment and repeat-observation assertions;
restricted-environment runs are not counted as candidate validation.

The exact detail-receipt regression passed 15 synthetic control-flow cases
using the real runtime catch path and a synthetic reader/admission port. It
checks current-operation binding, unknown and risk refusal, reader failure, and
session/restriction changes across the await. It does not represent a second
real SQLite integration result. The separate scheduled-read SQLite regression
also passed its epoch ordering, actual admission and terminal-observation
checks.

The same expired writer-admission cause was reproduced in the single reviewed
request path. Its operation now begins after entry commit and a fresh durable
reader, with exact consumed/entered document and pending-marker snapshots.
Existing creator, owner, risk, unresolved-recovery and writer checks remain;
legacy schemas retain their original conditional subscription-table access.
Successful single-request checkpointing preserves any longer existing cooldown
and applies at least a full interval after the received response. Unknown or
failed requests retain their consumed permit, charge and unresolved marker.

### Settled scheduled media observations

Scheduled media can settle with `needs-review` when existing local images have
no matching durable saved receipts. This is not a completed download and must
not be silently retried, assigned fabricated receipts or treated as verified.
The existing adoption, media dispatch, unknown-outcome and source-risk gates
remain unchanged.

The review reader now permits read-only observation of an exactly bound,
exhausted media partial task. It requires unique nonempty note IDs, matching
per-note results and item states, consistent totals, zero failed/remaining
items and an allowed code matching the results. Empty or malformed results,
unknown/failed states, wrong bindings and new unresolved evidence stay closed.
Observation creates no review, source request, budget or session binding; new
work still passes the existing round-session and authorization checks.

Synthetic migrated SQLite regression coverage includes both allowed partial
codes, repeated runner observations reaching later creators while retaining
an incomplete round, unchanged persisted tasks and unchanged
review/request/budget rows. Negative cases cover malformed results, inconsistent
counts and codes, wrong task/creator/round/batch, source fences/unknowns and
cross-session new-work rejection. This is offline control-flow verification,
not evidence of live media recovery or later creators completing collection.

The runner still stops when the comments or local-archive stage reports an
incomplete outcome. The recurring policy currently grants profile, list,
detail and media phases only; a comment capability flag is not an approved
comment/reply request budget. This observation fix does not extend that policy
or claim end-to-end continuation through those later stages.
