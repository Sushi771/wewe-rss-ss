# 自动增量任务与正文缓存恢复（2026-10-13）

本次修复针对两条互相独立的故障：单个更新提交异常令整个批次暂停，以及关闭图片下载后新文章只入列表、已有上游正文未保存。默认上海 09:15、14:00、17:30 三时段和 00:00–05:59 外部提交静默不变。

## 队列行为

- 真正发起提交后的未知结果只隔离该公众号。其他尚未提交项和已受理的缓存检查继续；未知公众号跨时段仍不会重复提交。
- 提交前的账号读取、备份或本地预留失败明确记录为未提交。后台最多尝试三次，60/120 秒退避和计数写入原任务账本；重启保留计数，独立项不等该项。
- 老版本整体暂停的未知批次自动恢复独立项，不清除未知标志。后台每分钟只读核本地提交预留账本：仅原订阅仍存在、未被重建且预留早于批次时，才能证明原流程没有进入提交并恢复该项。当前或较新的预留不等于回执，继续保持未知。
- 已知共享登录/平台验证限制仍保留暂停和官方验证提示。停止按钮、跨实例标记、互斥锁、30 秒全局间隔、午夜未提交项过期均保留。
- 批次“completed”表示处理结束；仍需查看逐项 succeeded/blocked/failed，不能将它当作全部新文或图片完整。

## 正文与图片

缓存监听先导入真实列表，再独立保存可用正文。文字通道禁用图片请求，始终经过原身份校验、备份和保护性合并；图片开关或媒体安全停止仅影响图片通道。已完整正文保持原值，空缺才补入，不覆盖手写内容。

失败的显式原文重试只更新重试记录，保持原正文编辑水位，避免状态记录自身阻止自动补缺。请求失败保留固定的 timeout/connection_refused/dns/http_status/network/invalid_response 原因及合法 HTTP 状态码，不保存错误原文、签名 URL、Cookie 或响应正文。

## 今日已核事实与限制

09:15 批次实际14项成功，新增5篇均有正文；14:00 批次第二项暂停前的本地预留仍是上午，提交前备份留下0字节文件。异常发生于提交前准备阶段，却被旧版统一误标成未知回执；现存日志没有保留底层错误，不能声称已确证具体磁盘 errno 或 HTTP 超时。

用户指定文章在上游私有缓存已有正文。对这一篇缓存离线跑原解析器得到2884字正文和21张图片；禁用所有图片请求后正文仍保留、图片标为待补。生产当时关闭媒体通道，旧监听器将正文也挡在该通道中。此前已失败重试改变了该行更新水位；本篇恢复需按准确来源身份受控补缺，不能按同标题匹配。

离线回归覆盖300项中一项未知、其余299项继续、跨时段未知去重、并发互斥、重启、持久退避、原文诊断去敏、正文编辑水位和媒体关闭时文字保存。代码通过不代表生产部署或17:30真实执行已完成；部署及恢复结果须另记实际证据。

# Follow-up review: slot persistence and SQLite runtime

Production recorded `Active refresh round deferred` at Shanghai 17:30:07 on
2026-10-13, with no corresponding 17:30 durable batch. The old scheduler drops
rounds after the 17:30 minute and does not retain failed acceptance. Its catch
discards the concrete exception, so the historical log cannot distinguish the
feed-list query failure from worker-lock contention. A small production
read-only query did independently return `database is locked`.

Observed same-day intents are now synced to disk before DB acceptance. All
state read-modify-write operations, including completion cleanup, share a short
critical section; acceptance runs outside it. Deterministic tests cover a 17:29
callback paused after its state read while 17:30 arrives, worker-lock failure,
17:31 retry, restart, quiet hours and no unobserved evening replay. Existing
durable queue intent deduplication and unknown-submission isolation remain.

The installed generated client reports engine commit `605197…`, but the actual
compatible DLL returns `5a9203…`. Release manifests and startup diagnostics now
read the native DLL version directly. A DLL-only upgrade is unsafe: the newer
engine with the existing client fails raw queries with `e.map is not a function`.

An isolated real SQLite experiment with two concurrent deferred read-to-write
transactions and a separate read-only backup reproduced the production
`quaint.rs:167` panic using the default pool (0/8 operations succeeded, 2
panics). The same compatible client/DLL with `connection_limit=1` completed
8/8 operations, without errors or panics, while nine read-only backups
succeeded. The runtime now applies this limit in memory before loading Prisma;
disk configuration stays unchanged. A bounded real-SQLite positive regression
is included in CI, alongside the native-engine audit checks.

Initial feed-read failures preserve `accepted:true` in the cache stage and can
never authorize upstream resubmission. Only a pre-submission failure is safely
retryable. Historical unknowns require current committed reservation evidence
before being cleared; a database lock alone does not prove their requests were
never sent.
