# 微信读书 Web 目标封面一次隔离验证（2026-09-30）

## 假设与请求边界

[公开 ShelfSignal 固定源码](https://github.com/stanley6635/shelfsignal-wechat/blob/ddeb09011a10f49f8ca2ce4d2935098ba4f60967/src/shelfsignal/weread.py#L143-L155)用本人 Web 浏览器上下文对已知 `MP_WXS_*` 发 `GET https://weread.qq.com/web/mp/cover?bookId=...`，从响应读取当前一篇的 `reviewId`。其 2026-07-31 [live canary](https://github.com/stanley6635/shelfsignal-wechat/blob/ddeb09011a10f49f8ca2ce4d2935098ba4f60967/docs/superpowers/specs/2026-07-31-shelfsignal-wechat-design.md#L323-L339)只覆盖当时已保存的公众号与当前封面，不是本账号目标号成功回包。本实验只问：本人现有合法移动会话经正常 Web 初始化后，此**不同于已测列表**的腾讯端点现在返回什么。即使成功，也最多取得一篇，不能当账号目录或订阅恢复。

总控复审 [`probe-weread-web-mp-cover.cjs`](../../scripts/research/probe-weread-web-mp-cover.cjs) 后，先核生产库、原备份和演练库只读一致，目标号恰一活跃 Feed 且号名准确；固定版 `playwright-core@1.58.2` 从本机缓存离线安装到 Git 忽略的 `private-data`，Edge 离线启动检查通过。`--plan`、假网络 `--self-test`、`node --check`、`--preflight`、`pnpm fmt.check` 均通过；执行前预检 `existingCoverHistory=false`。脚本先在固定私有目录独占写入持久哨兵，至多一次 Web init 与一次目标 cover GET，禁代理、自动跳转、重试、页面导航、列表、正文和图片请求。验证或业务拒绝即停；正常有界 JSON 才先私存完整响应并做身份判断。

## 实际脱敏结果

| 项目                                         | 观察                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `POST /web/login/session/init`               | 一次，HTTP **200**；下发 `wr_pf/wr_ql/wr_rt/wr_skey/wr_vid`；`wr_vid` 与私有恢复记录的本人账号一致 |
| `GET /web/mp/cover?bookId=MP_WXS_3895431412` | 一次，HTTP **200**，顶层 `errCode=-2012`，无可接受封面候选                                         |
| 请求数                                       | init 1、cover 1；列表、正文、图片、页面导航均 0                                                    |
| 私有保存                                     | 固定 `private-data` 中尝试哨兵存在；业务拒绝响应不保存原始 JSON，候选 `reviewId` 文件不存在        |
| 数据保护                                     | 生产 SQLite `quick_check=ok`，12 个 Feed、1447 篇文章；生产写入 0                                  |

`-2012` 是此请求的业务返回；本轮没有一手依据把它唯一归因为 Cookie 过期、书架导航缺失、目标权限或某个未携带的临时头。已有同账号 Web 搜索成功记录，也不能替这个封面请求证明认证应被接受。**本次只排除“现有合法移动恢复凭据 → 单次 Web init 五 Cookie → 无书架页面导航的独立 BrowserContext GET `/web/mp/cover`，在本账号/目标号/时点能直接返回封面”的假设。**不推广为该端点永久失效、其他账号不能使用、另一个 `/api/mp/cover` 路径失败，或腾讯不提供单篇正文。旧原文与合集的有限成功证据也不因本次返回而失效。

对应哨兵已经写入，即使未来私有目录丢失，也以本报告和 Git 历史为已试记录；**不重发同形请求**。A 线继续离线比较公开客户端在封面 GET 前的书架导航、实际认证状态与 `/api/mp/cover` 的独立证据。只有新的一手签发/请求差异足以支持不同假设时才另审低频探针；不因 `-2012` 猜参数或换 Cookie 立即重试。
