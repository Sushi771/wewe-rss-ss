# Redbook independent private handoff security review (task18)

Reviewed production source: `ff1049a9ee3ca513d6e4b9872a65bb2b390b863a`.
Isolated worktree: `E:/CodexValidation/task-18-redbook-security`.
Task18 owns only `redbook-task18-security.spec.ts` and this report; no task8 edits.
Independent fixture SHA256: `2e001634599a0e6f3f0afd07a2ddee4c03fac87c77f08a32a9fd4a3d2c6deffb`.
The fixture was untracked while executed and is included in this patch commit.

## Findings and resolution

The previous source `fab97a792271bf7341383ea92a2424aec74d7317` accepted non-Host URL components (`evil@localhost`, path, query, fragment) because URL parsing repaired Host input. It also accepted `x-forwarded-port`, `x-forwarded-path`, and `x-forwarded-prefix` despite the runbook requiring all forwarded headers to be rejected. The independent regression reproduced all seven failures (39 total tests, 32 passed, 7 failed). Actual loopback socket, password, and matching Origin checks still applied; no remote authentication bypass was demonstrated.

The main owner fixed both rules in `ff1049a`: raw Host grammar permits only localhost/127.0.0.1/[::1] with an optional legal port, and all forwarded/x-forwarded-\*/via header names are rejected. Independent regression of all seven cases passes on the new source.

No additional reproducible defect was found in the reviewed session/identity scope. Credentials enter only through explicit backend POST JSON, remain in memory for at most two hours, and status never returns cookies, evidence payloads, or signatures. Revoke clears the cookie object, aborts the session, and blocks an in-flight handoff using the epoch check. Default runtime status is unconfigured with platformVerified:false and liveValidation:pending.

First binding requires the exact expected stored profile URL, explicit operator attestations, matching list/detail author and note IDs, and reference text/image/time values. Arbitrary author IDs without evidence are rejected. Existing creator/author conflicts are checked and the database has a unique external author constraint. Binding supplies reviewed operator evidence, not independently authenticated platform proof.

Production HTTP transport has no host/baseURL/fetch-injection switch. Only the two fixed read endpoints and allowed media hosts are used. Local socket bridges exist only in specs. No publish/comment capability is exposed.

## Verification

Final canonical-path run: **3/3 suites, 81/81 tests passed**, exit code 0, Jest 26.758 seconds, Node 24.11.1. This consists of 39 independent task18 tests and 42 original runtime/HTTP tests. Independent test ESLint passed without --fix. Source SHA and fixture hash above identify the exact tested inputs.

The independent suite covers direct socket/auth/Origin restrictions, exact private-route bypass boundaries, all forwarded header variants, malformed Host, default pending status, list/detail/profile/note/reference/age mismatch, absent review, Cookie CRLF/semicolon injection, missing cookies, expired/overlong TTL, caller host injection, duplicate author, arbitrary author ID, revoke memory clearing, and profile mutation before dispatch.

The original runtime/HTTP suites additionally exercise actual Nest/tRPC refresh, synthetic local HTTP responses via spec-only native HTTPS socket bridges, synthetic SQLite, PNG archive/save/deduplication, local handwritten file preservation and missing-image repair, author conflict, cancellation during installation, multi-author expiry/revoke during final commit, persistent 406 stop across session/runtime replacement, redirects, byte limits, and account-free media headers.

Historical runs are retained separately: initial test harness compile error (0 tests), old-source failing regressions, and the new-source first attempt with 81 passing assertions but an unsafe-fixture-cleanup hook failure caused by slash-normalized TEMP. The latter is not a passed suite; canonical Windows TEMP was used for the final rerun without modifying the tested source.

Evidence: ignored `output/task18/security-fab97a7.result.json`, `security-ff1049a.result.json`, `security-ff1049a-canonical.result.json`, corresponding logs, and `network-guard.cjs`. An external-network blocker was preloaded; no blocked-attempt log was generated. Synthetic SQLite/temp artifacts remain only under the isolated E worktree. Dependencies are junctions, not copied files. E artifact usage was below 20MiB, well below 512MiB.

## Narrow integration contract and remaining boundary

Existing `GET /local/redbook/status`, `POST /local/redbook/session`, `POST /local/redbook/revoke`, and `POST /local/redbook/resume-operator` remain owned by the main integration thread. Session body and operator evidence schema are documented in `REDBOOK_RUNTIME_HANDOFF.md`. Nest uses one shared RedbookRuntime instance for the controller and XHS_SOURCE.

No real credentials were read, stored, created, or used; no platform requests, login/authorization, production DB/media access, deployment, merge, push, or remote CI occurred. This review establishes local mechanisms and synthetic flow only. Real API/schema/full-text/image completeness/publication-time semantics and platform signing acceptance remain unverified. Explicit user credential handoff and scoped live evidence are still needed before declaring the source ready for real testing. Node 20/22 execution is not covered by this Node24 review.

## Linux 集成补记

原报告的测试提交、SHA256、Node24 日志仍按原记录保留。后续 task13 集成在 GitHub Node20.16/22 离线矩阵发现两项生命周期用例硬编码 Windows E 盘路径，Linux 正确拒绝该非绝对路径；只将合成 DATABASE_URL 改为系统临时目录下的原生绝对路径，不改断言、生产模块或真实数据库。当前集成 fixture 的新哈希与最终 SHA 验收由 task13 最终报告另列，不能使用旧 fixture 哈希表示修订后的测试。
