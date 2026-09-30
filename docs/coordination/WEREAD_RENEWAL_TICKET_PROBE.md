# 微信读书 Web 续期响应头单次隔离实验（2026-09-30）

## 实验问题与来源

问题只限于：**已有本人合法移动恢复会话经一次 Web init 后，`/web/login/renewal` 当前是否在响应中直接签发 `x-wr-ticket` 或 `x-wrpa-0`？** 不请求公众号列表，也不验证 ticket 是否能取文。

请求路径来自可审查的固定源码：[WeRead-Kit 的 mobile→Web init](https://github.com/27Aaron/WeRead-Kit/blob/4b02a4b2d34355d425bf2b87ec3b924e98be29ee/internal/weread/webapi.go#L110-L177)用 `vid/pf=0/skey=accessToken/rt=refreshToken` 建 Web 会话；[KOReader 客户端提交 `dfdc200`](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/weread/lib/client.lua#L555-L584)对同一 Tencent Web 主机 POST `/web/login/renewal`，JSON 为 `rq=%2Fweb%2Fbook%2Fread,ql=false`，并**有条件**读取两个响应头。该源码没有附当前服务端确实签发这两个头的成功日志，证据边界见[续期专项](WEREAD_RENEWAL_TICKET_EVIDENCE.md)。

## 安全边界与实现

[`probe-weread-renewal-ticket.cjs`](../../scripts/research/probe-weread-renewal-ticket.cjs)只接受已核验的私有移动刷新恢复目录。它复用已有 `recoveryGate`：以 SQLite `readOnly` 与 `query_only` 核对生产账号、原始一致性备份、副本演练和恢复身份，**不更新生产库**。根目录必须是本仓库 `.gitignore` 排除的 `private-data/`，不能通过更换恢复目录绕开全局同形哨兵。

`--plan`、`--self-test` 不读生产库且不联网；`--preflight` 只读本地凭据与备份，确认尚无哨兵后仍不联网。`--execute` 先独占 `wx` 创建并 `fsync` `weread-renewal-ticket.attempted.json`，然后最多两次请求：一次 Web init，只有 HTTP/业务状态、五个 Cookie 名及 `wr_vid` 与恢复账号身份都通过门禁，才一次续期。Node `fetch` 禁止自动重定向，设 10 秒截止，不使用浏览器页面、抓包、代理、自动重试或目标文章接口。Web init 的 `Set-Cookie` 仅在本进程内组成下一请求的 Cookie；它和响应值不打印、不保存。响应体有 64 KiB 解析上限。结果只含 HTTP、受控数字业务码、Cookie **名称**、两个头是否存在、身份布尔与请求计数；私有脱敏结果文件独占写入并 `fsync`，不存原始响应、头值、长度、前后缀或哈希。

执行前 `node --check`、`--plan`、`--self-test` 通过；假传输覆盖成功续期与 init 业务拒绝，临时目录演练了哨兵阻止重复和脱敏结果持久化。使用现有生产 SQLite 和私有恢复目录的只读 `--preflight` 输出 `preflight_ready`、`recoveryAndBackupMatched=true`、`sameShapeAttemptAbsent=true`、网络 0、生产写入 0。实验后重复预检返回 `renewal_already_attempted`、网络 0；根目录哨兵和脱敏结果文件均存在，因此**禁止同形重试**。私有文件不进 Git。

## 唯一在线结果

| 环节                           | 脱敏观察                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /web/login/session/init` | HTTP 200；`Set-Cookie` 名为 `wr_pf/wr_ql/wr_rt/wr_skey/wr_vid`；`wr_vid` 与该恢复账号匹配；顶层 `errCode` 未出现。                                                                         |
| `POST /web/login/renewal`      | HTTP 200；顶层 `errCode=-2013`；无 `Set-Cookie`；`x-wr-ticket` 与 `x-wrpa-0` **均未出现**。业务失败分支在读取 `succ` 前停止，故本次 `succ` 是**未记录**，不能写成服务端明确返回 `succ=0`。 |
| 请求与写库                     | init 1、renewal 1、目标列表 0、其他文章 0、生产 SQLite 写入 0；决策 `stop_business_error`。                                                                                                |

当前可直接排除的仅是：**这个已恢复移动会话通过本次隔离 Web init 后，再经固定 `ql=false` 续期请求，会直接得到两个候选响应头**。本次没有得到它们。`-2013` 的腾讯官方语义在已核来源中未找到，不将其擅自解释为某一种确定的失效/风控原因。HTTP 200 和 Web init 五 Cookie 也不等于续期成功，更不等于公众号订阅恢复。

这个结果没有测试正常浏览器扫码后的独立 Web 会话、Reader 自身 JS 生成或接收的头、其他账号/时点，以及 `/web/mp/articles`；旧官方 Reader 的 `-2041` 脱敏记录没有保留请求头，二者不能直接作有/无 ticket 的对照。只有发现**新的正常凭据或第一方签发来源证据**，才设计另一条明确不同的验证；本哨兵不因更换请求参数、客户端或恢复目录而解除。五篇目标文章、发布时间、分页、正文、图片和长期更新均尚未验收。
