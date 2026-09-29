# 移动 Refresh 恢复：离线准备与生产写入门禁

2026-09-30。本人现有移动凭据按一次[只读书架健康检查](MOBILE_SHELF_HEALTH_PROBE.md)请求 `GET https://i.weread.qq.com/shelf/sync`，得到 **HTTP 401、无业务正文**。这说明该次移动书架请求没有接受当前 `vid/accessToken`；它没有测试 `refreshToken`，也不等于列表权限、Web 搜索或旧 `/book/articles` 的结论。

[离线预检脚本](../../scripts/research/probe-mobile-refresh-preflight.cjs)仅提供 `--plan`、`--self-test`、`--preflight`，本身没有联网入口。总控已在生产 SQLite 上**只读**运行 `--preflight` 并确认备份、演练通过。随后复审[单次在线 runner](../../scripts/research/probe-mobile-refresh-once.cjs)，执行一次正常 Refresh；脱敏结果见下文。后续 Web 会话检查另行设计。

## 固定请求来源

- [`teng-lin/weread-omni@88bd2e0` `src/auth/token.ts:50-100`](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/auth/token.ts#L50-L100)从同一已登录设备的 `deviceId/refreshToken` 构造 `POST https://i.weread.qq.com/login`：`deviceName=BOOX`、`inBackground=0`、`kickType=1`、`refCgi/trackId` 空串、`deviceType=3`、毫秒时间戳、随机数 1–1000。[`profile.ts:294-311`](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/profile.ts#L294-L311)固定签名为 `SHA-256(timestamp + deviceId + random)`；[`device-ua.ts:275-312`](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/device-ua.ts#L275-L312)给版本头。离线脚本的 `refreshShape()` 只生成和自测这一固定形状，不发请求、不打印 body。
- [同一源码 `token.ts:163-244`](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/auth/token.ts#L163-L244)要求非空新 `accessToken`，显式 `vid` 必须与原账号相同；响应未给 `vid` 时沿用原值，未给 `refreshToken` 时沿用旧值；发生变化后调用持久化回调。独立 [`27Aaron/WeRead-Kit@4b02a4b` `refresh.go:24-100`](https://github.com/27Aaron/WeRead-Kit/blob/4b02a4b2d34355d425bf2b87ec3b924e98be29ee/internal/weread/refresh.go#L24-L100)也发同设备 `/login`，明确提醒 `refreshToken` 可能轮换且同账号不能并发刷新。以上是开源客户端一手实现，不是腾讯公开的永续授权保证。
- [旧实验审计](../WEREAD_CLIENT_FLOW_AUDIT.md#L24-L35)记录本人正常扫码取得此 `mobile` 对象，早先一次相同类型 Refresh 曾拿到新 `accessToken`；随后 `/mp/chapters` 仍 `-2041`。这次的待判问题是当前移动会话能否恢复，不能把刷新成功直接当取文成功。

## 离线预检怎样保护数据

`--preflight` 接受现有生产 SQLite 的绝对路径和**事先建立**的私有目录绝对路径；后者只能在本仓库忽略的 `private-data/` 内或本仓库外。Node 运行时须提供 `node:sqlite` 的 `DatabaseSync` 和 `backup`（当前验证机为 Node 24.11.1；[Node 官方 backup 文档](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackup-sourcedb-path-options)）。预检不接受账号 ID、token 或自造设备参数；它只从 SQLite 读账号 `LIMIT 2`，要求恰一条账号且同一个 `mobile` 对象内的 `vid/accessToken/refreshToken/deviceId` 均非空。

1. 以 `DatabaseSync(path, { readOnly: true })` 打开源库并设置 `PRAGMA query_only=ON`。调用 SQLite online backup API 在私有新目录创建 `original.sqlite`，包含 WAL 可见的一致性快照；检查备份 `PRAGMA integrity_check=ok`，并确认账号 token 与备份前读取的 token 一致。源库始终不写入。[SQLite 官方说明](https://www.sqlite.org/backup.html)界定 online backup 的一致性语义。
2. 另复制为 `rehearsal.sqlite`，**仅在此副本**的唯一账号 JSON 中把两项移动 token 改为假数据，以 `WHERE id=? AND token=?` 事务更新，随后复读 `mobile` 身份及设备字段，核验 `feeds/articles` 数量和完整性。`original.sqlite` 保持原始备份，不拿演练库当可恢复备份。
3. 在同一私有目录以伪造移动 token 演练恢复文件：独占 `wx` 创建临时文件、写入完整 `mobile` 对象、`fsync`、同目录 `rename` 成 `mobile-refresh-recovery.json`、复读核验，然后删除这个**仅含假 token**的演练文件。若将来实际写入在 rename 阶段失败，已 fsync 的临时文件必须保留；不能清理或覆盖。真实成功响应的持久化路径必须先完成并核验，才能继续 Web init/书架。Windows 的 POSIX `0600/0700` 只是尽力设置，私有目录还须由本人账户 ACL 保护。

命令形式；占位符不能直接运行：

```powershell
node scripts/research/probe-mobile-refresh-preflight.cjs --plan
node scripts/research/probe-mobile-refresh-preflight.cjs --self-test
# 总控复审后，方可用只读源库准备私有备份；仍无网络请求。
node scripts/research/probe-mobile-refresh-preflight.cjs --preflight --db <ABSOLUTE_DB_PATH> --private-root <ABSOLUTE_PRIVATE_DIRECTORY>
```

`--preflight` 返回私有运行目录、备份完整性和演练布尔结果，不输出账号 ID、token、token 哈希/长度、原始请求或响应。私有目录含**完整数据库备份与旧凭据**，不能提交 Git、分享或当作普通日志。失败时保留已创建的私有文件供人工检查；脚本不自动重跑在线接口，也不写生产库。

## 单次在线 runner：已执行一次

runner 仅在 `--execute --db <绝对路径> --run-dir <预检私有运行目录> --approved-online` 明确齐备时进入在线流程；`--plan`、`--self-test` 不读生产库、不联网。它先拒绝代理、`NODE_TLS_REJECT_UNAUTHORIZED` 和可能输出认证头的 `DEBUG/NODE_DEBUG/PWDEBUG/NODE_OPTIONS/SSLKEYLOGFILE` 等变量，再以 `readOnly + query_only` 打开生产库、`original.sqlite` 和 `rehearsal.sqlite`。三者均为恰一账号，生产账号 token 必须与预检原件逐字相同，原件与演练库 `integrity_check=ok`，订阅/文章计数一致，演练库仅含预期的伪造移动 token。任一门禁失败，**零请求**。

通过门禁后，runner 在预检私有目录独占创建并 `fsync` `mobile-refresh-attempt.json`；marker 已存在就不再发送。然后按固定源码构造同设备 `POST https://i.weread.qq.com/login`，Node `https.request` 使用 `agent:false` 直连，不使用代理、Cookie jar、重定向或重试；只有**一次** HTTP 请求。30 秒截止，响应最多 64 KiB。请求体、认证头、原始响应、凭据值及其哈希/长度均不打印。收到验证码、限流、HTTP 异常、未知业务码或账号不符均停止；不自动扫码，不自动调用 Web 或文章接口。

若可解析响应的顶层出现非空 `accessToken` **或** `refreshToken`，runner 先取这两个字段及合法标量 `vid` 放入私有恢复记录；即使是 429、验证码、其他非 200、业务失败、`vid` 不符或只收到新的 `refreshToken`，也要保存为**隔离**结果，不能投入使用。恢复记录还包含原 `mobile` 和按固定源码推算的候选对象，便于人工审查轮换；不保存原始响应体。它在私有目录以 `wx` 临时文件写入、`fsync`、同目录**独占硬链接**原子发布 `mobile-refresh-recovery.json`，复读逐字核验。失败时保留 fsync 的临时文件和内存记录，进程不退出，只每 5 秒重试**本地保存**；不重发 `/login`。执行期间拦截 Ctrl+C/终止信号，直到完成安全保存；强制杀进程或断电仍有不可消除的窗口。完整保存之后才输出脱敏决策，**不写生产 SQLite、不继续 Web 请求**。

```powershell
node scripts/research/probe-mobile-refresh-once.cjs --plan
node scripts/research/probe-mobile-refresh-once.cjs --self-test
# 以下占位路径不能直接运行；本次已使用私有预检目录且 marker 阻止重复执行。
node scripts/research/probe-mobile-refresh-once.cjs --execute --db <ABSOLUTE_DB_PATH> --run-dir <ABSOLUTE_PREFLIGHT_RUN_DIRECTORY> --approved-online
```

脱敏输出仅含 HTTP 状态、有限数字业务码、是否收到两种 token 字段、是否已保存、私有保存尝试数和 HTTP 请求数。响应过大、读取中断或非 JSON 无法可靠提取 token，立即停止且 marker 保留；这是残余风险，不据此重复消耗旧 `refreshToken`。运行前仍须确认没有其他进程同时刷新同一移动凭据。

## 在线阶段仍须满足的门禁

1. 在线前确认只有一个进程使用该 `mobile` 对象，先完成上面的私有备份和副本演练，并核对源 token 未被其他进程替换；清除可打印请求头的调试环境变量。请求只能沿固定源码**一次** `POST /login`，无代理、重定向或重试；遇验证、限频、异常或账号不符立即停止。
2. 若响应含新的 `accessToken` 或 `refreshToken`，即使 HTTP/业务码、验证码、限频或显式账号身份异常，也应先将候选值写入**私有隔离恢复文件**，标记不可用并停止；不能因为校验失败就丢弃可能已轮换的 token。没有新 token 的验证码/限频响应立即停止，不重试。响应未给 `refreshToken` 时按固定源码沿用旧值，显式空值进入隔离分支；显式不同 `vid` 不能覆盖本账号。只有 HTTP 200、无失败业务码、同账号且恢复文件完整复读成功，才可进入下一阶段。`vid` 缺席时开源代码沿用原值，但这只是隐含身份，下一阶段须保守标记。离线 `classifyRefreshResponse()` 已对这些分支用假响应自检。
3. 如果真实恢复文件写入失败，在线进程必须保留内存中的新 token 并只重试**本地持久化**，不得再次发 `/login`、退出后丢掉唯一可能有效的 `refreshToken`、写生产 SQLite 或继续 Web 请求。电源故障/进程崩溃发生在响应与第一次成功 fsync 之间的残余风险不能由脚本完全消除；执行前需确保私有目录可写及容量充足。
4. 生产 SQLite 更新属于**另一次**有备份的写库步骤：从已核验的私有恢复文件应用到 SQLite **副本**并校验旧文章与订阅数据，再按总控的生产写库门禁决定正式写入。Refresh 本身与取文验收分离；成功后也只能安排另一条有上限的 Web 会话健康检查，不能自动连发搜索、`/mp/chapters` 或旧 `/book/articles`。

## 已完成的离线验证

预检脚本的 `node --check`、`--plan`、`--self-test` 成功；总控另在生产 SQLite 上只读 `--preflight` 成功。runner 的 `node --check`、`--plan`、`--self-test` 成功：系统临时目录中的**伪造 SQLite**实际调用 `node:sqlite.backup`，假传输只收到一次请求；假响应返回 429 且只含新 `refreshToken`，第一次私有落盘故意失败、第二次仅重试本地保存成功，原数据库仍保留旧 token；另覆盖错误 `vid` 与验证码分支。

生产只读预检返回 `preflight_ready`、`backupIntegrity=true`、`copyRehearsal=true`、`atomicRecoveryRehearsal=true`、`productionWrites=0`、`networkRequests=0`。完整备份和演练副本留在 Git 忽略的私有目录，未输出凭据。

## 2026-09-30 总控唯一在线结果

在预检目录中执行一次固定请求，得到 `http=200`、`decision=candidate_identity_matched`；响应有新 `accessToken`，无新 `refreshToken`，按固定源码沿用原 refreshToken。私有恢复文件一次原子落盘并复读成功，marker、原始备份和演练副本均仍在。`networkRequests=1`、`productionWrites=0`。未打印或提交 token、Cookie、请求体、原始响应及账号 ID；未接着发 Web、搜索或文章请求。

这个结果证明当前账号的正常移动 Refresh 可取得并保管候选新 accessToken；**它不证明 Web 会话、`/book/articles` 或跨号文章列表可用**。下一步从已保存的私有恢复文件做另一项有界 Web 会话健康检查，生产 SQLite 继续只读；若遇验证码、限流或业务失败即停该路线。
