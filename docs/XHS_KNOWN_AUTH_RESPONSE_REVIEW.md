# Known-response authentication review

Status: **Service/router/runtime integration is validated only on isolated synthetic data. Production installation and real-platform acceptance remain separate release checks.** WeChat collection is unchanged.

## Why a separate confirmation operation

The existing connect/restore operations replace session memory but deliberately do not clear source risk. The existing authentication review covers an unknown profile request with a profile endpoint. This prototype instead covers exactly one scheduled basic task that received one `profile:1` response, ended blocked with the authentication code, and has no items or outstanding source receipt. It never relabels that response as unknown and never grants new request capacity.

## Storage and allowed changes

No schema migration is needed. A successful protected SQLite transaction changes exactly:

1. The original blocked task's document gains a single `knownResponseAuthReviews` entry.
2. The exact matching authentication risk becomes clear with the confirmation timestamp.

The task's state, code, taskFailure, scheduledContext and updated_at remain unchanged. Removing the new property yields the exact original parsed task. The audit also retains `originalTaskRaw`, preserving the original document bytes, including whitespace.

The audit records kind/version, plan/state digests and original-value transaction protection, task/creator/operation/request-review/policy identity, original risk including null fields, original request row, task/review/policy/budget evidence, runtime-generated opaque session binding and connection time. It fixes `originalOutcome=response-received`, `authenticationVerified=false`, `sourceRequestsSent=0`, and `newGrant=false`.

This is **application-level append/CAS protection, not database-level immutability**. `persistIn` rejects forged or altered audit entries and changes to the old reviewed task. A stale identical task snapshot without the audit becomes a no-op, preserving both the audit and updated_at. View/resume/enqueue prevent replay or copying that audit into a new task. The public task view does not expose the audit.

## Proof and transaction boundary

- Preparation only reads. It uses the runtime's own replacement-session reader, never client-provided binding JSON. A fresh replacement must be strictly later than both risk time and final task time, including same-millisecond rejection. A normally restored saved session is a separate known-only source, requiring explicit origin confirmation; restore time is never presented as new login time.
- The original task, creator, deterministic schedule ID, basic phase, round, exact authentication taskFailure, author context, empty results, single response-received ledger row and associated scheduled review/policy must agree.
- The existing reviewed baseline is checked without modification. Historical retained unknowns/fences/sourceActive stay unchanged. New unknowns, active work, changed evidence, policy revocation and other unreviewed platform restrictions reject the operation. Older authentication is retained only when it predates the policy and belongs to its exact retained unknown baseline.
- The state digest includes only admission/recovery controls: risk, tasks, whole jobs, request/review/source-receipt ledgers, budgets, legacy refresh controls, limited recovery and creator ID/author/enabled mappings, plus their schema. It never loads note bodies, video blobs, comments or metric content. The metadata writer provides exclusive write coordination, quiescence, authorization for that digest, installed-policy checks and the existing incrementalWrite database-identity, disk-space and synchronous/journal durability checks. The recovery does not require or claim a whole-database snapshot.
- Task append CAS and full-risk CAS are in one transaction. The risk CAS includes null-safe comparisons for every original risk field and EXISTS checks for the exact task document/time, request, review and policy. All captured control rows and schema are rechecked before commit, allowing only the exact appended document and risk transition. Session/policy/durability/quiescence failures roll back both writes. The synthetic test separately compares every table around these changes.
- The old round remains closed for all creators. A future natural round may use the unchanged policy and limits. Historical exclusions still apply; another unknown closes admission again. Confirmation itself does not enqueue, dispatch or catch up any round.

## Local product path and restart safety

1. Use the existing connection UI to connect or explicitly save a replacement session. Existing authorized auto-restore may instead load the saved session after a normal restart. The agent need not extract or rewrite credentials again. Neither path sends a source request or clears risk.
2. Call authenticated, local-only `prepareKnownResponseAuthReview` with the exact task/creator. It returns a read-only digest and `sessionOrigin`.
3. Explicitly confirm the exact task/risk/digest with `acknowledgedKnownResponseAuth: true` and `confirmedSessionOrigin` equal to the prepared origin. No client-provided binding is accepted. There is no automatic confirmation, new management UI, catch-up, budget grant or source dispatch.

The formal recovery is exactly two control-metadata row updates under `knownAuthMetadataWrite` exclusion and the existing durable `incrementalWrite` transaction. The exclusive coordinator stays held through commit and the final memory refresh. The audit retains original task bytes/all row fields and all original risk values. SQLite rollback protects atomicity; the old task remains blocked. The backup-call policy registers this exact entry with zero full-snapshot calls. No no-op backup hook, fake hash or receipt claims protection. Ordinary backup behavior is unchanged. Zero additional recovery copies does not mean zero filesystem writes: normal journal/WAL, audit and lock writes remain necessary.

There are two independently named session proofs:

- `fresh-replacement`: runtime-generated binding from explicit connection; its time must be strictly later than the failed task/risk. Memory-only replacement requires no saved record or an expired old record. Explicit saved replacement additionally requires same-binding successful save and policy read-back matching the selected auto-restore setting.
- `user-confirmed-restored-saved-session`: current-process opaque binding and in-memory origin established only after successful normal vault load and before/after non-expired policy checks. The user explicitly confirms this origin with the exact plan. Neither a healthy policy flag alone nor a recent restore time is proof of new or platform-verified credentials. Missing origin, changed binding or unreadable/expired policy rejects confirmation.

Both origin and explicit confirmation are bound into the plan/audit, with `authenticationVerified=false`. The existing unknown-response review still requires a fresh replacement and cannot use this restored source. No new persistent generation, saved credential record or mandatory repeated login is introduced.

Manual restore checks policy before load and again before adopting its result, retaining current memory on failure. `markExpired` writes/verifies expired policy for a saved legacy record whose policy was absent, but creates none when no saved record exists.

After commit, the helper checks exact audit/task/ledger/policy/session. The runtime reads the exact risk-clear version, synchronously rechecks binding and compatible memory risk, then clears memory with no later fallible proof. Result `confirmed-runtime-ready` still means authentication unverified, zero requests and no grant. A known committed audit with lost acknowledgement or refused refresh returns `committed-runtime-blocked` and `doNotRetryConfirmation=true`; the transaction is never repeated automatically. Normal restart can restore a valid saved session; expired old credentials remain blocked.

## Offline verification

Tests create fresh synthetic SQLite databases using existing migrations and synthetic IDs. All external fetch is forbidden; recovery-only tests reject injected transport, while explicitly authorized probe and scheduling tests use synthetic transport only. No real credentials are used. Tests retain their own temporary fixtures and do not delete backups.

The original core checkpoint passed 76 tests; the zero-backup integration checkpoint passed 14 suites / 224 tests before the optional one-profile addition. The integrated validation also exercises real protected coordinator exclusion, zero backup invocation with synthetic SQLite, rollback, lost commit acknowledgement and refresh failure. Final commands and counts are reported with the reviewed change set, not inferred from this checkpoint. No full build, remote CI or production recovery is claimed here.

The XHS offline workflow explicitly runs on the existing development head and PR base. Its XHS test selection includes the new core, service integration, session/vault and scheduling suites; separate steps include writer coordination and exact installer identity guards. The ordinary CI workflow also admits the existing development head. No workflow deploys or accesses real credentials.

The full scheduled-service/runtime test uses the real task admission and dispatch machinery with synthetic profile/list responses. All three creators complete a future natural basic round (six synthetic API calls); the old round produces zero calls. A separate real-admission negative case preserves the existing block for retained authentication sourceActive evidence. The large-archive test adds a 1 MiB body and 8 MiB video blob and proves neither is queried by preparation or changes its control-state proof.

Before considering production use, preserve the exclusive incremental transaction contract and verify the actual retained baseline against existing admission. A retained sourceActive with a platform-restriction code is still blocked by the existing scheduler, even when preparation can preserve its historical evidence. Tests must not treat lower-level request admission alone as proof that the full scheduled lane will run. This core is intentionally conservative and must not be broadened merely to accept an unsupported historical state.

## Explicit one-profile verification after recovery

The authenticated local-only `prepareKnownAuthProfileProbe` accepts `taskId`, `creatorId`, `authReviewId`, and `authDigest` from the committed known-response recovery. It reads the exact unchanged control state and current runtime session, and returns a new digest without writing or sending a request. `confirmKnownAuthProfileProbe` requires those four fields, that digest and `acknowledgedOneProfile: true`. The server derives the new review/task IDs from the authentication audit. Neither client-supplied session bindings nor extra collection phases are accepted.

This independent finite review uses the existing scheduled-review inheritance convention: its legacy `original_outcome=unknown`, `original_risk_json` and `backup_sha256` explicitly refer to the unchanged historical root policy, not the known authentication response or any newly created backup. The scope separately records `known-auth-profile-probe-v1`, the current audit's `response-received` outcome, exact saved/replacement session proof, creator/author, root provenance, and one-profile-only authorization. List, detail, media, comments, replies and automatic retry are disallowed. No new table, request limit or backup is created.

The review, started request, initial receipt, existing-budget increment and exact pending owner commit before transport. A private runtime permit and both admission/dispatch gates verify the exact review, request, still-admitted receipt, owner and control-state digest. Only that operation's own increment is normalized; another started/unknown request, changed policy, owner, creator, budget or session prevents transport. Any existing result consumes the deterministic audit-derived review, including not-sent and unknown. Duplicate clicks, new operation IDs and restart cannot authorize another request.

The existing canonical profile resolver performs one source request. Successful profile/name/metrics persistence, terminal checkpoint receipt, response ledger and exact owner finish share a transaction. `profile-saved` proves only that profile request and local checkpoint, not note/image collection or an entire scheduled round. HTTP responses remain `response-received` even when parsing/storage fails; the receipt records local failure and source remains pending. HTTP authentication/verification/rate restrictions block the source. Uncertain transport is unknown, proven no-dispatch is not-sent, and failed receipt/CAS or lost acknowledgement never causes an automatic retry or a false saved result. Old task/audit/history remain unchanged, and a successful probe leaves the next normal scheduled round under its original policy.
