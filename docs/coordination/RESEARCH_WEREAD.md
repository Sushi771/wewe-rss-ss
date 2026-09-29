# 微信读书公众号来源研究（Agent A，2026-09-29）

## 本轮结论

截至本轮，没有公开源码或本账号实测能证明目标“妈妈部落畅聊阁”（MP_WXS_3895431412）经新来源取得五篇真实文章。旧 -2041 只覆盖既测流程，不代表所有账号、公众号或接口不可用。当前唯一与旧目标列表请求有实质路径差异的线索是 i.weread.qq.com/book/articles；它还缺少可核验且适用于该接口的本人 skey/vid 认证条件，**现在不应直接发请求**。本轮未登录、未请求微信读书文章接口、未碰生产库或私有凭据。

## 已证明

1. 腾讯官方 [WeChatReading](https://github.com/Tencent/WeChatReading/tree/315698a8da1810fab0bbf24a52b38a6960e54cdc) HEAD 仍为 315698a8；本机已安装并读取 SKILL.md、book.md、search.md，版本 1.0.4。官方 [调用规范](https://github.com/Tencent/WeChatReading/blob/315698a8da1810fab0bbf24a52b38a6960e54cdc/skills/SKILL.md)使用本人 wrk- Key、Bearer、POST /api/agent/gateway、顶层 api_name/业务参数/skill_version。官方 [章节文档](https://github.com/Tencent/WeChatReading/blob/315698a8da1810fab0bbf24a52b38a6960e54cdc/skills/book.md)列 /book/chapterinfo；[搜索文档](https://github.com/Tencent/WeChatReading/blob/315698a8da1810fab0bbf24a52b38a6960e54cdc/skills/search.md)列 scope=2 公众号、scope=4 文章。这些文件没有公开 /book/articles 为 Gateway 操作，也没有提供按号持续列文的接口。交接记载本人 Key 对 /_list 的一次实测：17 个操作中没有 /book/articles；这不是本轮重放。
2. [WeBook.get_urls 固定源码](https://github.com/wnma3mz/wechat_articles_spider/blob/f8b31196e88045d079901812ea064ad4953d62a6/wechatarticles/ArticlesUrls.py#L654-L718)实际向腾讯 i.weread.qq.com 发 GET /book/articles，拼 bookId=MP_WXS_数字后缀、count=20、offset、秒级 synckey，头含自定义 skey、vid，返回时仅提取 reviews[].review。源码把缺少 reviews 的错误回包也转成空列表，不能拿它的空结果判断“无文章”；它没有提供 skey/vid 的获取或续期实现。WeBook 代码由 [2021-02-10 提交](https://github.com/wnma3mz/wechat_articles_spider/commit/85a679db33)引入；2022-01-14 对同文件的最后提交改的是其他 get_urls/脚本尾部，未更新 WeBook。仓库 HEAD 仍是 f8b3119；检查 2026-09/08 新建的三个最近 fork，HEAD 也均为同一 f8b3119，不能将“最近 fork”当近期成功证据。
3. [weread-omni Eink 2.1.2 端点目录](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/docs/endpoints.md#L319-L324)列 GET /book/articles，归 ArticleService/BaseArticleService，参数有 bookId/count/createTime/maxIdx/offset/synckey/topshelf，标记“—”表示 SDK 未用；[同目录](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/docs/endpoints.md#L380-L386)将 /mp/chapters 归 MPListService。服务类与路径确实不同，但目录本身不证明 2026 年有成功回包、正确参数组合或认证。
4. weread-omni 的[实际取文代码](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/api/resources/public-accounts.ts#L600-L633)仍调用 /mp/chapters。2026 年 [CyrusNee/weread fork](https://github.com/CyrusNee/weread/blob/cab52f3035008f2df8ce6cce6e821cfb819e2bca/src/api/resources/public-accounts.ts#L600-L633)同样如此；[wechrss 的请求处](https://github.com/johamwon/wechrss/blob/main/wechat_mp_fetcher.py#L1930-L1958)也走 /mp/chapters。[weread-mp 的请求处](https://github.com/steptian/weread-mp/blob/e7869918144f592d5cc485946f0bfa0e68737622/weread_mp.py#L1859-L1870)走 /web/mp/articles。它们的包装、Feed 和 README 功能声明均未形成第三条新列表通道。
5. [we-mp-rss 当前实际代码](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/core/wx/model/weread_mp.py#L1515-L1546)以 /web/mp/articles 为多篇主路径，失败才退 [/api/mp/cover](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/core/wx/model/weread_mp.py#L1706-L1726) 的单篇最新文章。2026-09-04 [维护提交](https://github.com/rachelos/we-mp-rss/commit/c0dc66e9ab)称列表“实测可用”；2026-09-16 的[使用者 issue #467](https://github.com/rachelos/we-mp-rss/issues/467)描述了实际 reviewId 的短链错误。这些是一手证据，支持“该 Web 列表没有全球永久失效”，但未覆盖本账号/目标号，也没有把旧失败路径变成新实验。其[解析代码](https://github.com/rachelos/we-mp-rss/blob/126993c81a00466e9a6bbab041eef34ab27abe9c/core/wx/model/weread_mp.py#L1375-L1427)区分 reviewId、mpInfo.originalId、mpInfo.time 与 review/group createTime；后两者含义须由真实原文校验，不能无条件把评论创建时刻当文章发布时间。
6. 既有 [完整客户端审计](../WEREAD_CLIENT_FLOW_AUDIT.md)已核对本人的 Eink 同类登录、书架、续期和 /mp/chapters 首屏；续期后目标仍 499/-2041。既有 [交接](../DEVELOPMENT_HANDOFF.md)记载官方 Edge Reader 自发 /web/mp/articles 首屏也无文章、官方 Gateway 目标章节为空、文章搜索 HTTP 499。以上都不是本轮新请求。

## 认证边界

| 凭据 | 有依据的来源及适用处 | 不能推断 |
| --- | --- | --- |
| wrk- Agent API Key | 腾讯官方 Gateway 文档；Key 绑定 vid，Gateway 自行注入用户身份 | 不能用作 i.weread.qq.com/book/articles 的 skey，也不能把未列入 /_list 的路径作为 api_name |
| Web Cookie（wr_vid、wr_skey、wr_rt 等） | 本项目 Web 登录及 weread.qq.com/web/*；现有 weread.service.ts 的旧 Web 路径还把 accessToken 赋给 wr_skey | Cookie 字段名相似不证明 i.weread.qq.com 自定义 skey 头可用 |
| skey + vid | 旧 WeBook 明确作为 i.weread.qq.com/book/articles 自定义头；[2025 年 Android 客户端作者一手逆向记录](https://yumi1.top/weread-security-analysis-4/)展示另一客户端 /login 返回 vid/skey | 该记录不是本账号的字段证据，亦不是 2026 Eink 会话的映射 |
| accessToken + refreshToken | [当前 Eink 登录解析](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/auth/token.ts#L913-L994)及[请求头](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/profile.ts#L294-L307)；旧本机独立实验确实取得、续期并用于 /mp/chapters | 没有证据将 accessToken 改名为 skey 后可用于 /book/articles；不要为此重扫或重发旧接口 |
| x-wr-ticket | [KOReader 验证脚本](https://github.com/finlater/weread.koplugin/blob/main/scripts/verify_mp_articles.py#L589-L650)用于 weread.qq.com/web/mp/articles 的可选请求头；脚本写有成功预期但未附成功执行记录 | 它不是 wrk- Key、移动 skey 或 accessToken，也没有本账号旧 Reader 请求头证据；[另一用户 2026-07 日志](https://github.com/finlater/weread.koplugin/issues/62)仍多次 -2041 |

## 有证据支持，仍待验证

- /book/articles 是与旧 /mp/chapters 和 /web/mp/articles 真正不同的腾讯直连路径。只有在本人已合法取得、来源可核验且与该端点同一客户端认证体系的 skey/vid 时，才有一次最小首屏实验的根据。2025 Android 作者的登录示例与 2026 Eink 开源登录结果有字段差异，不能直接拼接两条凭据链。[2025 年另一用户一手 issue](https://github.com/yihong0618/GitHubPoster/issues/112)报告 Web Cookie 同时有 wr_skey 和 skey，但 i.weread.qq.com 请求仍 -2012，进一步说明“Cookie 里有同名字段”不足以证明可用。
- 近期 we-mp-rss 的成功描述支持其他账号可能正常取得 /web/mp/articles，但不构成对本目标重复请求的独立条件。若本人日后在官方正常流程完成验证并取得明确新的授权状态，可重新评估；不能由 Agent 猜 ticket、换 UA 或自动刷验证码。

## 推测及已排除

- 推测：/book/articles 可能返回公众号文章 reviews，也可能返回其他“文章”集合、权限错误或已变更的数据结构。旧 WeBook 的用法和当前端点目录支持前一种可能，尚无 2026 实际响应证明。返回 reviews 之后还要看每个条目的公众号身份、稳定 ID、原文 URL 和真实发布时间，不能仅凭数组长度通过验收。
- 已排除为**本轮新的实验理由**：只换 weread-omni/CyrusNee 外壳再发 /mp/chapters；只换 weread-mp/we-mp-rss 外壳再发 /web/mp/articles；把 /api/mp/cover 的单篇及抓取时刻凑成五篇；把 /book/articles 猜成 Gateway 操作；把 wrk-、Web Cookie、Eink accessToken 或 x-wr-ticket 无来源地互换。此处“排除”不表示接口对其他账户永久失效。
- [WeBook 所在仓库的公众号平台管理端代码](https://github.com/wnma3mz/wechat_articles_spider/blob/f8b31196e88045d079901812ea064ad4953d62a6/wechatarticles/ArticlesUrls.py#L301-L454)需要公众号平台登录权限，不是已证明可读取任意目标号的自助订阅入口。PC 微信、聊天库、剪贴板、抓包及 MITM 方案受项目要求禁止。

## 给 Agent B 的最小实验规范

**先离线，不发 HTTP：**只核对已经存在的、合法取得的本机隔离登录记录或私有配置的**字段名与来源**：是否有独立的 skey 与 vid，是否确由同一客户端体系的正常 /login 返回，是否有绑定的客户端版本、设备与有效期信息。不得输出任何值、长度、前后缀、哈希、完整 URL 或原始响应；如仅有 accessToken/refreshToken 或 Web wr_skey，则报告“认证前提未满足”，本轮不请求 /book/articles。不要重新扫码或通过抓包取得 skey。

**认证前提满足后**，由 B 在隔离进程对目标只发一次有来源的 /book/articles 首屏：使用 WeBook 固定源码给出的 GET 主机/路径与 bookId=MP_WXS_3895431412、count=20、offset=0、秒级 synckey；凭据头须与已证明的同一客户端体系一致，不补猜 header 或轮换参数。10–15 秒超时、无自动重试、响应上限 64 KiB；只记录 HTTP/业务码、错误类别、reviews 是否存在、条目数及可用字段名。若认证拒绝、-2041/验证码、限频或升级提示，立即停止该假设。若拿到真实 reviews，再单独核对目标号身份、五个不同稳定文章身份、原文链接与发表时间；之后才设计分页和正文实验。所有步骤不写生产库。

**当前状态：认证前提尚未证明，因此没有可立即执行的 /book/articles 网络实验。**B 可以先完成离线字段来源核对与既有 Gateway 探针诊断；总控按其结果决定是否授权首屏。
