# 微信读书 MP 列表样例来源审计（2026-09-30）

## 判定

[`finlater/weread.koplugin` 固定提交 `dfdc200`](https://github.com/finlater/weread.koplugin/commit/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f)的 [API 参考第 6 节](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/docs/weread-api-reference.md#L1124-L1207)确实给出 `/web/mp/articles` 的 `reviews[].subReviews[].review` 结构，包含 `reviewId`、`createTime`、`mpInfo.originalId/title/pic_url`。它是**经过编辑的文档样例**：`pic_url` 用省略号代替真实地址，且没有对应的 HTTP 状态、请求头、响应日期或脱敏运行记录。原作者在文档末尾称流程已用验证脚本验证；这是一项作者声明，不能当作可独立复核的成功回包。现有证据也不能反过来断定样例纯属手写或从未成功取得。

因此，这份样例可供设计字段解析，但**不能证明 2026-09 的本人账号能取目标号文章、跨号列表、完整分页或无人值守续期**。本审计只读公开源码、提交与 issue，未请求腾讯文章端点或读取私有凭据。

## 来源时间线与实际发送行

| 证据                                                                                                                                                                                                                                                                                                                                 | 可核事实                                                                                                                                                      | 边界                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [初始提交 `60c4f7e`（2026-06-07）](https://github.com/finlater/weread.koplugin/tree/60c4f7efd2d25194d0b56f14f806e634346b53d6)                                                                                                                                                                                                        | 原始 API 参考没有第 6 节 MP 样例；`scripts/verify_mp_articles.py` 尚不存在。                                                                                  | 只能定位样例出现时间。                                                                            |
| [功能提交 `8761de3`（2026-06-13）](https://github.com/finlater/weread.koplugin/commit/8761de380781faa472a6c39dfefa1f917b59ab23)                                                                                                                                                                                                      | 同次提交给 API 参考增加 MP 节、加入验证脚本及 `lib/client.lua` 的 MP 请求实现。文档样例中 `createTime=1780620501` 换算为 2026-06-05 00:48:21 UTC。            | 时间与文章标题具有现实感，不是服务端成功的证明。                                                  |
| [固定版 API 参考 `#L1139-L1207`](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/docs/weread-api-reference.md#L1139-L1207)                                                                                                                                                                 | 文档写 `GET https://weread.qq.com/web/mp/articles?bookId={bookId}&offset={offset}`、认证为 Web cookies、按 review group 数增加 `offset`；示例只含一个 group。 | 文档没有附多页响应、`hasMore`/终止条件或目标号结果。                                              |
| [同提交真实客户端 `lib/client.lua:239-259`](https://github.com/finlater/weread.koplugin/blob/8761de380781faa472a6c39dfefa1f917b59ab23/lib/client.lua#L239-L259)与[固定版 `weread/lib/client.lua:688-714`](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/weread/lib/client.lua#L688-L714) | 真正向腾讯 `weread.qq.com` 发送的 URL 从一开始就是 `bookId&maxIdx&count`，可选传 `x-wr-ticket`、`x-wrpa-0`；不是文档描述的 `offset` 形状。                    | 客户端请求行证明发往腾讯，不证明服务端返回列表。`offset` 与 `maxIdx/count` 不可未经实测视为等价。 |
| [固定版 UI `weread/ui/library.lua:1060-1100`](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/weread/ui/library.lua#L1060-L1100)                                                                                                                                                           | UI 调用 `get_mp_articles(book_id, 0, 100, ticket)`，解析并缓存一次结果；遇 `-2041/-2012` 时做一次续期再试。                                                   | 这条 UI 路径固定首屏，没有实际翻页循环；不能作为全史分页实现。                                    |

逐一对比 `8761de3`、`0efbb64`、`5810c92`、`004ecad` 与 `dfdc200` 的第 6 节文本，内容相同。后续文档提交没有给这个样例补实测请求或分页证据。

## `verify_mp_articles.py` 能证明什么

[固定版脚本](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/scripts/verify_mp_articles.py#L1-L150)确实能在操作者提供 Cookie 时向腾讯发请求，但其三项测试的说明分别是“无票据**预期** `-2041`”“带新鲜票据**预期**成功”“已知 `reviewId` 正文**预期**成功”。它以浏览器 DevTools 中复制的 `x-wr-ticket` 作为输入；[`--ticket` 未提供时直接跳过成功分支](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/scripts/verify_mp_articles.py#L83-L112)。其唯一列表请求固定 `offset=0`，只在返回 `reviews` 时打印 `PASS: got ...`，没有第二页实验。[末尾 `SUMMARY`](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/scripts/verify_mp_articles.py#L140-L146)不依赖上述测试是否成功，不能作为运行证据。正文测试还使用与文档相同的硬编码 article token；它不能验证列表发现能力。

文档“[Validated with `scripts/verify_mp_articles.py`](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/docs/weread-api-reference.md#L1257-L1275)”可能反映作者当时的本地成功运行；仓库没有随该句提供可复核的脱敏成功输出或请求票据来源。`#L1064-L1071` 的“Validated output”属于普通书 EPUB 抓取段落，不属于 MP 列表验证。不能把脚本中印出的 `PASS` 文本或条件判断当成已经观察到的腾讯响应。

## 登录、票据与近期用户证据

[当前扫码登录实现](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/weread/lib/qr_login.lua#L245-L299)把合法登录取得的 `webLoginVid/accessToken/refreshToken` 装入 `wr_vid/wr_skey/wr_rt`，保存 API Key 时明确将 `wr_ticket` 和 `wr_wrpa` 初始化为空。[续期实现](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/weread/lib/client.lua#L555-L584)只有在响应头存在时才存 `x-wr-ticket` / `x-wrpa-0`。脚本的“从浏览器复制 ticket”说明它没有独立取票生命周期；文档“Web cookies”也未交代该票据如何正常签发和续期。官方 `wrk-` API Key 不在 MP 列表发送行中。

- [2026-07-19 issue #62](https://github.com/finlater/weread.koplugin/issues/62)提供脱敏运行日志：扫码完成、Cookie 续期后 MP 列表仍 `-2041`。它仅证明该用户该时点的插件流程失败，日志没有票据存在性字段。
- [2026-07-27 issue #81](https://github.com/finlater/weread.koplugin/issues/81)记录一篇 MP HTML 被下载并打开，但正文为空；可视为某用户读到已知 MP 内容的近期旁证。日志没有 `/web/mp/articles` 请求/响应、票据、跨号或翻页证据，不能用于证明此文档样例的列表成功。维护者 7 月 31 日评论称公众号文章当时大概率不能正常阅读；这同样不是所有账号或未来版本的结论。
- 本项目[一次隔离续期实验](WEREAD_RENEWAL_TICKET_PROBE.md)对本人已有移动恢复会话：Web init HTTP 200，固定 `ql=false` 续期 HTTP 200、`errCode=-2013`、两个候选票据头均不存在，目标列表请求数为 0。这排除的只是**该会话本次续期直接签发票据**，没有验证文档样例所需的浏览器票据，更不能推出 `/web/mp/articles` 全部失效。

截至本次审计，已查提交、固定脚本和上述相关 issue 中没有一份同时含**成功列表响应、正常取得票据的来源、日期及可复核请求形状**的脱敏证据。若后来找到这样的第一手材料，应按其具体登录方式与分页参数另设计一次隔离低频验证；不能用本轮 `-2013` 结果否定一个实质不同的正常浏览器会话。

## 对订阅目标的适用性

`MP_WXS_3286016687` 是样例公众号，不是本项目目标号。代码可把任意 `book_id` 填入 URL，但该仓库的正常入口是微信读书书架中的公众号；无目标号跨号成功输出。文档字段 `reviewId/createTime/originalId` 仅作为**待验证的候选映射**。生产 Provider 仍需先用本人合法会话证实目标号至少五篇不同真文章、稳定文章身份及可信发布时间，再测翻页、正文、图片和持续更新。文档的 `offset` 说法与客户端的 `maxIdx/count` 需要在有新认证依据时分别按低频实验核实，不能先合并成长期运行承诺。
