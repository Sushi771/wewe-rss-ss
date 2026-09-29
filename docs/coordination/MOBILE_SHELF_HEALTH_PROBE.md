# 移动会话书架健康检查：离线设计，尚未在线执行

2026-09-30。此探针只回答一个问题：**当前保存的本人合法移动 `accessToken` 是否仍被移动书架接口接受**。它不读取公众号文章，不续期凭据，也不把移动书架成功外推为 Web 搜索或旧 `/book/articles` 可用。

## 固定一手依据与实验差异

- [`27Aaron/WeRead-Kit@4b02a4b` `internal/weread/shelf.go:24-49`](https://github.com/27Aaron/WeRead-Kit/blob/4b02a4b2d34355d425bf2b87ec3b924e98be29ee/internal/weread/shelf.go#L24-L49) 向腾讯 `https://i.weread.qq.com/shelf/sync` 发 **GET**，加移动版本头和 `vid/accessToken`；把 HTTP 401、业务码 `-2012` 视为移动会话错误，正常 JSON 解析 `books`。
- [同一固定提交 `client.go:16-31,73-91,120-147`](https://github.com/27Aaron/WeRead-Kit/blob/4b02a4b2d34355d425bf2b87ec3b924e98be29ee/internal/weread/client.go#L73-L91) 给出域名、`User-Agent`、`baseapi=30`、`appver=basever=2.1.2.10245900`、`osver=11`、`channelId=900` 和两项移动认证头。脚本逐项固定这一请求形状，没有猜 `skey`、Cookie、签名或文章参数。
- [旧客户端审计](../WEREAD_CLIENT_FLOW_AUDIT.md#L24-L35)记录本人正常登录得到独立 `mobile.{vid,accessToken,refreshToken,deviceId}`，当时 `/shelf/sync` 曾成功。当前有效期未知；不读取或输出令牌原值作人工判断。
- [先前完整 Cookie jar 对照](BROWSER_CONTEXT_COOKIE_JAR_PROBE.md#2026-09-30-总控复审后的一次在线结果)是 **Web** `/web/login/session/init` HTTP 200 后的 **Web** `/web/shelf/sync` HTTP 200、`errCode=-2012`，搜索零请求。[WeRead-Kit issue #48](https://github.com/27Aaron/WeRead-Kit/issues/48)还报告无效移动入参可使 Web init 返回 200 与 Cookie。因此本次直问移动 `/shelf/sync` 是不同且必要的判别；仍不能仅凭结果确定 Web 失败的唯一原因。

## 实现与执行门禁

脚本：[scripts/research/probe-mobile-shelf-health.cjs](../../scripts/research/probe-mobile-shelf-health.cjs)。`--plan` 与 `--self-test` 不打开 SQLite、不发网络请求；`--execute` 必须同时给生产 SQLite 的绝对路径、私有 marker 绝对路径和 `--approved-online`。本次只完成离线验证，**没有运行 `--execute`**。在线执行须先经总控复审。

```powershell
node scripts/research/probe-mobile-shelf-health.cjs --plan
node scripts/research/probe-mobile-shelf-health.cjs --self-test
# 总控复审后才可执行；下列占位路径不可直接运行。
node scripts/research/probe-mobile-shelf-health.cjs --execute --db <ABSOLUTE_DB_PATH> --marker <ABSOLUTE_PRIVATE_MARKER_PATH> --approved-online
```

`--execute` 打开 `DatabaseSync(dbPath, { readOnly: true })`，立即执行 `PRAGMA query_only=ON`，仅 `SELECT token FROM accounts LIMIT 2`；必须恰好一条账号且有非空的同一 `mobile` 对象四项字段。脚本在内存只取 `mobile.vid/accessToken` 用于请求，不输出、哈希、缓存或记录凭据。`refreshToken` 只作为结构存在性门禁，不参加请求；生产库无写入。

marker 必须位于本仓库忽略的 `private-data/` 目录或仓库外的私有目录，父目录预先存在，脚本不新建目录。网络前以独占 `wx`、权限 `0600` 写入接口名与时间；**marker 已存在即零请求**。marker 不保存账号、凭据或响应。即便网络故障，marker 也保留，杜绝意外重试；任何后续在线动作由总控单独复审。执行时拒绝常见代理环境变量及 `NODE_USE_ENV_PROXY`；用 Node 内建 `https.request` 且 `agent:false` 直连腾讯固定 URL，不使用代理或 Cookie jar。请求仅一次 GET、无自动重定向、无缓存、10 秒超时、512 KiB 响应上限；没有跳转跟随、重试、Refresh 或文章请求。

## 仅脱敏输出与判读

脚本只打印 HTTP 状态、有限数值业务码、`books/synckey` 字段存在布尔值、决策类别和请求次数；不打印原始请求、响应、Location、Cookie、错误对象或环境值。

| 结果 | 决策与停止条件 |
| --- | --- |
| HTTP 200、JSON、无非零 `errCode`、`books` 为数组 | `mobile_shelf_accepted`。仅说明此移动书架请求接受该会话；不证明 Web init、搜索、`/book/articles` 或订阅。 |
| HTTP 401/403；或 JSON `errCode=-2012` | 分别 `stop_auth_or_access`、`stop_mobile_session_rejected_candidate`。支持移动会话不被接受的判断；不开 Refresh，不自动把 `-2012` 归咎于过期，仍保留账号权限等可能。 |
| HTTP 429；验证码、访问过频提示；3xx | `stop_rate_limit`、`stop_verification`、`stop_redirect`，立即停止对应路线，不跟随、不重发。 |
| 超时/网络故障、超大响应、非 JSON、未知业务码/形状 | 保守停止并保持 marker；只记录脱敏类别。 |

移动 `accessToken` 如被拒绝，后续 Refresh 必须作为**另一项设计与复审**：先查 `refreshToken` 轮换语义、私有备份与原子持久化，再决定是否执行；本探针不自动调用 `/login`，不覆盖任何生产凭据。

## 离线验证

`node --check`、`--plan`、`--self-test`、`git diff --check` 的结果在提交前核对。`--self-test` 只用伪造内存凭据与伪造 `fetch`，验证一次请求、固定头、失败分类与代理门禁，不触及生产 SQLite 或腾讯服务。最终在线结果由总控另记。
