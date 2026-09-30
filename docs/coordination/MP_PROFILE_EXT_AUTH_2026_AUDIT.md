# `profile_ext/getmsg` 与 `getmasssendmsg` 认证来源核查

核查日期：2026-09-30。只读取公开源码、文档和既存矩阵；没有读取私人凭据，也没有向目标号或腾讯列表接口发请求。本文只判断所列实现的认证链，不把某个实现的缺口推广成腾讯接口永久不可用。

## 路线判断

1. `getmsg` 的分页、文章链接解析已有可审查实现，但所审 2026 代码均在请求前**接收**个人微信会话材料，未实现从本人正常登录独立签发、续期 `uin/key/pass_ticket` 的链。`appmsg_token` 可以从带有效会话的文章 HTML 读取；它不是初始会话的替代品。
2. 旧 `getmasssendmsg` 有腾讯域名的公众号联系人“查看历史消息”入口和曾经的客户端网页授权接口说明。已审 PadChat SDK 的授权函数只向本地 WebSocket 服务发命令；真正登录、签发和腾讯请求在未交付源码的服务侧。没有找到该路线 2026 年返回文章列表、分页及跨号成功的可审查证据。
3. `Ipad860` 是更接近客户端签发层的独立线索：它在登录态上直接构造并发送腾讯 `mp-geta8key` 请求。然而当前仓库明确依赖无源码的 `v08` 动态库；返回结构指向 URL 授权，也没有连接到 `profile_ext/getmsg` 的取列表示例。它目前不能作为本项目可自行审查、构建、部署的认证 Provider。

## 已审实现与准确排除范围

### 2026 `getmsg` 调用方

- [`tingaidehua/wechat-article-downloader-skill@d97c255` 的 `provider.py`](https://github.com/tingaidehua/wechat-article-downloader-skill/blob/d97c255419e9a6de1c32bb5a9cf0f747630499bd/skills/wechat-article-downloader/scripts/wechat_article_downloader/provider.py#L26-L88)：真实发送行使用 `https://mp.weixin.qq.com/mp/profile_ext`。`_params` 从外部配置或 URL 读 `uin/key/pass_ticket`，或 `pass_ticket/appmsg_token`；`_refresh_poc_if_needed` 在已有 `uin/key/pass_ticket` 后才请求 `action=home` 补 `poc_sid/poc_token`。这是衍生票据刷新，不签发初始个人微信会话。项目的桌面客户端会话提取路径已在[来源矩阵](SOURCE_CANDIDATE_MATRIX.md)登记，不能充当本项目运行方式。
- [`haoyueb2/source-notes-ingestor@3a0b26e` 的 `wechat_discovery.py`](https://github.com/haoyueb2/source-notes-ingestor/blob/3a0b26e4c99c8828ae3836d749c69d9311b212a8/src/source_notes_ingestor/wechat_discovery.py#L163-L270)：第 163–171 行要求种子 URL 已有 `__biz/uin/key/pass_ticket`；第 174–178 行才从该文章 HTML 读 `appmsg_token`；第 236–253 行向 `mp.weixin.qq.com/mp/profile_ext` 发 `getmsg`；第 265–270 行按 `can_msg_continue/next_offset` 翻页；第 190–206 行从 `app_msg_ext_info` 及次条读 `content_url`。同仓库的[浏览器登录代码](https://github.com/haoyueb2/source-notes-ingestor/blob/3a0b26e4c99c8828ae3836d749c69d9311b212a8/src/source_notes_ingestor/browser_automation.py#L76-L108)保存 Playwright storage state，但这条 `getmsg` 函数实际从带参数的种子链接或 macOS 微信 Share Data 数据库找初始材料，未把浏览器 storage state 转换为所需字段。后者也触及本项目禁止的聊天/客户端数据库采集。
- [`wechat-article/wechat-article-exporter@b7debb6` 的 `profile_ext_getmsg.get.ts`](https://github.com/wechat-article/wechat-article-exporter/blob/b7debb65b2d45c3b1eb3dd0fa0ad55b37e612a55/server/api/web/mp/profile_ext_getmsg.get.ts#L24-L42)：代理处理器从来请求读取 `uin/key/pass_ticket` 后再调用腾讯 `getmsg`；没有登录、签发或续期。这只证明可转发已有凭据，不证明可获得它们。

这些实现描述的 `general_msg_list` 可包含 `comm_msg_info.datetime` 与 `app_msg_ext_info.content_url`；分页在源码中可见。审到的近期代码和文档**没有**附上同一目标号在 2026 年由正常可续期个人登录取得、且跨号连续分页成功的脱敏实测记录。`__biz` 作为参数并不能单独证明任意跨号授权。

### `getmasssendmsg` 与客户端授权

- [`AvengersWeChat/PadChat-SDK@f1dd594` 文档](https://github.com/AvengersWeChat/PadChat-SDK/blob/f1dd594233fbf11c2ffb8de3adea80c178edad21/docs/index.md)的公众号联系人 `brandInfo.urls` 含 `mp.weixin.qq.com/mp/getmasssendmsg`，但它仅是入口链接，不是客户端已请求、解析和分页成功的代码。文档还定义 `getRequestToken(ghName,url)` 返回 `X-WECHAT-KEY/X-WECHAT-UIN` 及授权 URL，`requestUrl` 接收这些字段。
- 同提交的 [`index.js`](https://github.com/AvengersWeChat/PadChat-SDK/blob/f1dd594233fbf11c2ffb8de3adea80c178edad21/index.js#L2444-L2477)第 2444–2449、2472–2477 行分别只 `sendCmd('getRequestToken', …)`、`sendCmd('requestUrl', …)`；第 14、50–90 行连接本地 WebSocket 服务。其 [README](https://github.com/AvengersWeChat/PadChat-SDK/blob/f1dd594233fbf11c2ffb8de3adea80c178edad21/README.md)说明服务是运行于 Windows 的 iPad 协议程序。仓库未给出该服务的登录、腾讯请求和票据续期实现，因此该 SDK 不满足运行时可审查、无闭源中转依赖；也没有 2026 成功证据。此结论只排除 PadChat 实现。
- [`meteor-nb/Ipad860@4d567bd` 的 `MpGetA8Key.go`](https://github.com/meteor-nb/Ipad860/blob/4d567bd6ee3206b5f112768225d7498abfc442b1/models/OfficialAccounts/MpGetA8Key.go)由 `GetLoginata` 读取已登录会话，构造 `GetA8KeyReq`，通过 `comm.SendRequest` 向登录态指定的腾讯短连接主机发送 `/cgi-bin/micromsg-bin/mp-geta8key`。其 [`GetA8KeyResp` 协议定义](https://github.com/meteor-nb/Ipad860/blob/4d567bd6ee3206b5f112768225d7498abfc442b1/Cilent/mm/mm123.proto)含 `FullURL/A8key/Cookie`；这并不等同于可直接用于 `getmsg` 的 `uin/key/pass_ticket/appmsg_token` 组合。[`clientsdk/v08/v08.go`](https://github.com/meteor-nb/Ipad860/blob/4d567bd6ee3206b5f112768225d7498abfc442b1/clientsdk/v08/v08.go#L20-L31)加载 `v08.dll` 或 `libv08.so`，而 [README](https://github.com/meteor-nb/Ipad860/blob/4d567bd6ee3206b5f112768225d7498abfc442b1/README.md)明确说 `v08` 源码未知。固定提交日期为 2025-08-20；未见 2026 取列表回包证据。此线索提示授权生命周期可能在登录客户端的 `GetA8Key` 层，不能据此省略动态库或推断历史列表可用。
- 历史 [`WeixinBot` Web 微信登录实现](https://github.com/urinx/WeixinBot/tree/d9edcd2c9203fe7dd203b22b71bbc48a31e9492b)的 `webwxnewloginpage` 会返回同名 `wxuin/pass_ticket`，但没有 `getmsg/getmasssendmsg` 调用或 `key/appmsg_token` 签发映射。不同产品会话中的字段同名不构成凭据可转换证据；该仓库最终提交亦早于 2026。不能以它设计新在线探针。

## 下一条可验证条件

仅当公开实现或腾讯第一方材料给出**完整且可审查**的本人正常登录 → `getmsg` 所需初始凭据签发/续期 → 同一会话请求腾讯历史列表的代码或近期成功记录，且不依赖桌面微信采集、抓包、未知动态库或闭源服务时，再设计一次只读低频隔离验证。对 `getmasssendmsg` 还须先有真实发送行及列表/翻页响应证据；目前只见入口链接。公开文章 HTML 正文下载可以另行研究，不能填补自动订阅列表缺口。
