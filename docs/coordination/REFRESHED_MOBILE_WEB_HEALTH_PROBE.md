# 新移动凭据到 Web 书架：一次隔离健康对照

2026-09-30。总控已按[移动 Refresh 恢复门禁](MOBILE_REFRESH_RECOVERY.md)执行**唯一一次**正常移动 `/login`：HTTP 200、`candidate_identity_matched`，返回新 `accessToken`、未返回新 `refreshToken`，完整候选 `mobile` 一次写入私有恢复文件；生产 SQLite 写入 0，Refresh marker 保留。本脚本随后对新凭据执行一次有界 Web 会话对照；结果见下文。

## 固定来源与这次的唯一变量

- 固定 [`WeRead-Kit@4b02a4b` Web 桥接源码 `webapi.go:110-177`](https://github.com/27Aaron/WeRead-Kit/blob/4b02a4b2d34355d425bf2b87ec3b924e98be29ee/internal/weread/webapi.go#L110-L177)用 `POST https://weread.qq.com/web/login/session/init`，JSON `{vid, pf:0, skey:mobile.accessToken, rt:mobile.refreshToken}`，由腾讯服务端下发 Web Cookie。[同一固定版本登录请求真实发送行](https://github.com/27Aaron/WeRead-Kit/blob/4b02a4b2d34355d425bf2b87ec3b924e98be29ee/internal/weread/webapi.go#L131-L170)不提供搜索文章能力。
- 已审[旧完整 Cookie jar 对照](BROWSER_CONTEXT_COOKIE_JAR_PROBE.md)曾以旧移动 token 完成 init、得到五个 Web Cookie，再请求 `GET https://weread.qq.com/web/shelf/sync?userVid=&synckey=0&lectureSynckey=0`，HTTP 200 JSON `errCode=-2012`，搜索请求 0。[近期 `we-mp-rss@15d0d33` 实际书架请求与判定代码](https://github.com/DepengWang/we-mp-rss/blob/15d0d33fd6d1a14a20c6e860d98d3a30738bdb0f/core/weread_cookie_refresh.py#L147-L205)支持同一健康检查形状。这次沿用相同 init/书架形状与非持久 BrowserContext，**只把 mobile 凭据换成私有恢复文件中新 accessToken**，继续沿用同设备、同账号的 refreshToken。若 Web shelf 仍 `-2012`，只能说明此路径在新凭据下仍未获书架认可；不能扩大为所有 Web 路线失效。
- [Playwright 官方 BrowserContext 文档](https://playwright.dev/docs/api/class-browsercontext)说明非持久上下文隔离且不把浏览数据写入磁盘；[APIRequestContext 文档](https://playwright.dev/docs/api/class-apirequestcontext)说明 `context.request` 与上下文共享 Cookie jar，`maxRedirects:0/maxRetries:0` 可限制每步。脚本不打开页面、不监听流量、不保存 `storageState`、HAR、trace 或原始 Cookie。

## 凭据、备份与请求门禁

脚本：[scripts/research/probe-refreshed-mobile-web-health.cjs](../../scripts/research/probe-refreshed-mobile-web-health.cjs)。`--plan` 和 `--self-test` 不读生产库、不启动浏览器或联网；`--execute` 要求绝对生产 SQLite 路径、**本次 Refresh 所在**私有预检运行目录、固定 `playwright-core@1.58.2` 本机安装目录、Edge/Chrome 可执行文件，以及显式 `--approved-online`。执行前拒绝代理、TLS 验证禁用及 Node/Playwright 调试变量；浏览器以 `--no-proxy-server --disable-background-networking` 启动非持久 Context。

生产 SQLite、预检 `original.sqlite` 和 `rehearsal.sqlite` 一律 `readOnly + PRAGMA query_only=ON`，要求恰一账号、完整性检查通过，生产账号 ID 和完整旧 token 与预检原件一致，订阅和文章数与备份/副本一致。私有 Refresh marker 必须存在、格式正确，Web 健康 marker 必须不存在。恢复文件必须是本次 `formatVersion=2` 的 `candidate_identity_matched`、HTTP 200、无失败业务码；其 `accountId` 和 `originalMobile` 必须与源库/备份相同。还逐项核对响应显式 `vid`、新 `accessToken`、候选 `deviceId/vid/refreshToken`；候选 accessToken 必须区别于旧值。**init 只用恢复文件候选的新 `accessToken`，不回退到生产库旧 accessToken，也不用顶层 Web Cookie。**任一失败时不创建本次 marker、不发请求。

门禁通过后，在同一私有目录以独占 `wx` 和 `fsync` 先写 `refreshed-mobile-web-health-attempt.json`；已存在即零请求。网络顺序：

| 阶段                                                      |      最多 | 继续条件                                                                                                                                                                  |
| --------------------------------------------------------- | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web `/web/login/session/init`                             | 一次 POST | HTTP 200、无验证码/限流/失败业务码，响应若有 `success` 则必须为 1；隔离 Context 的完整 Cookie jar 对书架路径有唯一 `wr_vid` 且与恢复 `vid` 精确一致，以及非空 `wr_skey`。 |
| Web `/web/shelf/sync?userVid=&synckey=0&lectureSynckey=0` |  一次 GET | 仅上一步通过才发；无非 200、跳转、验证码、限流和失败业务码，`books` 为数组或存在 `synckey` 才列为书架接受。                                                               |

每步 `maxRedirects:0/maxRetries:0`、10 秒超时；init JSON 解析上限 64 KiB、书架 128 KiB。Playwright 的 APIResponse 在 `.body()` 前已由库接收，因此此上限是**解析上限**，不能称传输硬截断。总请求最多 2、页面导航 0、搜索 0、`/book/articles` 0、Refresh 0、分页 0。Cookie 由同一 BrowserContext jar 自动维护，脚本不手工拼 Cookie 或保存其值。输出仅 HTTP 状态、有限业务码、Set-Cookie 名称、适用 Cookie 名称/数量、`wr_vid` 匹配布尔、`books/synckey` 存在布尔和停止类别；不输出 token、Cookie、正文、原始响应或账号 ID。即使书架接受，也只证明该书架会话，不证明目标号搜索或真实订阅。

```powershell
node scripts/research/probe-refreshed-mobile-web-health.cjs --plan
node scripts/research/probe-refreshed-mobile-web-health.cjs --self-test
# 以下占位路径不可直接运行；本次私有运行目录已有 marker，不得重发。
node scripts/research/probe-refreshed-mobile-web-health.cjs --execute --db <ABSOLUTE_DB_PATH> --run-dir <ABSOLUTE_REFRESH_RUN_DIRECTORY> --playwright-core <ABSOLUTE_PLAYWRIGHT_CORE_DIR> --browser <ABSOLUTE_EDGE_OR_CHROME_EXE> --approved-online
```

## 离线验证与未决项

`node --check`、`--plan`、`--self-test` 成功。自检在系统临时目录生成**假 SQLite 和假私有恢复记录**，实际调用 SQLite backup/副本门禁；账号 ID 或 `vid` 错误时在请求前拒绝。假 BrowserContext 验证只把**新** accessToken 送入 init，Cookie 由 jar 管理，init 成功最多追加一次 shelf；验证码、`success:0` 和 Cookie 身份错误只发一次 init，书架 `-2012` 发两次即停，搜索始终零请求；脱敏结果不含假凭据。离线自检生产库读写 0，真实网络 0。

## 2026-09-30 总控唯一在线对照

只从私有恢复文件读取新 `mobile`，先发一次 Web init：HTTP 200，服务器下发 `wr_pf/wr_ql/wr_rt/wr_skey/wr_vid`，隔离 BrowserContext 的五项适用 Cookie 中 `wr_vid` 与恢复账号身份匹配。随后只发一次 Web shelf：HTTP 200，无失败业务码，`books` 为数组且有 `synckey`，决策 `web_shelf_accepted`。总请求 **2**、目标搜索 **0**、页面导航 **0**、生产 SQLite 写入 **0**；私有健康 marker 已保留。没有输出或提交 Cookie、token、原始响应或账号 ID。

这证明**本次正常 Refresh 后的凭据可以建立被书架接受的 Web 会话**，与旧凭据完整 Cookie jar 书架 `-2012` 的结果有实质差异。它尚不证明目标准确号名搜索、翻页、正文图片或自然新增。下一项是依据腾讯第一方搜索页真实首屏请求，在新的隔离上下文仅发一次目标号搜索；遇验证码或限制即停。
