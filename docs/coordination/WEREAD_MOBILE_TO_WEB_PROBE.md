# 移动凭据到微信读书 Web 会话：一次性桥接探针（2026-09-30）

## 固定依据与本机前提

[A 线认证复核](RESEARCH_BOOK_ARTICLES_AUTH.md)已经以 SQLite `mode=ro`、`PRAGMA query_only=ON` 确认：生产库恰有一个账号，其独立 `mobile` 对象含非空 `vid/accessToken/refreshToken/deviceId`；它来自本人正常的 i 域名登录，旧审计记录过移动凭据续期成功。本轮没有重新读取这些值。顶层 Web `accessToken/wr_skey` 与移动对象分开，探针只取 `accounts.token.mobile`。

[WeRead-Kit 固定 Go 源码 `WebCookie` 第 110–177 行](https://github.com/27Aaron/WeRead-Kit/blob/4b02a4b2d34355d425bf2b87ec3b924e98be29ee/internal/weread/webapi.go#L110-L177)将移动 `AccessToken` 放在 JSON 的 `skey`，`RefreshToken` 放在 `rt`，`Vid` 放在 `vid`，`pf` 为数字 `0`，向腾讯 `POST https://weread.qq.com/web/login/session/init`。源码只设置 `content-type: application/json; charset=UTF-8` 与固定桌面 User-Agent；它检查 HTTP 状态、`errCode=-2012` 和服务端 `Set-Cookie` 的 `wr_skey`。源码的上层可能在过期后续期重试，**本探针不复用该行为**。独立 [Python 固定实现](https://github.com/ylw1997/wereadapi/blob/137c7aa214f947e192a490206b38bb524a63fdd4/tests/weread_api_test.py#L203-L210)给出相同桥接调用方向，但本账号当下是否可用仍未知。

## 一次请求的门禁

[隔离脚本](../../scripts/research/probe-weread-mobile-to-web.cjs)的 `--plan`、`--self-test` 不打开 SQLite、不发网络请求。未来 `--execute` 必须同时给出绝对路径 `--db` 与显式 `--approved-online`；仅在总控复审后执行。脚本先以 Node SQLite `readOnly: true` 打开指定库并设置 `PRAGMA query_only=ON`，查询 `SELECT token FROM accounts LIMIT 2`。账号数不等于 1、移动四字段有缺失或数据库错误，均在发送前停止。`deviceId` 只作同一移动对象的完整性门禁，**不进入请求体**。不会读取浏览器配置、从顶层 Web 对象补值或写生产库。

若门禁通过，隔离进程最多发送**一次** HTTPS POST：正文恰为 `{vid: mobile.vid, pf: 0, skey: mobile.accessToken, rt: mobile.refreshToken}`；没有 Cookie 请求头、浏览器 Cookie jar、自动刷新、重试、跳转跟随或第二请求。请求超时 10 秒；返回体最多在内存读取 64 KiB。`NODE_USE_ENV_PROXY=1` 时在发送前停止，不自动改用代理。传输失败只报固定类别，不作为认证拒绝。

脚本只输出 `requestCount`、固定凭据来源和端点路径、HTTP 状态、受控业务码、JSON 字段存在性、`Set-Cookie` 中 `wr_vid/wr_skey/wr_rt` 的**名称存在性**及其他 Cookie 名称的计数，并在进程内比较 `wr_vid` 与本次 `mobile.vid` 是否一致。它不输出凭据值、长度、哈希、账号 ID、Cookie 值、原始响应、响应错误文字、完整 URL 或本地数据库路径；不把任何会话值落盘。非 200、重定向、401/403、429、`errCode=-2012/-2010`、验证码/限频提示、非 JSON、过大响应、缺 `wr_skey`、缺或不匹配 `wr_vid` 均立即终止。只有 HTTP 200、无失败业务码、`wr_skey` 存在且 `wr_vid` 身份一致时，结论才是 `candidate_web_cookie_issued`，仍**不能证明 Web 会话已被后续接口接受**。

本版故意不请求 `/web/shelf/sync`、公众号搜索或旧 `/book/articles`。若首轮候选 Cookie 成立，是否进行同一隔离会话的单次健康检查由总控根据脱敏首轮结果另行决定；当前脚本不会保留 Cookie 供后续使用，也不会自动重试过期 token。

## 一次在线结果

总控复审后于 2026-09-30 对现有唯一账号**只执行一次** `--execute`。脱敏输出：`requestCount=1`、HTTP 200、JSON，`Set-Cookie` 存在 `wr_vid/wr_skey/wr_rt`（另有两个未命名计数），`wr_vid` 与同组 `mobile.vid` 相等；响应没有可解释的 `errCode/ret/succ` 字段，分类为 `candidate_web_cookie_issued`。没有输出或保存任何凭据/Cookie 值、原始响应或账号 ID，没有刷新移动令牌、请求书架/公众号或写生产库。随后用只读连接复核生产 SQLite `quick_check=ok`、12 个订阅、1447 篇文章。

本结果证明**该账号现有移动凭据在此时可换取候选 Web Cookie**；Cookie 未被第二个腾讯接口验证，也没有持久化，因此还不能宣称 Web 搜索可用或订阅恢复。下一独立实验若需使用 Cookie，将在新的短时进程正常建立会话并仅在内存中完成一次目标搜索；这不会重放失败请求。

## 离线自检与交付边界

```powershell
node scripts/research/probe-weread-mobile-to-web.cjs --plan
node scripts/research/probe-weread-mobile-to-web.cjs --self-test
```

自检仅用内存假凭据与模拟 `Response`，覆盖准确请求体、顶层值未混入、无请求 Cookie、手动重定向、成功 Cookie 身份、`-2012` 停止、双账号发送前停止、`wr_vid` 不一致、验证码、429 和不可判读业务码停止。预期为 SQLite 凭据读取 **0**、真实网络请求 **0**、生产写入 **0**。一次在线实验已验证候选 Cookie 下发；会话健康、搜索可用、目标号文章与订阅恢复均未验证。
