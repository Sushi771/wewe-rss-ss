# 单次恢复与导出中断反馈

整号同步中的历史请求没有完整回执时，任务继续保留未知状态。对于有可验证请求所有者、符合来源风险门和原预算约束的正文或指标请求，可以由用户明确确认，准备一次有期限的补取。准备本身不请求来源；实际执行还需要该笔记的官方分享链接和第二次明确确认。

恢复范围从持久任务、作者和累计预算派生，不接受客户端指定作者、阶段或用量。任务预算、共享预算、阶段额度、来源风险、订阅状态、会话和未决请求条件在执行时重新检查。存在其他未解决的恢复时，准备、消费和实际来源请求入口均拒绝；只有与原记录的笔记和作者身份精确匹配的完成记录才能证明该恢复已结束。

本次恢复与原未知请求分别显示结果。正文、指标和本次回执在同一事务提交；提交前中断会回滚业务写入，已消费的尝试仍不能重发。提交成功后即使客户端丢失响应，重新读取任务也能看到本次已保存结果。原请求不会因另一请求成功而被改成成功，也不会清除原未决记录或重置累计用量。明确来源限制会保留固定原因并停止；图片、评论和后续整号任务不自动执行。

缺少可验证所有者的历史任务保持暂停和未知。准备超过有效期后拒绝执行，不自动续签、重置或替换尝试。真实来源、真实会话和安装路径需要独立验证；合成测试不证明这些路径已经通过。

批量导出遇到无效回执、响应丢失或回调异常时，会保留已确认的数量和用户选择，停止后续批次并给出中断反馈。获取导出范围失败时不提交保存。重复点击只启动一个批次序列；不自动重试可能已经发生的保存。已有文件、修复结果和原位置编辑状态仍使用既有分类说明。

对应合成回归位于 `xhs-product-recovery.spec.ts`、`xhs-reviewed-attempt.spec.ts`、`xhs-whole-creator-ui.test.cjs`、`export-interruption-ui.test.cjs` 和 `export-article-batches.test.cjs`。测试覆盖未决恢复的各状态、消费后的竞态、身份不匹配的完成记录、预算变化、提交边界中断、重启、重复点击和导出停止行为。
# Whole-creator continuation from a reviewed legacy unknown

Generation failures now retain a bounded, fixed-field receipt for transport entry, local send completion, HTTP response, parsing, storage and checkpoint stages. Only allowlisted codes, numeric HTTP status and at most twelve stage events are stored; headers, bodies, URLs and access tokens are excluded. Each physical request has its own sequence so an earlier successful response cannot label a later timeout as received. A local storage failure and a known response remain distinct from an unconfirmed network outcome. Old records without receipts are not backfilled.

Receipt persistence captures the source-group entry context before dispatch. Native callbacks must not reuse the expired incremental-write admission of a completed dispatch transaction: every receipt still obtains its own incremental, coordinator and transaction checks. The real PrismaService raw-query middleware is included in the SQLite flow regression. Local transitions after a successful source checkpoint retain a separate bounded stage/code failure record without changing that checkpoint's outcome.

Before opening a business storage transaction, the runtime drains its preceding source observations. This prevents a successful checkpoint from deleting the active fence before its response receipt is persisted. The checkpoint's own observation is queued without waiting inside the transaction, avoiding a receipt/business-write lock cycle.

A saved generation profile binds the public author identity across restart. Inside the same explicit generation, a restored session can reuse that identity with the list client's existing empty/default optional share parameters; no token is invented or persisted and no extra profile request is needed. Existing valid memory access options are retained. The normal list endpoint still performs the real access decision under its original phase, budget, risk and owner-bound fence. A refusal or verification stops the run without fallback or repeated profile probing. Note access tokens are obtained only from actual validated directory responses. Profile collection time and metrics already saved by its checkpoint are reused instead of fetching them again.

A paused generation may explicitly review its own active unknown, then separately confirm continuation on that same generation. Review preserves the complete old fence and marker in hashed history and keeps cumulative budget floors. The owner must be observed stopped, or the same process must hold an exact bound settled receipt. A dispatch-persistence failure does not attest quiescence (including unread media streams), so its current owner must be stopped before review. Known platform restrictions block review even when their risk-row update failed. No review schedules work. Generation phase usage is committed before the final dispatch transaction and cannot disappear when a later transaction fails after transport entry. Late observations cannot overwrite a terminal receipt or the next request's status.

A successful single-note retry does not resolve the original unknown or unlock a whole creator. A legacy job with a matching persisted maintenance proof can instead prepare an explicit generation on the **same job and cumulative budget rows**. Preparation does not dispatch. A second explicit confirmation starts or resumes the generation; duplicate submissions and application restart never schedule it automatically.

The original fence, marker, unknown outcome, phase counters and consumed task/shared counts remain. The generation binds an immutable snapshot of that origin and its maintenance proof. Each admission transaction validates this binding and may exclude only that exact retained marker. The generation has its own owner-bound active fence; its commit or no-start cleanup cannot remove the original marker. Other pending work, unresolved recovery, a changed creator, or a stronger source restriction still blocks dispatch. Late receipts must match generation, owner and marker.

The supplied official homepage/share URL follows the existing bounded redirect and profile flow. Each physical redirect/API/media transfer consumes its normal local safety allowance. The returned profile must identify the existing creator before its checkpoint commits; no replacement subscription or invented access token is accepted. The normal directory flow then obtains note access contexts from actual returned pages. On an explicit continuation, memory-only contexts are rebuilt through that same homepage/directory flow. A platform refusal, verification, expired session, or unknown dispatched result stops the run. Restrictions persist across restart; no alternate transport bypasses them.

Only a positively completed directory determines the current returned membership. Cached notes not returned by that directory are recorded separately as missing, with their existing body/files retained; absence does not prove deletion. Confirmed archive, metrics and local-save receipts are reused on continuation, including a companion saved by the archive child. Settled old child selections remain unchanged: a fresh child selects only current directory members still lacking positive receipts and reuses the old save directory. Active children block that handoff. Detail and metrics admission recheck current directory membership, even if an old token is still in memory. An unknown response or rolled-back business checkpoint retains its consumed counts and active fence. Counts here are local request safety counters, not evidence of supplier billing. Comments body collection remains off; the existing detail response may supply comment counts.

Offline regressions: `xhs-whole-generation.spec.ts`, `xhs-whole-generation-flow.spec.ts`, and the generation interaction cases in `scripts/xhs-whole-creator-ui.test.cjs`. Real account/session/platform behavior and full accessible coverage still require the installed application test; synthetic success is not that acceptance.

