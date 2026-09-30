# 微信读书 Web 续期与 MP 请求头：证据边界（2026-09-30）

## 结论

`POST https://weread.qq.com/web/login/renewal` 是可审查开源客户端确实调用的腾讯 Web 续期端点。它可在既有合法 Web 会话下续 Cookie；**目前核到的源码只证明客户端会有条件地读取续期响应里的 `x-wr-ticket` 和 `x-wrpa-0`，没有证明腾讯当前会签发这两个头，更没有证明它们可无人值守续期或使本目标 `/web/mp/articles` 成功**。这条认证来源假设仍可做一次隔离、低频、仅保留字段存在性结果的验证；不能将源码的 `if header exists` 写成已获票据。

## 可复核的调用与字段链

下表固定在 `finlater/weread.koplugin` 的 [提交 `dfdc200`](https://github.com/finlater/weread.koplugin/commit/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f)（提交时间 2026-09-21 02:05 +08:00；2026-09-30 检索）。它是开源客户端实现，不是腾讯服务端源码。

| 环节                          | 实际代码                                                                                                                                                                                                                                                                                                                                                                                     | 代码能证明什么                                                                              | 尚未证明什么                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 正常扫码登录后的 Web 凭据安装 | [`scripts/verify_qr_login.py:1182-1227`](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/scripts/verify_qr_login.py#L1182-L1227) 将 `webLoginVid`、`accessToken`、`refreshToken` 分别装入 `wr_vid`、`wr_skey`、`wr_rt`                                                                                                                             | 脚本明确区分登录字段和 Cookie 名称；没有从这些字段生成 ticket/WPA                           | 此映射是否是腾讯对每种接口的完整认证要求                                                                       |
| Cookie 续期                   | [`weread/lib/client.lua:555-584`](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/weread/lib/client.lua#L555-L584) 向 `weread.qq.com/web/login/renewal` POST `rq`、`ql=false`；先验 `succ=1`，再合并 `Set-Cookie`                                                                                                                                  | 同一函数**仅在响应头非空时**保存 `x-wr-ticket` / `x-wrpa-0`；值由响应读取，未在该函数内计算 | 实际响应是否含两个头、频率、有效期、是否绑定会话或请求                                                         |
| 脱敏检查脚本                  | [`scripts/verify_qr_login.py:1293-1349`](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/scripts/verify_qr_login.py#L1293-L1349) 对相同端点只输出 HTTP、`Set-Cookie` 与两头的存在性；[末尾输出](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/scripts/verify_qr_login.py#L1423-L1443)打印 `True/False` | 有现成的无值诊断形状，适合隔离验证                                                          | 仓库里的脚本本身不是它运行成功的日志；所查脚本和 issue 未附 `Renewal x-wr-ticket present: True` 等脱敏实测输出 |
| MP 列表请求                   | [`weread/lib/client.lua:688-714`](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/weread/lib/client.lua#L688-L714) GET `weread.qq.com/web/mp/articles`；仅在已有值时加 `x-wr-ticket` / `x-wrpa-0`                                                                                                                                                  | 续期读取值到列表请求头的客户端传递路径是完整的                                              | 腾讯服务器是否要求这两个头、它们是否有效、对目标号是否返回文章                                                 |

本项目自身 [`WereadService.renewCookie`](../../apps/server/src/weread/weread.service.ts#L210-L257) 只解析 `Set-Cookie` 中的 `wr_skey`，没有读取上述响应头。`wr_skey` 续期成功不能作为“票据已取得”的证据。官方 Gateway 的 `wrk-` Key 与这个 Web Cookie/请求头路径仍是不同凭据体系。

## 实际服务端与长期运行证据

- KOReader 的 [API 参考](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/docs/weread-api-reference.md)写的是 `renewal` 成功返回 `{"succ":1}` 并保存 `Set-Cookie`；该说明没有展示续期响应真的带 ticket/WPA 的脱敏样本。[验证脚本](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/scripts/verify_mp_articles.py)把“有新 ticket 后成功”列为**预期**，需要用户另外提供浏览器票据，并未自证结果。
- [2026-07-19 用户 issue #62](https://github.com/finlater/weread.koplugin/issues/62)的原始脱敏日志记录“cookie 已续期”后，MP 列表仍返回 `-2041`。它直接反驳“Cookie 续期足以恢复 MP 列表”，但日志未记录 ticket/WPA 是否存在，故不能推定失败原因，也不能据此断言票据无效。
- [2026-07-13 `weread-bot` issue #44](https://github.com/funnyzak/weread-bot/issues/44)记录续期 HTTP 200、未找到 `wr_skey` 而失败。这是另一开源客户端的一次故障证据，说明 HTTP 200 不能等同续期成功；它不说明所有会话的结果。
- [findmover/wxread 固定提交 `210672a`](https://github.com/findmover/wxread/blob/210672a25c16149e7a47765bb1680b89b457eb62/main.py)的 `get_wr_skey()` 只查响应 Cookie，未给 ticket/WPA 的签发证据。其多 payload 重试策略不是本项目应照搬的验证方式。

检查了 2026-09-30 无登录的 [腾讯 Web 首页](https://weread.qq.com/)直接引用的四个公开入口脚本（`D5nOnlJZ-legacy.js`、`BZ6SsvaW-legacy.js`、`9oq92R5p.js`、`BVQc4ULa.js`），限定字面搜索 `login/renewal`、`x-wr-ticket`、`x-wrpa-0`、`wr_skey` 均未命中。它们不是 Reader 所有延迟加载脚本，因此此阴性结果**不排除**第一方客户端其他 chunk 的认证生命周期。

## 精确的下一次最小验证前提

如已有本人正常登录、仍有效的 Web 会话，Probe Agent 可在隔离会话副本上向**已知续期端点发一次**正常续期请求，不访问目标号、不写生产库；只记录 HTTP 状态、JSON 顶层 `succ/errCode`、`Set-Cookie` 的名称列表、`x-wr-ticket` 与 `x-wrpa-0` 是否存在，绝不保存值、长度、前后缀、哈希或原始响应。若返回验证码、认证拒绝或频控，立即停止。若 `succ=1` 且返回相关头，才另行设计一次携带合法新头的目标列表首屏只读验证，并与旧官方 Reader 未留存请求头的 `-2041` 样本区分。若本次只有 Cookie 而无相关头，只能排除“该会话本次续期直接签发票据”这一狭义假设，不能扩大为所有腾讯路径不可行。

该试验之前没有理由改 Provider、将 ticket 加入生产设置或承诺无人值守。即使取得首屏文章，也仍须验证目标至少五篇不同真文章、号身份、稳定文章身份、可信发布时间、分页、正文、图片和后续更新；长期续期另需跨自然过期周期的合法低频观察。
