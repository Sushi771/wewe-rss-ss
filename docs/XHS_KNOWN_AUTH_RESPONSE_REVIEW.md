# Known-response authentication recovery

Status: **Validated only with isolated synthetic data. Installation, exact-commit CI and real-platform acceptance are separate release checks.** WeChat collection is unchanged.

## Normal connection flow: verify first, then clear

An explicit local **encrypted save and connect** or **restore saved session** action can now perform one bounded authentication check when there is exactly one eligible known-response authentication failure. Startup auto-restore, status reads, page polling and memory-only connection do not trigger this check. A normal saved-session restore does not require extracting or rewriting credentials.

The service reuses the existing exact scheduled-task proof. It requires one basic task whose single `profile:1` request received a response and ended with the authentication code, empty results and no outstanding source operation. It checks the original task, creator/author, ledger, policy, retained historical baseline, runtime session origin and healthy vault policy. Unknown requests, verification/rate restrictions, changed policy, new unknowns, active work or an ambiguous target remain blocked.

For this eligible event:

1. Keep the original blocked authentication risk row unchanged. Do not clear it merely because a session was connected or restored.
2. Create one finite derived request review and started ledger, persist its source receipt, and reserve one request under the existing budget limits. No limit or recurring policy is increased.
3. Permit only the original creator's one profile through a server-owned in-process capability bound to the exact current session. Normal scheduled, list, detail, media, comments and replies do not inherit this exception.
4. Require a valid profile response and author identity, then atomically save the profile/metrics, checkpoint receipt and response ledger, append the success audit to the original task, and clear only the exact original authentication risk.
5. While still holding the existing exclusive SQLite write coordinator, read the exact clear version and recheck the same session before clearing the in-memory pause. No later fallible proof is placed after that memory change.

The existing pending natural schedule cannot get ahead of this verification. It may proceed under its unchanged policy after successful verification. The old blocked task and old round are never replayed. One successful profile does not claim that notes, images or an entire scheduled round have been collected.

## One event, one request

The finite review identity derives from the original task, original response operation and full original risk, not from a new login time or session binding. Any durable outcome consumes that event: started, response-received, unknown or not-sent. Double clicks, another connection, restart and a lost acknowledgement cannot repeat it. There is no automatic retry.

A later genuinely new authentication failure is a different event, not a retry of the original one. This implementation handles the exact scheduled known-response shape only. A failure of the verification request itself is retained in its own ledger and is **not** automatically converted into another eligible scheduled event after another login. Further recovery for that distinct shape requires a separately reviewed path; historical evidence is never deleted or relabelled to enable it. A later scheduled authentication event may also remain blocked by the existing strict check of earlier authentication-task evidence, even when that earlier task has an audit. This release does not add a historical-authentication exemption or promise unlimited automatic recovery after future logins.

## Failure semantics

- A known HTTP response remains `response-received`, including local parsing, author-identity or storage failure after the response. A newly observed authentication, verification or rate restriction replaces only the exact original risk by CAS.
- A transport result with no confirmed response is unknown. Local failures and unknown outcomes retain the original authentication pause and the consumed durable request evidence.
- A failed successful-checkpoint transaction rolls back profile changes, audit and risk clear together. Durable started evidence remains conservative if terminal storage cannot be confirmed.
- Lost commit acknowledgement is recognized only by the exact expected full audit, task document/time, terminal receipt and request ledger. Partial matches or unreadable evidence return unconfirmed with no retry and do not rewrite a possibly committed terminal receipt.
- If the profile checkpoint committed but final runtime refresh failed, the API does not claim that this running session is restored. It never reissues the request or clears a different risk.

## Removed intermediate API

The unpublished intermediate `prepareKnownResponseAuthReview` / `confirmKnownResponseAuthReview` and post-clear `prepareKnownAuthProfileProbe` / `confirmKnownAuthProfileProbe` HTTP routes have been removed. They are not offered as a way to clear this pause before verification. Their internal helpers remain only for offline regression coverage. Normal encrypted connection and explicit saved-session restore are the new product path.

Long-standing unknown-response, generic-risk and full-history manual review APIs keep their original exact evidence and confirmation requirements. None accepts a known response relabelled as unknown, and none is presented as this automatic authentication recovery.

A formally retained full-history annotation does not by itself make an old restriction new. The known-response preflight can reverse only that exact annotation and its SQL timestamp in memory, after verifying the complete retained review lineage, bindings, digests and time order. The resulting row must still match the original generic-risk review fingerprint; the unchanged current document is independently scanned for live restrictions. Missing evidence, changed fields, new restrictions and unknown outcomes remain blocked. This recognition neither changes historical rows nor proves platform authentication. Only one real profile response successfully persisted through the normal explicit connection/restore path can clear its corresponding original AUTH pause.

## Storage, audit and session proof

No schema migration or new persistent generation is introduced. The finite request-review row follows the established scheduled-review inheritance convention: its `original_outcome=unknown`, root risk and backup SHA refer explicitly to the unchanged historical root policy evidence. They do not describe this known authentication failure or claim a newly created backup. Its separate scope identifies the current known response, exact event/session and one-profile authorization.

The original blocked task gains at most one `knownResponseAuthReviews` entry after successful verification. Its state, code, taskFailure, schedule, updated_at and all other original fields remain unchanged. The audit retains `originalTaskRaw`, full original risk and evidence digests. The new flow records `authenticationVerified=true`, one source request, its finite grant, receipt digest and `profile-checkpoint-before-auth-clear`. The old metadata-only review continues to record verification false and zero requests/grants.

This is application-level append/CAS protection, not database-level immutability. Stale task persistence cannot erase or forge the audit, and resume/enqueue cannot copy it into a new task. The public task view does not expose the audit.

Fresh replacement proof must be strictly later than both the original risk and task terminal time. The known-only restored-saved origin is generated only after successful normal vault load and non-expired policy checks. Restore time is not presented as a new login or platform-verification time. Binding, origin and the two policy booleans must remain consistent. The existing unknown-response review still requires its original fresh-replacement proof.

Manual restore checks policy before loading and before adoption, preserving current memory on failure. Legacy saved sessions missing a policy are marked expired on an authentication failure; absent saved sessions do not create a policy file.

## Coordination and backup boundary

The normal connection verification uses existing exclusive SQLite coordination across the finite request, incremental-write transactions, final checkpoint and memory refresh. Database identity, disk-space and journal/synchronous durability checks remain active. There is no whole-database backup call, no fake receipt/hash and no no-op backup claim. Normal journal/WAL, audit and lock writes still occur.

Control-state proofs inspect admission/recovery controls and creator identity/enabled mappings, not note bodies, videos, comment bodies or bulk archive content. The success transaction checks the exact own-review/ledger/receipt/budget delta and original controls before changing the original task/risk. Source budget limits and the recurring schedule policy remain unchanged.

## Offline validation

Tests use existing migrations, synthetic identities, genuine isolated SQLite transactions and injected synthetic HTTP only. External fetch is forbidden. Coverage includes original AUTH remaining intact during transport, success checkpoint ordering, wrong identity/session/policy, new unknowns, HTTP failures, parse/storage/CAS rollback, lost acknowledgement, exact receipt proof, duplicate actions, independent concurrent writers, saved restore versus startup, future natural admission and old-round closure. Tests also assert zero backup calls. Final counts and exact commands accompany the reviewed change set; local synthetic results do not imply production acceptance.

## 本地检查点失败后的单次恢复

正常连接验证使用独立的 30 秒数据库事务预算，保留全部会话、来源风险和原子提交检查；其他写入仍使用默认预算。Windows 安全会话状态查询的启动耗时不会再被错误地当作 5 秒内必须完成的本地保存。

仅当上一验证已收到 HTTP 200、到达检查点、明确因本地存储失败回滚，而且原认证暂停、任务、完整控制状态和已用预算均可精确核对时，下一次明确的“恢复本机会话”允许一个固定的后继资料验证。旧请求和回执永久保留，已用预算不退回，不自动重试；后继再次失败后不继续。未知结果、认证/验证码/限流限制、解析失败、已提交结果或状态变化均不适用。收到 HTTP 200 不等于认证恢复，只有资料保存和对应认证审计原子提交后才解除暂停。
