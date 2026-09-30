# `/web/mp/cover` 的一次 `-2012`：认证路径差异

日期：2026-09-30。只核固定版本公开源码、作者/使用者一手说明和总控提供的**脱敏**单次结果。本轮没有登录、读取私有凭据、请求腾讯端点或重放目标封面。

## 本账号已经得到的边界

总控在既有合法 mobile Refresh 后，用私有恢复文件中的同账号移动 token 于新隔离 BrowserContext 正常调用一次 `/web/login/session/init`：HTTP 200、五个适用的 Web Cookie、`wr_vid` 与该账号匹配。接着**唯一一次** `GET https://weread.qq.com/web/mp/cover?bookId=MP_WXS_3895431412` 返回 HTTP 200、`errCode=-2012`，没有可信 `name/title/reviewId`，没有候选文件。固定私有 marker 已持久化，未跟随、重试、取正文或写生产 SQLite。这次结果只否定**该账号、目标号、此时、mobile→Web init 所得五 Cookie、未导航页面的直接 `/web/mp/cover` 请求**能够取得封面。HTTP 200 不等于封面业务成功；`-2012` 也不能据此证明所有封面路径关闭或目标号没有文章。

项目另一独立对照已证明同类刷新后 Web 会话被 `/web/shelf/sync` 接受，目标号搜索亦能返回分页结果。因此，不能把本次 `-2012` 简化为“移动 token 无效”或“Web Cookie 全局无效”。腾讯没有在已核材料中给出该端点 `-2012` 的官方细粒度定义；账号权限、入口上下文、不同封面路径和服务端会话范围仍未区分。近期 [we-mp-rss 的作者文档第 31、41–42 行](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/docs/weread-mp.md#L24-L43)把 `-2012/-2041` 归入认证或风控、要求停测后由本人更新正常 Cookie，这是开源作者的操作解释，不是腾讯规范。[issue #442 的 2026-08-11 使用者反馈](https://github.com/rachelos/we-mp-rss/issues/442#issuecomment-5254400934)亦报告读书方案会遇 `-2012`；[另一使用者在 2026-08-14 建议续期](https://github.com/rachelos/we-mp-rss/issues/442#issuecomment-5289087559)，但两者都未标明当时是哪条封面端点，也没有受控的续期前后回包。

## ShelfSignal 的书架导航到底证明了什么

固定 [ShelfSignal `auth.py` 第 336–402 行](https://github.com/stanley6635/shelfsignal-wechat/blob/ddeb09011a10f49f8ca2ce4d2935098ba4f60967/src/shelfsignal/auth.py#L336-L402)启动**持久、可见的 Chromium profile**，先导航 `https://weread.qq.com/web/shelf`，必要时由本人扫码并重复检查页面；它没有使用本项目的 mobile→Web init。随后 [`weread.py` 第 118–155 行](https://github.com/stanley6635/shelfsignal-wechat/blob/ddeb09011a10f49f8ca2ce4d2935098ba4f60967/src/shelfsignal/weread.py#L118-L155)再导航书架、稳定读取账号，特定旧页面分支才对书架暴露的每个 bookId 明确 `context.request.get('/web/mp/cover', params={'bookId':...})`。[`_shelf_snapshot` 第 159–197 行](https://github.com/stanley6635/shelfsignal-wechat/blob/ddeb09011a10f49f8ca2ce4d2935098ba4f60967/src/shelfsignal/weread.py#L159-L197)只读取页面 HTML 和 `performance` **资源 URL 名称**；旧页面分支的 URL 名称里本来可能已有页面自己发起的 cover 请求。新版带 `data-book-type` 的 DOM 分支则返回账号列表，不通过这里的显式 cover GET。

这构成真实的**请求流程与登录方式差异**，但源码没有记录书架导航前后的 Cookie 名称/值、`Set-Cookie`、`x-wr-ticket` 或成功回包；因此既不能证明书架导航签发额外凭据，也不能排除浏览器按普通规则接收了服务端 Cookie。[`articles()` 第 218–257 行](https://github.com/stanley6635/shelfsignal-wechat/blob/ddeb09011a10f49f8ca2ce4d2935098ba4f60967/src/shelfsignal/weread.py#L218-L257)在**读文章列表前**才调用 `/web/login/renewal`；`shelf()` 中的首次 cover GET 早于该显式续期，不能把 renewal 当作已证明的封面前置条件。作者 [2026-07-31 live canary 说明](https://github.com/stanley6635/shelfsignal-wechat/blob/ddeb09011a10f49f8ca2ce4d2935098ba4f60967/docs/superpowers/specs/2026-07-31-shelfsignal-wechat-design.md#L323-L339)称当时正常会话可见书架、每号当前封面及对应正文，但只给能力结论，没有脱敏原始请求/响应或同账号“导航前失败、导航后成功”的对照；且最多一篇。

## 两个 cover 路径不能合并判断

| 固定实现 | 真正发送行和认证 | 响应与错误处理 | 近期实测的证明力 |
| --- | --- | --- | --- |
| ShelfSignal `/web/mp/cover` | [常量和 `context.request.get` 第 26–30、143–155 行](https://github.com/stanley6635/shelfsignal-wechat/blob/ddeb09011a10f49f8ca2ce4d2935098ba4f60967/src/shelfsignal/weread.py#L143-L155)：同一浏览器 profile 的 Cookie，已先由本人扫码/书架导航；源码没有显式加 ticket 头。 | [`parse_cover_payload` 第 620–645 行](https://github.com/stanley6635/shelfsignal-wechat/blob/ddeb09011a10f49f8ca2ce4d2935098ba4f60967/src/shelfsignal/weread.py#L620-L645)要求顶层 `name/title/reviewId`；[`_reject_cover_rate_limit` 第 603–617 行](https://github.com/stanley6635/shelfsignal-wechat/blob/ddeb09011a10f49f8ca2ce4d2935098ba4f60967/src/shelfsignal/weread.py#L603-L617)明确识别 `-2014`，其他业务错误会落入字段验证。 | 作者 canary 支持**另一正常浏览器会话**当时最多一篇；没有本账号、此时或额外 Cookie 的直接证据。本账号直接路径一次 `-2012` 已停。 |
| we-mp-rss `/api/mp/cover` | [`weread_mp.py` 第 191–224 行](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/core/wx/model/weread_mp.py#L191-L224)实际 `requests.get('https://weread.qq.com/api/mp/cover', params={'bookId':...})`；[`_request_headers` 第 149–162 行](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/core/wx/model/weread_mp.py#L149-L162)带调用者保存的 Web Cookie、UA、Origin、Referer；ticket 只可能用于列表，cover 不传。[`weread.py` 第 62–84 行](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/core/wx/model/weread.py#L62-L84)从配置/私有文件读 Cookie，没给该 MP 请求自动续期。 | 200 JSON 至少需 `reviewId`；缺 ID 才调用 [`_raise_response_error` 第 60–73 行](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/core/wx/model/weread_mp.py#L60-L73)，作者把 `-2012/-2041/-2010` 列为不可立即重试。`name` 不是该解析器的硬门禁；封面不含可靠发表时间，[兜底第 278–330 行](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/core/wx/model/weread_mp.py#L278-L330)用抓取时间。 | [旧文档第 5–31 行](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/docs/weread-mp.md#L5-L31)描述浏览器正常 Cookie 下的 `/api` 封面；[2026-09 PR #462](https://github.com/rachelos/we-mp-rss/pull/462)称该路径曾为单篇主路径、后来作列表失败兜底。但 [测试第 283–328 行](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/core/wx/model/test_weread_mp.py#L283-L328)封面成功和 `-2012` 都是 Mock。 |

该仓旧文档写 `/web/mp/articles` 恒 `-2041`，而 2026-09 [PR #462](https://github.com/rachelos/we-mp-rss/pull/462)及当前代码又称列表可用；这是**历史文档与后续实现/作者报告不一致**，不能拿旧文档的“恒失败”推断本账号，亦不能把 PR 文字当成 `/api/mp/cover` 当前成功回包。[2026-09 issue #467](https://github.com/rachelos/we-mp-rss/issues/467)的使用者确实报告自己采集到了真实 `reviewId`，但没有说明它来自列表还是 `/api` 封面；[issue #465](https://github.com/rachelos/we-mp-rss/issues/465)及其 9 月评论则有多名用户报告已授权而列表为空。这些相反反馈只证明跨账号/流程差异，不能代替本目标验证。

## 决策与剩余证据缺口

- **立即停止**：不重发本账号同一 `/web/mp/cover`，不因 `-2012` 在 `/api/mp/cover` 上盲试同一 Cookie，也不自动扫码、猜 ticket 或补页面背景请求。
- **仍可离线调查**：固定版本腾讯 Web 前端公开静态代码是否明确在书架导航后新增认证 Cookie/票据、是否当前主动用 `/api/mp/cover`；维护者是否提供脱敏、可复核的 2026 `/api` 成功状态/字段与正常登录来源。只有得到与已失败会话**实质不同且合法可持续**的认证或一手响应证据，才交总控单独审一次低频方案。
- 即使另一个 cover 未来可用，它只给**当前一篇**，不能替代五篇身份/真实发布时间、分页、正文和图片验收，也不能作为完整后台订阅目录。
