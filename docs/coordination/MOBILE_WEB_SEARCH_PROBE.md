# 移动凭据桥接后的 Web 搜索首屏探针（2026-09-30）

## 固定来源与本轮边界

已复审的[移动到 Web 桥接探针](WEREAD_MOBILE_TO_WEB_PROBE.md)在本人账号上**一次**返回 HTTP 200 JSON，服务端同时下发 `wr_vid/wr_skey/wr_rt`，且 `wr_vid` 与生产 SQLite 独立 `mobile.vid` 一致；该次 Cookie 值没有保存。因此本次在线执行时正常**重新建立一次** Web 会话，紧接着在同一隔离进程里消费其内存 Cookie。这是新的两请求实验，不是重试先前失败的桥接。旧库已只读复核 `quick_check=ok`、12 个订阅、1447 篇文章；这些存量不能充当新搜索的目标号样本。

[WeRead-Kit 固定 Go 实现](https://github.com/27Aaron/WeRead-Kit/blob/4b02a4b2d34355d425bf2b87ec3b924e98be29ee/internal/weread/webapi.go#L110-L177)给出 `POST https://weread.qq.com/web/login/session/init` 的 JSON `{vid: mobile.vid, pf: 0, skey: mobile.accessToken, rt: mobile.refreshToken}`，并从 `Set-Cookie` 取得 Web Cookie。[固定开源搜索实现](https://github.com/dailyoozoo/weread-mp-fetch/blob/2b4fd61d921b029075ecad3963a8fbc9568d0fc0/src/weread.js#L356-L373)在已登录 `weread.qq.com` 页面上下文以 `credentials: include` 发送 `POST /web/wx_search_broker_proxy`，首屏 JSON 只有 `{query}`；[腾讯第一方页面 JS](https://search.wxqcloud.qq.com/t/searchweb/search/weixin-search-outlinks/26090701/js/read_search.fc739bbf.js)也使用该端点，PC 分支后续状态含 `offset/searchid/searchcookies`。本脚本用服务器刚下发的 Cookie 在 Node 隔离进程直连同一第一方主机，这是**待验证**的请求上下文；固定页面代码并未保证服务端接受这种直连。

## 请求与停止门禁

[探针脚本](../../scripts/research/probe-mobile-web-search.cjs)的 `--plan` 和 `--self-test` 均不读生产 SQLite、不发网络。`--execute` 同时要求绝对 `--db` 路径与 `--approved-online`；在线请求已经总控复审。脚本以 Node SQLite `readOnly: true`、`PRAGMA query_only=ON` 查 `SELECT token FROM accounts LIMIT 2`，只接受**恰一账号**且 `mobile.vid/accessToken/refreshToken/deviceId` 均非空。仅取这一个 `mobile` 对象，`deviceId` 只做来源完整性门禁；顶层 Web token、浏览器资料、Gateway Key 均不参与。

请求上限是 **init 一次 + 搜索一次**。init 用固定 Go 请求体；只在 HTTP 200、JSON 无失败业务码、服务端下发非空 `wr_skey`、`wr_vid` 精确匹配 `mobile.vid`、Cookie 无冲突且作用域可用于搜索路径时，才将 `wr_vid/wr_skey/wr_rt` **仅在内存**组成一次搜索的 Cookie 头。搜索请求固定为 `POST https://weread.qq.com/web/wx_search_broker_proxy`，`credentials: include`、`Content-Type: application/json; charset=utf-8`、第一方 `Origin/Referer`，正文恰为目标准确号名 `{query: "妈妈部落畅聊阁"}`。两请求均禁自动跳转、重试、刷新、分页；init 超时 10 秒、响应上限 64 KiB，搜索超时 20 秒、响应上限 512 KiB；`NODE_USE_ENV_PROXY=1` 时发送前停止。不写生产库、Cookie jar、浏览器配置或任何会话文件，不请求目标原文。

任一环节出现 401/403、429、重定向、验证码、限流、异常业务码、不可判读业务码、响应超限、Cookie 缺失或身份不符，即停止整个流程。传输失败只标为传输问题，不能当认证拒绝；搜索首屏无目标号也不自动换词或再次请求。搜索外层 `ret=-1` 在固定接口记录中可与有效 `content.data` 同时出现，因此允许继续核验 `content.data` 数组和 `content.ret`；其他异常码仍停。搜索 `errCode=-2010` 只标未确定业务码并停止，不能据腾讯静态 JS 推断账号无权；`-2012` 标会话失效候选并停止。服务器若返回分页字段，只记录字段存在性，不使用其值发送下一页。

## 脱敏结果与验收边界

输出只有两步实际请求数、各自 HTTP 状态/受控业务码、init Cookie **名称**存在性与身份匹配布尔、搜索响应结构与字段存在性、bucket/条目数、`source.title/doc_url/timestamp/source.dateTime` 存在计数、目标号名精确匹配数、腾讯原文 URL 中显式 `__biz=Mzg5NTQzMTQxMg==` 匹配数及二者交集。不会输出 Cookie/token、账号 ID、文章标题、原始 URL、响应正文、错误原文、游标值或本地库路径。号名匹配只证明搜索卡片文本；显式 `biz` 匹配才构成更强的账号身份线索。搜索索引时间不是原文发表时间；即便有五条目标卡片，也仍须另行核验稳定文章 ID、原文 `ct`、分页、正文和图片，不能宣称订阅恢复。

本轮离线预检：

```powershell
node scripts/research/probe-mobile-web-search.cjs --plan
node scripts/research/probe-mobile-web-search.cjs --self-test
```

自检只用假凭据与模拟响应，覆盖两次请求形状、搜索外层 `ret=-1` 且有效条目结构、内存 Cookie 传递及脱敏计数，另验证过期桥接、双账号、身份不一致、Cookie 作用域不符、搜索 429、验证码、`-2010`、缺失 `content.data` 和非零 `content.ret` 的停止门禁；SQLite 凭据读取 **0**、真实网络请求 **0**、生产写入 **0**。

## 2026-09-30 总控一次在线执行

经总控审查、10 项离线场景及格式检查后，`bc68883` 已推送 main；使用上文固定脚本和本人已有 `mobile` 对象执行一次 `--execute`。结果仅为脱敏摘要：请求数 2（init 1、搜索 1）；init HTTP 200 JSON，无 `errCode/ret/content`，服务器设置 `wr_vid/wr_skey/wr_rt` 及另外两个未使用的 Cookie 名，`wr_vid` 与移动账号一致；搜索 HTTP 200 JSON，顶层有 `errCode=-2012`、无 `ret/content`，决策 `stop_auth_expired_candidate`。没有搜索卡片、目标文章、分页请求或原文请求；进程未保存 Cookie、原始响应、账号 ID、标题或 URL，也未写生产库。搜索请求只发送服务端刚下发的三个 Web Cookie，而开源实现原本运行在浏览器页面上下文，故本次只排除**这种 Node 直连上下文及 Cookie 组合**，不能把 `-2012` 直接解释成账号永久无权、整个搜索接口关闭或旧 `/book/articles` 无效。此形状不重发；先追固定源码对 Cookie 生命周期、页面上下文和 `-2012` 的具体解释，再决定是否存在实质不同的下一次低频验证。
