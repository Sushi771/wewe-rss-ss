# 非持久 BrowserContext 完整 Cookie jar 对照：待在线复审

## 目的与固定依据

2026-09-30 的[移动桥接后 Node 直连结果](MOBILE_WEB_SEARCH_PROBE.md)只把服务端下发的 `wr_vid/wr_skey/wr_rt` 三个 Cookie 手工送给搜索端点，得到 HTTP 200、`errCode=-2012`，而当时 init 实际下发五个 Cookie。主线[认证边界复审](RESEARCH_BOOK_ARTICLES_AUTH.md#2026-09-30-web-搜索--2012-的认证边界)说明这不足以区分完整 Cookie jar、页面上下文与搜索特定拒绝。

本探针先**只隔离完整 Cookie jar 一个变量**。按[Playwright 官方文档](https://playwright.dev/docs/api-testing)，`BrowserContext.request` 与上下文共享 Cookie，API 响应的 `Set-Cookie` 自动写入同一 jar；[`browser.newContext()`](https://playwright.dev/docs/api/class-browsercontext)为非持久上下文。[官方 APIRequestContext 文档](https://playwright.dev/docs/api/class-apirequestcontext)支持 `maxRedirects: 0`、`maxRetries: 0`。先不打开 `weread.qq.com` 页面、不运行官网 JS，也不使用路由、请求/响应监听或抓包。这样页面背景请求数确定为零，但本轮**不检验真实页面 `Origin/Referer` 或页面内 fetch**；若完整 jar 仍受限，应在本轮结束后另评页面实验，不自动追加。

[WeRead-Kit 固定 Go 桥接](https://github.com/27Aaron/WeRead-Kit/blob/4b02a4b2d34355d425bf2b87ec3b924e98be29ee/internal/weread/webapi.go#L110-L177)给 init JSON `{vid, pf: 0, skey: mobile.accessToken, rt: mobile.refreshToken}`。[固定书架健康检查实现](https://github.com/DepengWang/we-mp-rss/blob/15d0d33fd6d1a14a20c6e860d98d3a30738bdb0f/core/weread_cookie_refresh.py#L147-L205)使用 `GET /web/shelf/sync?userVid=&synckey=0&lectureSynckey=0`，只有无失败业务码且出现 `books` 数组或 `synckey` 才判有效。[固定搜索实现](https://github.com/dailyoozoo/weread-mp-fetch/blob/2b4fd61d921b029075ecad3963a8fbc9568d0fc0/src/weread.js#L356-L373)给首屏 `POST /web/wx_search_broker_proxy` 的 JSON `{query}`。书架健康只证明 Web 会话可用于该书架接口，不证明搜索授权或目标号取文。

## 离线门禁与请求上限

[`probe-browser-context-cookie-jar.cjs`](../../scripts/research/probe-browser-context-cookie-jar.cjs)的 `--plan`、`--self-test` 不读取 SQLite、不启动浏览器、不发网络；`--execute` 要求绝对数据库路径、固定版本 `playwright-core@1.58.2` 的私有本机安装目录、本机 Edge/Chrome 可执行文件和显式 `--approved-online`。数据库只用 `DatabaseSync({readOnly:true})`、`PRAGMA query_only=ON` 读取 `accounts` 最多两行，必须恰一账号且独立 `mobile.vid/accessToken/refreshToken/deviceId` 非空；顶层 Web token 不参与。启动隔离浏览器后，要求新上下文初始 Cookie jar 为空；不保存 `storageState`、HAR、trace、截图或浏览器 profile。

执行前若存在环境代理或 Playwright/Node 调试日志开关则直接停，避免代理路径改变或敏感请求体进入调试输出；不修改系统代理。只在本机隔离浏览器进程中禁用背景联网，不触及用户日常浏览器资料。

请求顺序和硬上限为：

| 阶段 | 最多请求 | 发起条件 | 停止门禁 |
| --- | ---: | --- | --- |
| `/web/login/session/init` | 1 次 POST | 唯一合法 mobile 对象，空 jar | 非 200、跳转、验证、限流、异常码、Cookie 缺失/作用域不符或 `wr_vid` 与 `mobile.vid` 不符 |
| `/web/shelf/sync` | 1 次 GET | init 成功且浏览器 jar 对书架及搜索路径有匹配的 `wr_vid/wr_skey` | 非 200、跳转、验证、限流、异常码、缺少 `books` 数组及 `synckey` |
| `/web/wx_search_broker_proxy` | 1 次 POST | 书架明确有效且 Cookie 仍匹配 | 非 200、跳转、验证、限流、异常码或响应形状不可判读即停 |

最多 **3 个第一方请求**；0 页面导航、0 刷新、0 重试、0 分页、0 原文请求。Playwright 的 `maxRedirects:0/maxRetries:0` 用于每步；超时分别为 10/10/20 秒。JSON 解析前检查正文 64/128/512 KiB 上限；Playwright APIResponse 会先在内存接收响应，所以这些是**解析上限**，不是传输流硬截断。进程只输出请求数、HTTP 状态、受控业务码、Set-Cookie **名称**、适用于两路径的 Cookie 名称/数量、`wr_vid` 身份匹配及轮换布尔、书架有效/未知分类、搜索响应字段存在性与脱敏计数；不输出账号 ID、Cookie/token 值、完整 URL、标题、正文、原始响应或游标值。搜索卡片号名精确匹配数与显式目标 `biz` 匹配数分开计，不能以卡片时间替代原文 `ct`。

本机依赖检查：项目及全局 Node/Python 环境此前未装 Playwright；仅从本机 npm 缓存**离线**安装 `playwright-core@1.58.2` 到 Git 外的私有临时目录，未改项目依赖或生产配置。`--runtime-check` 在本机 Edge 上启动无页面的非持久 Context，设为离线后关闭；结果 `passed`，SQLite 读取 0、目标请求 0、页面导航 0。`--plan` 及 7 个纯模拟 `--self-test` 场景通过，SQLite 读取 0、网络请求 0、生产写入 0；覆盖完整五 Cookie、init 形状、书架有效与未知、书架限流、`-2010/-2012` 停止、双账号阻断及输出不含模拟凭据。

## 2026-09-30 总控复审后的一次在线结果

总控复审上述“完整 jar、无页面”的独立范围后，先只读检查生产 SQLite：`quick_check=ok`、账号数 **1**；再运行脚本的 `--execute` **一次**。脱敏结果如下（只列受控字段，不含原始响应或 Cookie 值）：

```json
{"decision":"stop_auth_expired_candidate","requestCount":2,"initRequests":1,"shelfRequests":1,"searchRequests":0,"pageNavigations":0,"initHttp":200,"initType":"json","initSetCookieNames":["wr_pf","wr_ql","wr_rt","wr_skey","wr_vid"],"shelfCookieCount":5,"searchCookieCount":5,"wrVidMatchesMobile":true,"wrSkeyApplicable":true,"shelfHttp":200,"shelfType":"json","shelfCode":-2012}
```

init 无异常业务码，服务器下发的五个 Cookie 名均在同一非持久 Context 的书架和搜索路径作用域内；`wr_vid` 与所用 `mobile.vid` 在内存中精确一致，`wr_skey` 非空。Playwright 官方 Cookie jar 语义使后续 `context.request` 自动携带适用 Cookie，脚本没有手工裁剪或构造 Cookie 头；由于禁止请求监听/抓包，本轮只证明 jar 中五个 Cookie 对两路径**可用**，没有另行观察线上请求头。

随后书架健康请求得到 HTTP 200 JSON，顶层 `errCode=-2012`，因此立即停止，**目标搜索 0 次**，没有打开页面、刷新、重试或追加页面内 fetch。`-2012` 在此只标“会话失效候选”停止分类；没有腾讯官方业务定义可以据此断定哪个 Cookie、会话生命周期或权限环节造成它。完整 jar 在本次书架健康门禁中仍未获明确有效状态，故不能把先前搜索的 `-2012` 单独归因为少送两个 Cookie；两个探针测试的端点不同，**尚未实测完整 jar 对目标搜索的结果**，也未检验正常官网页面上下文。下一阶段若要研究页面内请求，应另列来源与门禁，不在本次流程续发。

本次没有把凭据、Cookie 值、账号 ID、目标查询结果、文章标题或 URL、响应正文、私有 DB 和浏览器会话文件输出或落盘，也没有写生产库。
