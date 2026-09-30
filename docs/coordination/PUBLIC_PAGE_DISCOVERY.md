# 目标文章公开页到合集的发现证据（C 线，2026-09-30）

## 已核实结论

目标号 `妈妈部落畅聊阁 / MP_WXS_3895431412` **已有两条本人在 2026-09-27 从目标官方原文发现、并从腾讯公开合集接口取到列表的合集**：`徐汇区`（`2527940920407949313`）与 `复旦数学营`（`3588220544052641807`）。原文 HTML 内嵌 `appmsgalbuminfo`、`album_info_list` 和 `album_keep_read_info`；即使原文分享 URL 没有 `cur_album_id`，至少这些已核验文章仍可直接给出所属合集的官方链接。参见先前的[实际请求与身份记录](../CHANNEL_INVESTIGATION.md#公开合集的真实多篇列表验证)。

这修正了[上一轮公开来源报告](RESEARCH_WECHAT_PUBLIC.md)中“目标旧 URL 没有 `album_id`”被扩大成“目标没有合集 ID”的结论。**旧 URL 参数为零**只说明 URL 本身不带该参数；2026-09-27 保存的官方页面、腾讯合集 JSON 与目标 feed 配置都含两条确切 ID。两个合集不等于目标号全史或持续完整更新；2026-09-27 的文章不能当成 2026-09-30 新取到的五篇。

## 本地一手材料与复核方式

只读检查本机临时目录中的八份目标原文 HTML：六份 `wewe-identity-*-20260927.html`，以及 `wewe-target-second-article-20260927.html`、`wewe-target-proxy-article-20260927.html`。文件修改时间均为 2026-09-27。对应的 `wewe-short-long-identities-20260927.json` 记录了八篇短链与腾讯长链 `biz/mid/idx/sn` 的逐项身份匹配；八篇均有 `#js_content`，均匹配目标 `biz=Mzg5NTQzMTQxMg==`、可信目标库记录与原文发布时间。六份 identity 文件的原文日期分布在 2026-01 至 2026-08，另两份为 2026-08-18 与 2026-09-26。这些材料是旧实测原始证据，不提交 Git，不作为当前增量结果。

八份 HTML 各有且仅有一个 `var album_info_list` 条目；其中七份指向 `复旦数学营`，一份指向 `徐汇区`。每项 `link` 均为 `mp.weixin.qq.com/mp/appmsgalbum`，其 `__biz` 等于目标 `biz`，`album_id` 与两条已知 ID 之一一致；页面中的 `appmsgalbuminfo.album_id/link` 提供同一所属合集。页面 `var target_album_info` 在没有 `curAlbumId` 时选 `album_info_list[0]`，因此发现不依赖分享 URL 提前携带 `cur_album_id`。`album_keep_read_info` 同时含所属 `album_id` 与前后篇腾讯 `/s` 短链；八份中前篇均非空、七份后篇非空。短链自身不带可直接信任的 `biz/mid/idx`，只能作为待逐篇核验的有限邻接线索，不能当成全号列表。

同目录中四份 2026-09-27 腾讯原始 `getalbum` JSON 只读统计：两合集分别返回 `10+3`、`10+9` 条，四页 `base_resp.ret=0`，最终 `continue_flag=0`，共 32 个不同 `msgid+itemidx`；32 个条目 URL 都是腾讯原文 URL、`__biz` 都是目标号。其中 13 个 `create_time` 位于 2026-08-19 之后，最新为 2026-09-26。`徐汇区` 13 条中近期仅 1 条，`复旦数学营` 19 条中近期 12 条。`create_time` 与原文 `ct` 曾差几十秒，须以实际原文时间核对发布时间。原始 JSON 含不应提交的字段，因此本报告只保留上述脱敏聚合。

生产 SQLite 仅以 `mode=ro` 核对：目标 feed 的 `public_album_ids` 已配置这两条 ID。未读取或改写凭据、文章正文和生产数据。现有目标号 194 篇及两个合集 32 条不能推定完整覆盖，尤其没有“该号所有合集”的已证枚举接口。

## 公开页能力边界

| 入口或字段 | 一手依据 | 能得到什么 | 仍缺什么 |
| --- | --- | --- | --- |
| 目标官方原文 `/s` 或 `/s?...` | 八份已保存 HTML 的 `appmsgalbuminfo` 与 `album_info_list` | 已关联文章所属的确切腾讯合集链接、账号 `biz`、正文和原文时间 | 不能保证每篇都有合集，也不列出该账号其他合集；当前新文章仍需重新访问并核验 |
| `album_keep_read_info` | 八份已保存 HTML | 所属合集的前后篇短链，七份有两个方向 | 不是全号列表；短链身份需打开原文或与已验合集列表比对 |
| `/mp/appmsgalbum?action=getalbum` | 四份旧腾讯响应、[当前 RSSHub 直接请求腾讯的源码](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/wechat/msgalbum.ts)、[开源翻页源码](https://github.com/SlowGrowth1314/opencli-weixin-album/blob/c45aed6516e8682202d45a3ff5ee1cdc6d3fe0f2/download-album.ts#L337-L365) | 已知 `__biz+album_id` 的单合集列表、`msgid/itemidx/create_time/url` 与分页游标 | 2026-09-30 的目标首屏和增量须复测；一个合集不覆盖全号 |
| `/mp/profile_ext?action=home/getmsg` | 目标原文内联代码会构造官方 `action=home` 链接；[旧列表源码](https://github.com/happyjared/python-learning/blob/master/wechat/wx_mps.py)要求 `pass_ticket/appmsg_token/Cookie`；[既有实测](../CHANNEL_INVESTIGATION.md#本轮架构与实测结论2026-09-27-1256-起优先于下方历史记录) | 原文能指向公众号主页身份 | 不证明匿名可读全号列表；已有无会话 `no session` 和目标会话空列表，不能无新依据重发 |
| `/mp/homepage` | [RSSHub 专门路由的真实 POST](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/tingshuitz/guangzhou.ts)要求特定栏目 `hid/sn` | 已知栏目时可能取栏目列表 | 八份原文及旧 URL 没有目标栏目的 `hid`；文章 `sn` 不等于栏目 `sn`，当前不能构造目标请求 |

旧 HTML 的 `album_info_list` 是页面脚本变量，内联代码另有 `openAlbumPage` 函数接受 `albumLink` 并拼接场景、当前 `msgid/idx` 等导航参数；已证这不是正文中偶然出现的合集字符串，但未追到把该变量传入函数的具体调用点。[腾讯公开合集客户端 JS](https://res.wx.qq.com/mmbizwap/zh_CN/htmledition/js/album/appmsg/album80ec10.js)实际对 `/mp/appmsgalbum?action=getalbum&__biz=...&album_id=...&count=...` 发 GET，并在翻页时加 `begin_msgid/begin_itemidx`。本机保存的同版本脚本在 2026-09-27 第 380–381 行也有该请求构造。文章页内的 `profile_ext?action=home` 代码在部分客户端切到原生 `profile`；它不是新的网页文章分页证据。

## 2026-08 新开源发现代码的实际范围

[vmxmy/wechat-article-exporter 的 PR #21](https://github.com/vmxmy/wechat-article-exporter/pull/21/files) 含 2026-08-21 commit `4317a0b`，确有可审查的零凭据实现。[`fetchArticleDocument`](https://github.com/vmxmy/wechat-article-exporter/blob/4317a0b76c53a5c75074df9dd837732eb02dfcd1/cli/internal/wechat/discovery.go#L209-L250)只对允许的腾讯文章 URL 发 GET，并设浏览器 User-Agent；[`ResolveArticleAlbums`](https://github.com/vmxmy/wechat-article-exporter/blob/4317a0b76c53a5c75074df9dd837732eb02dfcd1/cli/internal/wechat/album_discovery.go#L34-L130)按 `tag_name/tag_content_num/album_id`、`appmsgalbuminfo`、裸 `album_id` 顺序解析页面脚本，读取 `var biz` 或合集链接中的 `__biz`。[`ListAlbumArticles`](https://github.com/vmxmy/wechat-article-exporter/blob/4317a0b76c53a5c75074df9dd837732eb02dfcd1/cli/internal/wechat/album.go#L68-L134)不再强制管理后台会话，实际 GET 腾讯 `/mp/appmsgalbum`，参数含 `action=getalbum`、`__biz`、`album_id`、`begin_msgid`、`begin_itemidx`、`count`、`f=json`。它与本项目旧目标合集成功实验是**同一个列表端点**，新差异是从文章 HTML 自动解析所属合集。

将该 commit 的三条正则逐字离线应用于上述八份**真实目标 HTML**：每份 `tags` 模式匹配一个、`appmsgalbuminfo` 模式匹配一个；裸模式虽有多处命中，每页也只有一个不同合集 ID。八页匹配的 ID 均属于已知两合集，没有发现第三个。旧腾讯合集 JSON 的 32 个文章 URL 均无 `cur_album_id/album_id` 参数；若要扩展到其他合集，须继续核验其他文章自身 HTML 的 membership 字段，而不能由列表 URL 猜出。

该 fork 的 [`album discover <article-url>` CLI](https://github.com/vmxmy/wechat-article-exporter/blob/4317a0b76c53a5c75074df9dd837732eb02dfcd1/cli/internal/app/commands_accounts.go#L512-L536)只解析**一篇**文章；`album traverse` 是另一命令，没有看到自动递归调度代码。[issue #20](https://github.com/vmxmy/wechat-article-exporter/issues/20)称可重复“文章→合集→文章”向外扩散、曾匿名得到 `ret=0`，但未提供目标号覆盖结果；仓库的[单元测试](https://github.com/vmxmy/wechat-article-exporter/blob/4317a0b76c53a5c75074df9dd837732eb02dfcd1/cli/internal/wechat/discovery_test.go#L202-L298)使用合成 HTML 与 `httptest`，不能算 2026-09-30 真实请求。其裸 `album_id` 回退匹配范围较宽；接入本项目时仍须以实际腾讯合集链接和账号 `biz` 交叉核验。该 fork 其他个人微信凭据/MITM 路径不在 C 线候选中。

## 2026-09-30 一篇未缓存目标原文的有界请求

独立合集 Probe 当日确认 `复旦数学营` 当前 19 个 `(msgid,itemidx)` 与 2026-09-27 旧 19 个完全相同（排序集合 SHA-256 `22fd9c1653c5f4eb2c41b7482f9ac6e82d42e649f20e70dbebf2d9570952625d`）。从旧腾讯 JSON 中排除八份已保存 HTML 的身份后，尚有 13 个未保存原文候选；选第一页第一条，列表 `create_time` 日期为 2026-09-19。旧列表给出腾讯 `http://` 长链，按[近期开源实现的文章 URL 升级流程](https://github.com/vmxmy/wechat-article-exporter/blob/4317a0b76c53a5c75074df9dd837732eb02dfcd1/cli/internal/wechat/discovery.go#L434-L442)只把协议升级为 HTTPS，保留 `__biz/mid/idx/sn/chksm`，删除 fragment。该 URL 属 `mp.weixin.qq.com/s` 且列表 `__biz` 与目标一致。未打印完整 URL、文章标题或文章身份值。

只进行**一次**匿名 GET：禁用代理与重定向、不带 Cookie、无重试，使用上述开源客户端的公开浏览器 User-Agent 及腾讯同源 `Referer/Origin`。返回 HTTP **200**、`text/html`、3,493,321 字节、无跳转；发现 `#js_content`，并可解析十位原文 `ct`（UTC 日期同为 2026-09-19）。简化 HTML 解析在正文节点开始后发现 3 个 `img`，均有 `data-src`；其节点结束界未做严格 DOM 验证，故**不能**据此验收完整正文图片。页面 `appmsgalbuminfo` 和 `tag_name/tag_content_num/album_id` 各匹配一个合集 ID，均属于已知两 ID；未见第三 ID。实际 `<a href>` 中没有腾讯 `/mp/profile_ext` 或 `/mp/homepage` 入口。`has_related_article_info` 字符串存在，但本次没有解析其值或相关文章身份，不能称已取到相关文章列表。

本次旧 `var biz/mid/idx` 提取正则未得到与请求 URL 一致的三元组；采集脚本只报告三个布尔比较为 false，未区分字段缺失和字段异值。响应未保存，按一次请求上限**不重新请求**，因此这篇仍缺原文身份闭环，不能算“新取到一篇目标真文章”，也不能作为五篇门槛的一部分。`album_info_list` 这次没有单独提取，`appmsgalbuminfo/tags` 的无新 ID 结论仅覆盖这两个字段，不排除前者单独列出其他合集。后续若有独立新文章或正常访问机会，解析器须同时记录身份字段的**存在性及是否匹配**、`album_info_list` 的官方链接与账号归属、严格 DOM 内图片计数，只保存脱敏摘要；遇验证码则停止该 URL，不为补本次缺项重发。

## 原文身份解析的离线复核（未再次请求腾讯）

一次性探针使用 `\bvar\s+<name>\s*=\s*["']([^"']*)["']`，仅接受带引号的 `biz/mid/idx`；三个结果只输出“等于请求 URL 吗”，没有输出“字段存在吗”。把**完全相同**的正则离线应用于八份 2026-09-27 目标原文，`biz/mid/idx` 均逐项匹配（各 8/8），所以正则本身没有普遍的语法错误，但不证明 2026-09-30 那份未保存响应的字段内容或格式。较新的 [Python 原文解析器 commit `060fb3d` 第 27–33 行](https://github.com/jj-cheng25/weixin-articles-mcp/blob/060fb3dd7e41d1c0950a19bc1367d66a6881f915/src/weixin_articles_mcp/parser.py#L27-L33)允许 `mid/idx` 为**无引号数字**，其[第 147–211 行](https://github.com/jj-cheng25/weixin-articles-mcp/blob/060fb3dd7e41d1c0950a19bc1367d66a6881f915/src/weixin_articles_mcp/parser.py#L147-L211)从 `#js_content`、`var ct/biz/mid/idx` 填文章模型。它仍依赖 `var biz`，不能单独解决该变量缺失的页面。现有本项目 TypeScript [`articleIdentity` 第 42–65 行](../../apps/server/src/collection/article-page.ts#L42-L65)也仅接受引号包裹的四个 `var` 字段；2026-09-30 的单篇探针没有调用其他身份解析器。

与此不同，[Go 开源实现 commit `4317a0b` 的 `extractPayload` 第 26–75 行](https://github.com/vmxmy/wechat-article-exporter/blob/4317a0b76c53a5c75074df9dd837732eb02dfcd1/cli/internal/processor/extract.go#L26-L75)优先读取 `window.cgiDataNew`，再试嵌入 JSON 与旧 `window.cgiData`；[第 157–198 行](https://github.com/vmxmy/wechat-article-exporter/blob/4317a0b76c53a5c75074df9dd837732eb02dfcd1/cli/internal/processor/extract.go#L157-L198)限定在 `<script>` 中找赋值、要求右侧为 `{`、找平衡对象；[`normalizeArticle` 第 17–53 行](https://github.com/vmxmy/wechat-article-exporter/blob/4317a0b76c53a5c75074df9dd837732eb02dfcd1/cli/internal/processor/normalize.go#L17-L53)把 `bizuin/mid/idx/sn` 映射为身份，把 `ori_create_time/ori_send_time/create_timestamp` 映射为原始发布时间，并把显示用 `create_time` 另存。此代码**没有执行页面 JS**，对象字面量由[受限解析器第 26–96、99–153 行](https://github.com/vmxmy/wechat-article-exporter/blob/4317a0b76c53a5c75074df9dd837732eb02dfcd1/cli/internal/processor/object_parser.go#L26-L153)读入；它拒绝不支持的表达式与重复键，并限制体积和嵌套深度。

八份已保存目标 HTML 均有 `window.cgiDataNew = {…}`。离线只在该赋值所在 `<script>` 内找标量键，`bizuin/mid/idx/sn` 与已核验目标长链各 **8/8 一致**；`bizuin` 已是与 URL `__biz` 相同的 Base64 字符串，无需转换或把 `user_name` 当 `biz`。`ori_create_time/ori_send_time/create_timestamp` 各 8/8 等于同页 `var ct`，显示字段 `create_time` 不应直接当 Unix `ct`。这仅复核旧八篇，不能追认未保存的 2026-09-30 响应。

对象**不是严格 JSON**：对八份 `window.cgiDataNew` 直接用标准 JSON 解码均因无引号键失败；按字符串转义状态进行只读平衡括号扫描，八份都有嵌套对象、单引号字符串和转义字节，深度最高为 5，单对象约 40–292 KB。实现时须限定腾讯原文页、状态与正文节点，扫描 `<script>` 后用有大小/深度界限的 JS **字面量**解析器读取对象，拒绝函数调用和表达式；不可用 `eval`/`Function`，也不能对整个 HTML 用一个跨脚本正则。再以请求 URL 和腾讯合集列表的 `__biz/mid/idx/sn` 独立对照对象字段，以原文 `ct`/原始时间和正文节点复核。当前没有在这八份 HTML 上运行该 Go 程序；上述四字段核对使用受限于同一个 `<script>` 的离线标量提取，完整 Go 解析兼容性仍需回归。

其他元数据并非可靠替代：八份旧 HTML 的 `og:url` 与 `var msg_link` 都存在，但均为不含完整 `__biz/mid/idx` 的短链；`var appuin` 和 `var itemidx` 均为空。`window.cgiData` 也出现，但其对象未包含上述身份键；`appmsgext` 字符串出现却没有可用的对象赋值证据。故不能仅凭这些字段或 9 月 30 日探针的三个 `false` 声称新页身份冲突。若以后有**另一篇**合法公开原文，首个验证只记录各候选字段“存在/格式/与 URL 及合集相符”的脱敏布尔值，并把无法闭环的结果留为未知。

## 相关文章与页面导航：新的腾讯端点，尚未请求

八份旧目标原文均引用腾讯官方版本化脚本 [`appmsg.muihhh087c466445.js`](https://res.wx.qq.com/mmbizappmsg/zh_CN/htmledition/js/assets/appmsg.muihhh087c466445.js)。2026-09-30 只读取这份**公开静态 JS**，SHA-256 为 `97ef18b57ed7a313da9be9857f401514f8f73adff05fa92c5f6f161dc0905cd1`；未再次请求目标文章或下述数据接口。脚本偏移约 149700–152800 的 `mp-related-article` 组件先在显示条件、`extRes` 完成、无本地缓存时，向同源 `/mp/relatedarticle?action=precheck` 发 GET；仅当 `base_resp.ret=0` 且 `empty_scene=0`，才向同一路径 `action=directgetlist` 发第二个 GET。两个请求的明文参数均为 URL 编码的当前 `article_url`、`__biz/mid/idx`、`has_related_article_info`、`is_pay`、`scene/subscene`、`is_open_comment`，订阅场景可加 `is_from_subscribe=1`。成功响应读取 `list[]`、`more_url`、`show_rec_reason` 等；UI 使用每项 `url/mid/idx/nickname/username/send_time`，并从各条 URL 解析 `__biz` 作上报。源码未见公众号筛选、`begin/count` 或游标；`more_url` 由响应提供，静态页面未提供它，不能预设为分页接口或同号文章。

认证仍待实测确认。该脚本调用腾讯 [`page_utils.muihhh089d3b1886.js`](https://res.wx.qq.com/mmbizappmsg/zh_CN/htmledition/js/assets/page_utils.muihhh089d3b1886.js) 的 `ajax`（2026-09-30 读取的 SHA-256 `8263dec0b6cdd8373e65d5ddefd8802a0f54a1bb13dee91bb2967fe86165c41e`）：偏移约 13558–14500 的 `joinUrl` 会在变量存在时附加页面的 `uin/key/pass_ticket/wxtoken/appmsg_token` 及客户端版本、`__biz`、`x5/f=json`，`joinUserArticleRole` 再加作者身份标志；偏移约 20400–26200 的 Ajax 包装器可走普通同源 XHR 或受支持微信客户端的转发。代码**没有证明**匿名直接请求可得到列表，也没有证明必须有有效私有会话。若独立审查认为值得低频验证，应先只读请求一次 `precheck`，记录 HTTP、腾讯 `base_resp/empty_scene` 与账号身份的脱敏结果；仅在其返回可用且用户授权范围明确时，另行考虑 `directgetlist`。不得复用旧目标页中看似非空的 `uin/key` 作为可用凭据证据，也不得把微信客户端转发作为产品运行方式。

已保存的八份目标 HTML 离线核对：`related_article_info.has_related_article_info` 与页面 `hasRelatedArticleInfo` 均为 **8/8 等于零**，`relatedArticleFlag` 的字面赋值均为空；`related_article_info` 仅有标志和付费/红包信息，未内嵌 `list`，`related_tag` 八份均为空，出现的 `at_biz_list.list` 五份也均为空。每页 `album_info_list` 仍只指向自己的已知目标合集，未由这些字段发现第三个目标合集。零标志不等于该端点永远返回空推荐，尤其未保存的 9 月 30 日文章只知道出现了字段名，**不知道值**。即使 `directgetlist` 可用，它也是与当前文章相关的推荐结果，可能跨号、数量有限且无已证分页；只有逐项核对 `__biz/mid/idx/send_time` 并证明稳定覆盖后，才能讨论作为目标号增量发现来源。

## 公开页面静态 JS 的实际发现链与全号边界（离线补核）

本节只检查 2026-09-27/30 已保存的腾讯官方页面与其公开静态 JS，不再 GET 本轮已尝试的三篇文章，也没有请求下表的数据端点。复核版本为 [`appmsg.muihhh087c466445.js`](https://res.wx.qq.com/mmbizappmsg/zh_CN/htmledition/js/assets/appmsg.muihhh087c466445.js)（SHA-256 `97ef18b57ed7a313da9be9857f401514f8f73adff05fa92c5f6f161dc0905cd1`）、[`page_utils.muihhh089d3b1886.js`](https://res.wx.qq.com/mmbizappmsg/zh_CN/htmledition/js/assets/page_utils.muihhh089d3b1886.js)（`8263dec0b6cdd8373e65d5ddefd8802a0f54a1bb13dee91bb2967fe86165c41e`）和[合集客户端 `album80ec10.js`](https://res.wx.qq.com/mmbizwap/zh_CN/htmledition/js/album/appmsg/album80ec10.js)（`e030ebc65a902d3f010c6466ada9bc8c3d520eefa5b42d960eb93471bd395fbd`）。以下偏移是本机已保存文件按 UTF-8 解码后的**字符位置附近**，方便定位压缩后的单行代码。

| 从文章出发的路径 | 真正导航或请求代码 | 当前目标样本与能力边界 |
| --- | --- | --- |
| 文章 → 所属合集卡片 | `appmsg` 偏移约 68800 的 `ka.init` 读卡片 `data-url` 并经 `ht.goUrl` 导航；偏移约 69900–70700 的 `mp-album` 组件把 `cgiData.album_info_list` 逐项渲染为 `i.link.htmlDecode() || "/mp/publictag?action=get&tag_id="+i.tagId+"&start=0"`。`store.muihhh084bc1a202.js` 偏移约 45300 将全局 `window` 交给 `cgiData`。 | 八份已保存目标 HTML 的 `album_info_list` 均只有一个条目，`link` 均指向目标官方 `/mp/appmsgalbum`，`tagId` **8/8 为空**；因此 `/mp/publictag` 是有源码的一条**条件回退导航**，目前没有目标号的有效 `tag_id` 种子，不得用 `album_id` 冒充。它即使可用也按一个 Tag 导航，不是已证的全号合集枚举。 |
| 已知合集 → 文章列表 | `album80ec10.js` 偏移约 14700–15600 对 `/mp/appmsgalbum?action=getalbum&__biz=<window.biz>&album_id=<cgiData.albumId>&count=<pageCount>` 发 GET，继续时带 `begin_msgid/begin_itemidx`，消费 `getalbum_resp.article_list/continue_flag`。 | 合集 ID 必须先由文章页面或其他合法来源取得。该脚本在这个版本中没有“以 `biz` 枚举该号全部合集”的请求；它只翻当前合集。两份已保存目标合集 HTML 的 `window.cgiData` 只预载本合集 `articleList`，均无 `mp_msgs` 列表，`recomm_tag_page_url` 均为空。 |
| 文章 → 公众号主页 | `page_utils` 偏移约 74000–74700 以 `biz` 构造 `/mp/profile_ext?action=home&__biz=...`，根据客户端走原生 `profile`、额外 WebView、`getprofiletransferpage` 或浏览器跳转；偏移约 76500 的 `real_type=43` 为视频页导航。 | 这是主页**导航**，该代码没有发文章列表 AJAX。`profile_ext?action=home/getmsg` 的已有无会话 `no session` 与目标会话空列表实测仍单独成立；静态导航没有提供新的认证来源或覆盖证明，不据此重发旧失败请求。 |
| 文章 → 相关文章 | `appmsg` 偏移约 150100–152900 的 `precheck` 成功且非空后才 GET `directgetlist`；响应 `list[]` 和 `more_url` 进入卡片，偏移约 157200 的 `goKuaixunFeed` 仅打开**响应提供**的 `more_url`。 | 请求以当前文章 `article_url/__biz/mid/idx` 和场景字段为键，没有账号全集筛选、`begin/count` 或游标；`more_url` 未在当前八份目标 HTML 中提供。推荐结果必须逐条验证账号，不能按源码推为同号分页或持续订阅。 |

同一 `appmsg` 脚本的 `/mp/getmpext` 在偏移约 9900–10400 以当前 `bizuin/msgid/idx/token` POST，读取的是 `nominate_status` 等当前文章提名状态；`/mp/getrecreason?appmsg_list=...` 在偏移约 160900 只对已取得的推荐条目补充理由。另有 `render_utils` 中 `/mp/relatedsearchword?action=getcontentsearchword&__biz=...&mid=...&idx=...`，名称和参数指向当前文章搜索词，未见其返回文章列表的代码依据。这些请求均不能补足“按公众号完整发现新增文章”的缺口。

本轮再筛该版文章脚本的其他相似入口：`/mp/homepage` 仅出现在偏移约 127072 的“阅读原文/外链” URL 分类与加 `scene` 的导航代码，不会由当前文章 `biz` 自动生成栏目 `hid/sn`；`/mp/profileblock?__biz=...` 在偏移约 670090 的公众号点击处理器中，仅 `isprofileblock=1` 时导航，八份旧目标 HTML 的该开关均为 **0**，且这段代码没有文章列表请求；`/mp/recommendtag?action=act_report/report_feedback` 在偏移约 213304/218879 上报推荐卡片行为，而非拉取同号目录。这只排除**所审脚本版本的这些调用点**作为自动枚举依据；没有实测 `/mp/profileblock` 页面本身的内容，也不把其页面能力推为不存在。

**有条件的新最小探针**：今后若在另一篇已核验目标官方原文中看到 `album_info_list` 条目 `link` 为空、`tagId` 非空，且源码所渲染的 `data-url` 确为腾讯 `/mp/publictag?action=get&tag_id=<该页值>&start=0`，才设计一次匿名、无代理/跳转/重试的只读 GET；先看 HTTP/验证码/页面身份与是否存在列表、分页，再逐篇核 `__biz/mid/idx/ct`。目前八份目标样本均不满足触发条件，**现在不发请求**。对于 `relatedarticle`，既有报告已给出独立的 `precheck` 一次探针设计；这次静态复核没有新增认证依据或同号全集能力，不扩大该设计。

## 生产库已核验长链提供的不同文章种子（只读，待独立 Probe）

对生产 `apps/server/data/wewe-rss.db` 用 SQLite **`mode=ro`** 仅读取目标号 `verified_source_url/publish_time/content_html` 作脱敏计数：194 篇旧文章中，20 篇有非空且 `mp.weixin.qq.com/s` 的 `__biz/mid/idx/sn` 四字段齐全的已核验长链，全部 `__biz` 与目标号相同；其中 **14** 个 `(biz,mid,idx)` 不在 2026-09-27 已保存的两合集共 32 个列表键中。这里的“不在”只指当时已保存的列表结果，不证明这些文章永不属于该合集，也不证明已找到第三个合集。这 14 篇的库内日期介于 UTC 2026-09-05 至 2026-09-28，URL query 均只有四个公开身份键，没有 `uin/key/pass_ticket` 等凭据键；14 篇都有既存正文缓存，但 `content_html` 不含 `appmsgalbum/album_id/profile_ext/publictag` 字符串。数据库记录是**旧身份与正文基线**，不是 2026-09-30 新取到的文章。

从中按库内时间选 UTC **2026-09-28** 的一篇，`SHA256(__biz\0mid\0idx\0sn)` 前 16 位为 `5e44e0d46c308fe2`。筛除本轮此前三篇已请求文章；本机 19 份既存 HTML 未出现该篇 `mid+sn` 同时匹配，18 份协调/调查文档未出现该组合或摘要，`*.attempted` 哨兵为零。这个范围内**未见已请求记录**，不能证明任何历史环境都从未访问该 URL。完整 URL、标题、四字段值和原文未写入本报告。

| C 线候选 | 腾讯入口与认证 | 可获得的范围 | 发布时间、正文、图片与分页 | 与已试流程差异 | 最小验证 |
| --- | --- | --- | --- | --- | --- |
| 库内已核验长链 → 当前官方原文 → 所属合集 | 对这篇公开身份精确对应的 `GET https://mp.weixin.qq.com/s`；匿名读取情况须逐篇实测 | 单篇页面可内嵌 `album_info_list/appmsgalbuminfo`；旧八页均如此，但这篇未知。若出现新同号 `album_id`，才可接已证单合集 `getalbum` | 原文可提供 `ct/#js_content/data-src`；这条路线自身无账号分页，合集分页须另验 | 种子不在已保存两合集 32 键中；可判别是否能由**另一篇既存目标文章**发现其他合集 | 对摘要 `5e44e0d46c308fe2` 的一次探针已返回 302 并停止；不得重试该 URL，不把旧库文章当新文章或五篇验收 |

给独立 Probe 的门禁：先重新只读取得该唯一记录，确认目标 `mp_id`、官方 HTTPS `/s`、唯一四字段、无凭据参数与摘要 `5e44e0d46c308fe2`，再检查已尝试哨兵；只发一次匿名 GET，禁代理/跳转/重试、12 秒超时、6 MiB 上限，响应只留内存。遇 3xx、验证、限制、非 HTML 或正文节点缺失即停。分别在旧 `var` 与 `window.cgiDataNew` 中做**有界、无 `eval`** 的身份字段提取，只记录字段存在及是否与种子一致的布尔值；原文 `ct` 与库内时间只记录存在、可信范围及是否一致的布尔值，不用合集 `create_time` 替代。身份或时间未闭环则不解释合集。若闭环，提取 `album_info_list/appmsgalbuminfo` 中明示的腾讯 `/mp/appmsgalbum` 链接，只记录同号有效合集的**已知/新 ID 数量**和去重结果，不输出 ID、URL、标题、原始 HTML 或正文。新 ID 即使出现也只证明这篇的所属关系，须另验列表与持续更新；整次探针不写生产库。

该 Probe 对这条摘要对应的旧长链实际只发 **1 次**匿名官方 HTTPS GET，得到 HTTP **302** 后按门禁停止；没有保存 `Location`，没有进入原文身份、时间、合集解析。不能把它记为验证码已确认、账号不符、目标号无新合集或公开路线整体失效；这条 URL 本轮不再请求。上述门禁保留为本次实验的事前设计，不是再次请求的建议。

## 旧页面邻接链与本机缓存的离线覆盖核对

八份 2026-09-27 已保存的目标官方原文中，`album_keep_read_info` 有 **15** 条非空前后篇链接（8 条前篇、7 条后篇）。页面 JS 字符串用 `\x26` 编码 URL 参数分隔符；先仅在该字段内解码，再解析出腾讯 `/s` 的 `__biz/mid/idx/sn/chksm`，不能只按 URL 的 `/s` 路径比较。15 条链接对应 **11** 个不同 `(mid,idx)`，**15/15** 均已在两合集 2026-09-27 保存的 32 键列表中；与 14 个列表外已核验长链的 `(mid,idx)` 和四字段均 **0** 匹配。故这八页的前后篇邻接链没有把现有证据扩展到那 14 篇；它仍只证明所见文章附近的有限导航，不排除其他文章页面有新的所属合集。

离线以 `mid+sn` 核对本机先前审计的 19 份保存 HTML（临时目录 14 份、`output/playwright` 5 份），14 个列表外种子均无匹配原文快照。只读检查 `pc-wechat-pilot` 已保存的四份结构化元数据 JSON 与相关 `article-metrics` 缓存：所检文件没有可用于将这 14 篇映射到新合集的 `appmsgalbum/album_id/publictag/relatedarticle` 字段。生产 SQLite 的目标 `articles` 表只含旧文章身份、导出正文、指标等列，未存原始页面脚本；14 篇 `content_html` 有正文但不含这些合集标记，`metrics/source_url/pic_url` 对目标行的合集及相关文章标记只读计数亦为零。上述结果限定于这些现存缓存与字段，不能证明历史上从未访问文章，也不能证明腾讯页面不会返回新的合集。

腾讯文章静态 JS 的已审代码只从当前页面内嵌 `cgiData.album_info_list` 生成合集卡片，已知 `getalbum` 接口则要求一个先得出的 `album_id`；`album_keep_read_info` 只给前后篇，`profile_ext?action=home` 是导航而非已证的全号列表请求，`relatedarticle` 是当前文章推荐且有预检与场景条件。现有静态代码没有提供“只用 `biz/mid/idx` 枚举该号全部合集或新增文章”的可复核请求。下一次网络探针须有**另一条未尝试且身份可核的文章种子**，或实质不同的腾讯官方入口与明确认证依据；先确认其相对旧实验的判别力，并沿用一次、匿名、禁代理/跳转/重试、3xx 或限制即停的门禁。此轮先不自行发同形请求；下文继续检查正文互链，找到来源更明确的另一条种子。

## 正文同号互链：旧目标原文中发现两合集之外的身份种子（仅离线）

[近期单提交开源项目 `huanxi007/gzh-export`，固定 commit `ff6832d`](https://github.com/huanxi007/gzh-export/tree/ff6832d4fa50abd12dbe231b6cd1ac98f5675205) 提出了合集、正文互链与 Wayback CDX 的收敛组合。其[真实 HTTP 发送函数第 46–54 行](https://github.com/huanxi007/gzh-export/blob/ff6832d4fa50abd12dbe231b6cd1ac98f5675205/scripts/gzh_export.py#L46-L54)用 `urllib.request.urlopen`；[第 100–116 行](https://github.com/huanxi007/gzh-export/blob/ff6832d4fa50abd12dbe231b6cd1ac98f5675205/scripts/gzh_export.py#L100-L116)对腾讯 `/mp/appmsgalbum?action=getalbum&__biz=<biz>&album_id=<id>&count=30&f=json` 请求单合集列表并用 `begin_msgid/begin_itemidx` 翻页，**并非**新的账号级合集枚举端点。[第 353–379、420–455 行](https://github.com/huanxi007/gzh-export/blob/ff6832d4fa50abd12dbe231b6cd1ac98f5675205/scripts/gzh_export.py#L353-L455)先 GET 种子原文，按 `album_id` 正则与腾讯 `/s` 链接正则扩展池，再 GET 每篇发现的原文；其来源是**发布者在正文里放出的链接**，没有账号全集请求。其[第 119–136 行](https://github.com/huanxi007/gzh-export/blob/ff6832d4fa50abd12dbe231b6cd1ac98f5675205/scripts/gzh_export.py#L119-L136)另向 `web.archive.org/cdx/search/cdx` 查询历史 URL，这是第三方公共存档索引，不是腾讯实时订阅端点。[README 的孤篇边界](https://github.com/huanxi007/gzh-export/blob/ff6832d4fa50abd12dbe231b6cd1ac98f5675205/README.md#L177-L192)明确：未入合集、未被互链、未存档的文章无法由这三路发现；[实现笔记](https://github.com/huanxi007/gzh-export/blob/ff6832d4fa50abd12dbe231b6cd1ac98f5675205/docs/NOTES.md)自述一次 300 多篇导出，但仓库未附目标号可复核原始日志或连续更新证据。

对本项目八份已核验目标官方原文，用 DOM **只读解析 `#js_content` 的 `a[href]`**，要求腾讯 `https://mp.weixin.qq.com/s`、`__biz` 等于目标号且 `mid/idx/sn` 各恰好一个：共 **172** 个同号长链引用，按 `(mid,idx)` 去重 **63** 个，均有唯一一致的 `sn`。仅 **3** 个在已保存两合集 32 键内，另外 **60** 个不在这两份旧列表。把该项目的正文 URL 正则离线用于同一八份 HTML，也抓到这 172 条同号长链、63 个唯一四字段，证明其互链提取机制在**目标旧页面**上确有可用输入。这 60 条与库内 20 条 `verified_source_url` 的 `(mid,idx)` 零交集，也不等于八份旧 HTML 本身的文章身份；库内另有大量只有短链或不透明 ID 的旧文章，不能凭零交集断言它们是“新文章”或数据库缺失。19 份其他保存 HTML 中只有这八份可由旧 `var` 解析目标文章身份；全文中出现 `mid/sn` 往往只是引用，不能误当已保存该篇原文。八页的 `album_keep_read_info` 邻接链此前仅覆盖两合集，正文互链则是**不同的扩散来源**，但仍不是官方生成的全号目录。

选一条 60 个列表外种子中**五份**已核目标原文均在正文 `<a href>` 指向的相同长链：`SHA256(__biz\0mid\0idx\0sn)` 前 16 位 `1c9ac9e993100643`。五个来源的原文 `ct` UTC 日期分别为 2026-01-03、01-12、04-21、04-26、06-30，来源自身的 `biz` 与链接 `__biz` 一致；该链接的 `sn` 在五处一致，URL 仅含公开 `__biz/mid/idx/sn/scene`，原始 `#wechat_redirect` 片段不参与身份和 HTTP 请求。它不在两合集旧 32 键、库内 20 条已核长链、38 条可辨识数字 mid 的旧文章 ID，也不是八份旧原文自身的身份；剩余旧库 ID 不透明，**不能证明旧库完全没有这篇**。在当前本机 `.attempted` 哨兵与两工作区 87 份 Markdown 脱敏记录中没有该摘要或该四字段组合，但这只界定本轮审计范围，不证明所有历史环境均未访问。该链接本身是旧文章引用，不能用作 2026-09-30 新增文章或五篇验收。

为总控复审准备 [`public-interlink-one-shot.cjs`](../../scripts/collection-source-probe/public-interlink-one-shot.cjs)：`preflight` 从八份旧原文与四页已保存官方合集 JSON **离线唯一恢复**该 URL，并以当前已构建解析器逐页核旧文章四字段、原文 `ct`、正文和已知合集；实测 `8/8` 通过、五处候选链接完全一致、`requests=0`。`probe` 必须显式携带与摘要一致的复审标志，先以排他创建在私有临时目录写“已尝试”哨兵；其后才允许**一次**无代理、无 Cookie、无跳转、无重试、12 秒、6 MiB 上限的 HTTPS GET。3xx、验证码、频控、非 HTML 或超限即停；200 页面按 `#js_content`、`articleIdentity` 四字段逐项布尔、原文 `ct`、正文及 `data-src` 图片、页面明示且同号的官方合集链接分阶段记录，只输出脱敏布尔和数量。未带复审标志的离线拒绝路径也实测 `requests=0` 且未创建哨兵。**本轮未在线运行 `probe`。**

原项目脚本不能直接当本项目的安全探针：[第 405–418 行](https://github.com/huanxi007/gzh-export/blob/ff6832d4fa50abd12dbe231b6cd1ac98f5675205/scripts/gzh_export.py#L405-L418)在某些失败后追加无依据 `chksm=1` 变体，[第 480–507 行](https://github.com/huanxi007/gzh-export/blob/ff6832d4fa50abd12dbe231b6cd1ac98f5675205/scripts/gzh_export.py#L480-L507)会对验证/限流重试与冷却；`urlopen` 默认跟随跳转，且第 441–445 行先扩散页面链接再核 `var biz`。这些行为不符合本轮单次停止门禁。它的 [`page_key` 第 89–93 行](https://github.com/huanxi007/gzh-export/blob/ff6832d4fa50abd12dbe231b6cd1ac98f5675205/scripts/gzh_export.py#L89-L93)也只解析旧 `var mid/idx`，不能替代目标四字段、发布时间和正文图片验收。上述 60 条只说明**有真实可复核的历史互链候选**；能否匿名取得候选原文、由其发现第三合集或形成持续新增文章来源仍待独立一次探针与后续增量验证。

## 长链 302 后的请求形状对照与已存短链入口（仅离线）

总控已按上述探针门禁对摘要 `1c9ac9e993100643` 发 **1 次**匿名官方长 `/s?` GET：HTTP **302**、`redirect_stop`、`requests=1`，未跟随、未保存 `Location` 或 HTML，私有已尝试哨兵保留。本 C 线不读取跳转目的，也不重发该 URL。该结果只排除**该文章、该时点、原正文给出的四字段加 `scene` 长链接、此次匿名直连形状**可直接得到可核验页面；没有进入身份、时间、正文或合集步骤，不证明是验证码，也不排除余下 59 个互链种子、两条已知合集或其他官方公开入口。

| 已发生请求 | 来源与请求形状 | 实际止步层 | 严格结论 |
| --- | --- | --- | --- |
| `5e44e0d46c308fe2` | 库内旧 `verified_source_url`；腾讯长 `/s?__biz,mid,idx,sn`，无 `chksm` | 单次 302，未留 `Location` | 该条匿名长链未读到原文；未判验证码或账号身份 |
| `1c9ac9e993100643` | 五份目标旧正文共同引用；腾讯长 `/s?__biz,mid,idx,sn,scene`，原 `#wechat_redirect` 片段在 HTTP 前移除；无 `chksm` | 单次 302，未留 `Location` | 该条匿名长链未读到原文；同号引用仍只是来源线索 |
| `792e0623ba3ee739` | 2026-09-27 保存的**腾讯官方合集条目 URL**，原有 `chksm`；仅把 HTTP 升为 HTTPS | 200 且有 `#js_content`，四字段比较至少一项不合，未留分项 | 无法确认新原文身份，不能指认为错号或可用文章 |
| `8c460d508c0aae1b` | 已核旧目标原文的官方合集条目 URL，同样自带 `chksm` | 200 且有 `#js_content`，合并的解析/规范化/时间步骤报 `parser_stop` | 无法确定失败字段或当前 `ct`；旧 HTML 的通过不能追认当前页 |

上述四次实验的文章、日期、来源与页面状态都不同；两次 200 URL 中的 `chksm` 是腾讯**已返回条目的原值**，两次 302 URL 没有它。这是请求上下文的相关性，**不是** `chksm` 决定 302 的因果证据；不得合成、猜测或把别篇签名移植到 302 URL。[近期 `gzh-export` 的 `&chksm=1` 失败变体](https://github.com/huanxi007/gzh-export/blob/ff6832d4fa50abd12dbe231b6cd1ac98f5675205/scripts/gzh_export.py#L405-L418)也不能作为本项目请求依据。没有保存两次 302 的跳转目的，不能对当前跳转机制做更细归因。

有一条**不同的、已由本项目一手历史证据支持的单篇公开入口**：官方 `/s/<22 字符短 token>`。八份 2026-09-27 已保存目标原文的 `og:url/msg_link` 为这种短链；本项目 [`resolvePublicArticle`](../../apps/server/src/collection/public-album.ts) 实际向 `https://mp.weixin.qq.com/s/<shortId>` 发 GET，随后核公众号身份及 `og:url` 短链一致；[当时调查记录](../CHANNEL_INVESTIGATION.md)记载一篇目标旧短链在线调用成功并返回原文四字段与 `ct`。但旧调用使用 Axios，可能按默认行为跟随跳转；它不证明今天短路径能独立返回 200，也不证明它可生成公众号列表。生产 SQLite 只读核对：两合集旧 32 键之外的 **14** 条已核长链所在行，各有唯一、无 query 的官方 HTTPS `/s/<22 token>` 原 `source_url`；它与同一行的 `verified_source_url` 共同提供待复核的旧身份关系。除已试长链摘要 `5e44e0d46c308fe2` 外，其余 **13** 条在本机按四字段摘要没有 `.attempted` 哨兵。不能以这种旧库配对本身代替当前原文认证。

从这 13 条中按旧库发布时间选一条 **2026-09-24** 的记录，四字段摘要 `175910fb92f9e063`；短路径无凭据参数，已存长链四字段齐全，规范旧文章 ID 与长链 `mid/idx` 一致，旧正文缓存非空，但均不是本轮新抓取。为总控复审准备 [`public-shortpath-one-shot.cjs`](../../scripts/collection-source-probe/public-shortpath-one-shot.cjs)：使用 Node 24 的 [`DatabaseSync(..., { readOnly: true })`](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) 只读定位**唯一**该行，要求短链、长链、旧 ID、旧时间、两合集旧键和已尝试哨兵均过门禁；再用已保存八份真实目标 HTML 离线核当前构建解析器的四字段、`og:url`、`ct`、正文和已知合集。`preflight` 实测 `8/8` 通过、`requests=0`、短路径哨兵不存在；无复审标志的 `probe` 实测停止且 `requests=0`、无哨兵。该脚本**未在线执行**。

若总控后续批准独立验证，脚本先排他创建私有哨兵，再仅对**已存短路径原样**发一次无代理、无 Cookie、无自动跳转/重试的腾讯 HTTPS GET（12 秒、6 MiB）；3xx、验证/频控、非 HTML 或超限立即停，不读取或保存 `Location`。若得 200，先逐项对照旧 `verified_source_url` 的 `__biz/mid/idx/sn` 与当前原文、`og:url` 与短 token，再核字面原文 `ct` 是否与库内旧 `publish_time` 相符、严格 `#js_content`、清洗后正文及图片 `data-src`，最后只记录页面明示的同号官方合集 ID 的已知/新数量；输出仅含摘要、状态、布尔与计数，不写生产库。旧库 `publish_time` 是对照值，不能先验地当成当前原文 `ct`。此入口最多验证**一篇**旧文章是否当前可读及能否发现所属合集；即使成功也不能代表账号级目录或持续订阅。

## 已核短链 200 与第三个合集 ID 的离线恢复边界（2026-09-30）

总控按上述门禁对摘要 `175910fb92f9e063` 的**原存短路径**执行一次：HTTP 200；当前原文与旧库 `__biz/mid/idx/sn`、短链 canonical、字面 `ct`、正文均匹配，`data-src` 图片 1 张；脚本在页面中数出 **1 个**不属于已知两合集、且链接 `__biz` 等于目标号的新 `album_id`。私有 `.attempted` 哨兵已写。本次取得的是**旧文章的当前可读性**，不是新增文章。脚本 [`albumCounts`](../../scripts/collection-source-probe/public-shortpath-one-shot.cjs)在整份 HTML 中扫描明示的 `/mp/appmsgalbum` 链接；这个计数只证明页面出现同号合集链接，未定位到 `album_info_list` 中哪张卡，也不能独立证明这篇文章属于该合集。响应仅在当次进程内存里解析，**没有**保存原 HTML、完整 URL、新 `album_id` 或其摘要；不能从输出的“1”反推精确 ID，不得重发该短 URL。

离线找回审计仅访问本机旧材料，按完整目标 `biz` 加数值型 `album_id/albumId` 或官方 `/mp/appmsgalbum` 链接匹配并与已知两 ID 去重；只输出计数。`%TEMP%` 顶层 37 个小型 HTML/JSON/TXT/BODY 中 15 个含目标身份、10 个有可解析合集 ID，均为旧两合集；其中 `wewe-*` 子集 23/15/10 结果相同。主 checkout 的 `output/playwright` 1333 个不超过 10 MiB 的文本候选中 26 个含目标身份，没有新的可解析合集 ID；其 77 个 SQLite 快照共 13752 条重复目标文章行亦没有。生产 SQLite 以 `mode=ro` 读目标 194 行，及两份 2026-09-27 备份各 156 行，检查 `content_html/metrics/source_url/verified_source_url/pic_url`，均无合集 ID。该扫描范围不含已退出进程的 200 响应，也不能声称网络或其他未检查资料不存在该 ID。

已保存的腾讯文章脚本 `wewe-appmsg-muihhh087c466445-20260930.js` 在偏移约 142727 让 `albumTags()` 直接返回 `this.cgiData.album_info_list`，偏移约 69–71k 用每条内嵌 `link/tagId/albumId` 渲染合集卡，没有见到按 `biz` 拉全号合集的请求；[腾讯公开合集客户端脚本](https://res.wx.qq.com/mmbizwap/zh_CN/htmledition/js/album/appmsg/album80ec10.js)及本地对应脚本偏移约 14729 的真实 GET 使用 `window.biz` **加预先存在的** `L.albumId` 请求 `/mp/appmsgalbum?action=getalbum`。`window.cgiDataNew.appmsgalbuminfo.album_id_str` 也是单篇页面携带的值，不是由旧库 `biz/mid/idx` 算出的 ID。这些具体发送/渲染点不提供本次丢失 ID 的离线逆推方法。

因此现阶段**没有精确、可复核的新 `album_id` 请求种子**，不能构造第三合集的 `getalbum` 首屏探针，不能猜 ID、借用别篇 ID 或重取已请求短链。下一次若由**另一篇未请求且已核身份**的官方页面或其他合法公开一手材料取得精确同号 ID，应先在私有临时文件保存仅该数值及其来源摘要，再只发一次匿名、无代理/跳转/重试的官方 `getalbum` 首屏；先核 `base_resp.ret`、`__biz/album_id`、文章键和 `continue_flag`，如目标旧文章确在其中再核所属关系与分页。此条件尚未满足，故本轮不发该请求；找到第三合集也仍不能推出全号目录或持续新增。

### 第二篇旧目标短链：提取归属字段的单次门禁（只做离线准备）

从上述合集旧 32 键外的 14 条已核行排除首次短链摘要 `175910fb92f9e063` 和已有长链哨兵的 `5e44e0d46c308fe2`，余下 **12** 条旧文章的原存 `/s/<22 token>` 在本机无 `.attempted` 哨兵。选择与首次不同、旧库 UTC 日期同为 2026-09-24 的四字段摘要 `9beb4db841a9c11c`；只读核对该行 `mp_id`、唯一四字段长链、无 query 的官方 HTTPS 短链、规范文章 ID 与 `mid/idx`、非空旧正文和不在旧 32 键。日期接近**不**证明同属一个合集，也不把该旧文章算新文。

[`public-shortpath-album-one-shot.cjs`](../../scripts/collection-source-probe/public-shortpath-album-one-shot.cjs)沿用一次匿名直连、12 秒/6 MiB、禁代理/跳转/重试、先排他私有哨兵及 3xx/验证/限流即停；复审标志缺失时不会发请求。HTTP 200 后先分层核当前 `__biz/mid/idx/sn`、短 canonical、字面 `ct` 与旧 `publish_time`、`#js_content`、清洗正文和图片 `data-src`。只有这些都通过，才从**内联 `<script>` 的唯一 `var album_info_list = [...]`** 有界解析静态字符串；不运行页面 JS、不 `eval`。每个条目必须同时满足 `albumId=albumIdStr=link.album_id`、官方 HTTPS `/mp/appmsgalbum?action=getalbum`、链接 `__biz` 为目标号且不含凭据参数，才能分类为页面声明的文章合集标签。整页其他同号合集链接只记数量，不能据此保存“所属” ID；字段缺失、歧义或不符只记 `absent/ambiguous/malformed`。

若出现新且严格匹配的文章合集标签，脚本仅将数值 ID、目标 `biz`、文章摘要、字段来源和时间写到用户私有 `%TEMP%/wewe-public-album-source-9beb4db841a9c11c.json`；先写随机临时文件并同步，再以硬链接原子创建目的文件，目的已存在则拒绝覆盖。日志和 Git 仅留分类、数量、摘要及私有文件是否成功写入，不留 ID、标题、原文 URL、HTML 或正文。八份 2026-09-27 已存目标官方 HTML 的内联 `album_info_list` 均通过解析并与各自已知合集链接一致（8/8）；另用合成静态字面量验证非腾讯链接与 JS 表达式拒绝，私有文件原子写与拒绝覆盖自测通过。当前候选 `preflight` 为 `requests=0`、无已尝试哨兵和私有 ID 文件；无复审标志的 `probe` 在门禁停止，`requests=0`。**本 C 线尚未在线运行该脚本**。即使它保存新 ID，仍须总控另行复审单次官方 `getalbum` 首屏并用列表键核归属。

### 第二篇短链 200 后的第三合集首屏探针（仅离线准备）

总控随后仅对 `9beb4db841a9c11c` 执行上述一次短路径 GET：HTTP 200；目标号、`mid/idx/sn`、短 canonical、字面 `ct` 与旧库、正文均闭环，`data-src` 图片 **18** 张；内联 `var album_info_list` 的同号官方 `getalbum` 链接与 `albumId/albumIdStr` 三者相同，出现 **1 个**已知两合集之外的精确 ID，私有文件写入成功。这里比前篇的“整页出现一个链接”强：来源是该旧文章页面声明的合集标签；但仍须官方合集列表确认它实际收录该文。该文章也是**旧文当前可读**，没有形成新增文章或持续更新验收。精确 ID 没有出现在日志或 Git，仍仅位于上述用户私有文件；已尝试短路径不可重发。

[`public-third-album-page1-one-shot.cjs`](../../scripts/collection-source-probe/public-third-album-page1-one-shot.cjs)只读且一次性地读取该私有文件：要求字段集合精确、文章摘要与目标 `biz` 一致、`sourceField=inline_var_album_info_list`、恰一项 10–24 位数值 ID 且不在旧两 ID 内，并检查对应短链已尝试哨兵。生产库只读重核该旧文章长/短身份与发布时间；四份 2026-09-27 官方 `getalbum` 原始 JSON 仅作离线格式回归，共 **32** 个旧文章键，候选不在其中。请求的 `action=getalbum/__biz/album_id/count=10` 与[腾讯合集客户端实际发送代码](https://res.wx.qq.com/mmbizwap/zh_CN/htmledition/js/album/appmsg/album80ec10.js)一致；`f=json` 采用[2026-09-27 本项目成功保存原始 JSON 的请求形状](../CHANNEL_INVESTIGATION.md)；完整首屏形状为 `GET /mp/appmsgalbum?action=getalbum&__biz=<目标>&album_id=<私有原值>&count=10&f=json`，**不带游标**，没有推算、猜测或输出 ID。执行门禁为总控复审标志、先排他私有哨兵、匿名直连、禁代理/跳转/重试、12 秒与 2 MiB 上限，3xx/验证/限流即停；不保存响应 JSON，因为其中可能有不应落盘的字段。

若首屏为 JSON，只输出 `base_resp.ret`、文章条数、`key/create_time/msgid/itemidx` 与各条原文 URL 的目标 `__biz`/键存在或匹配计数、`continue_flag` 是否有后页，以及候选旧文章 `mid/idx` 是否在首屏且 URL 身份是否匹配。**只有**同键及原文 URL 目标号/消息/次条身份同时闭环才记“首屏确认收录”；首屏未出现、且有后页时结论为待定，不自动续页；即使单页缺席，也只有响应明示总篇数**恰等于**本页不重复的条数且所有条目身份闭环时才记“完整单页未收录”。`create_time` 只核字段是否为有效时间，不拿它代替原文 `ct`。旧四页格式预检和旧条目阳性成员判定均通过；当前私有来源与旧文身份闭环，`preflight` 为 `requests=0`、新哨兵不存在，无复审标志的 `probe` 为 `requests=0`。**本 C 线没有发第三合集网络请求、没有续页或取正文。**

### 第三合集首屏实测与有界游标续页准备

总控按上述一次性门禁执行第三合集首屏：HTTP **200**、`base_resp.ret=0`，首屏 **10** 条的 URL `__biz/mid/idx` 与目标号及逐项 `msgid/itemidx` 均一致，**10** 条均有 `create_time`；摘要 `9beb4db841a9c11c` 对应的旧文章确在首屏且 URL 身份闭环。响应声明 `article_count=54`、`continue_flag=true`。这确认该旧文章实际收录于第三个官方合集，并证明该合集在此时点至少返回十条目标号列表项；**54 只是服务器声明值**，还没有逐页验证，不代表 54 篇均已取得或订阅能持续更新。首屏原始响应和游标未保存，首屏私有尝试哨兵保留；精确合集 ID 仍只在先前私有来源文件中。该次没有取得新的原文，也不能以列表 `create_time` 代替原文 `ct`。

为验证真实分页，新增 [`public-third-album-cursor-two-page.cjs`](../../scripts/collection-source-probe/public-third-album-cursor-two-page.cjs)，仅**离线准备，C 线未在线执行**。腾讯已保存的官方 `album80ec10.js`（上文 SHA-256）偏移约 14729 将当前合集列表末条的 `msgid/itemidx` 放入下一次同源 `getalbum` 的 `begin_msgid/begin_itemidx`；本项目 2026-09-27 成功保存的两组合集四页 JSON 及当时请求脚本也使用首屏末条游标，页间等待两秒，不额外带 `is_reverse`。该版客户端可能在反向装载时带 `is_reverse=1`，但本次设计只针对已验证的默认正向首屏，不从响应 `base_info.is_reverse` 猜另一个请求形状。先前第三合集首屏没保存游标，故**最多重取首屏一次，只为从真实响应获得游标**；若首屏发生变化，使用重取结果作唯一续页基线。

脚本逐层重核私有来源文件的摘要、账号、字段与唯一数值合集 ID，旧短链/首屏已尝试哨兵，以及生产 SQLite 中原有旧文章的长短链、ID 与日期；数据库仅以只读方式打开。离线用两组旧合集的四份官方 JSON 回归：各首屏 10 条、后页 3/9 条，首屏 `continue_flag=1`、后页为零；每项原文 URL 的目标 `__biz/mid/idx/sn/chksm` 与列表键相符，页间无重复且发布时间逆序。旧官方 URL 带 `#rd` fragment，验证器只接受无 fragment 或这个已见的固定标记，**不把它当身份参数**。原子私有文件“已有目的不可覆盖”自测通过；`preflight` 得 `oldPagesTested=4`、`requests=0`，无复审执行标志的 `probe` 在门禁停止，`requests=0`。

总控复审后若执行，先排他创建新的运行哨兵，再匿名直连请求一次**同一私有 ID** 的官方 `getalbum` 首屏；若 HTTP 3xx、验证码/限流、非 JSON、非零 `ret`、身份或排序异常即停，不看跳转地址、不重试。只在首屏十项键、目标账号、时间与 URL 签名结构通过后，原子写入仅含 `msgid/itemidx/create_time/sn/chksm` 与真实末条游标的私有最小元数据；等待至少 **2 秒**，先创建第二页哨兵，才按这个末条发送**一次** `begin_msgid/begin_itemidx` 续页。所有请求禁代理、自动跳转和重试，单页 12 秒/2 MiB；整次上限两次，没有第三页循环。第二页逐项校验、去重并核时间顺序；私有原子文件记录第一页文件哈希、第二页已验证的最小身份元数据及下一游标。若与第一页重叠、顺序异常或没有新键，不留可接续游标。公开日志只含 HTTP/`ret`、条数、账号/键/时间计数、页间新增及重复数、是否还有后页和是否保存游标；不输出或提交合集 ID、原始 JSON、完整 URL、标题、正文、凭据或私有文件。第二页若成功，是否低频继续余页由总控依据真实响应**另行复审**，不能把服务器声明的 54 条或本次两页推成全号目录。

### 第三合集第二页实测与逐页续取门禁

总控执行上节有界脚本：重取首屏一次和使用其真实末条游标取第二页一次，两页各 HTTP **200**、`base_resp.ret=0`、**10/10** 条目标 `biz`、URL `mid/idx` 与逐项 `msgid/itemidx` 匹配，且每条都有 `create_time`；合计 **20 个不重复键**，跨页时间逆序正常。第二页 `continue_flag=true`，下一游标仅保存在私有最小元数据中。重取首屏仍声明 `article_count=54`，实际只验两页 20 条。离线对照既有两合集 32 键，交集 **0**；与旧库中可辨 `(mid,idx)` 键的交集 **8/20**，其余 **12** 只是旧库可辨键之外的合集列表键，不能据此称作本轮新增或已取得正文。两页列表 `create_time` 日期范围为 UTC **2026-02-23 至 2026-09-24**；尚未逐篇以原文字面 `ct` 核原始发布时间和正文图片。第三合集仍是由**一篇旧文章的所属标签**发现，未证明账号级合集枚举或持续更新。

新增 [`public-third-album-next-page.cjs`](../../scripts/collection-source-probe/public-third-album-next-page.cjs) 作为第三页起的**每次一页**只读探针；C 线只离线自检，没有在线执行。它不重取前页，不扫描至终点。每次先只读校验私有来源 ID、先前尝试哨兵、生产库中摘要 `9beb4db841a9c11c` 对应旧文章身份，并逐份核已保存页的严格字段、目标账号、逐项 `msgid/itemidx/create_time/sn/chksm`、页序、去重、真实末条游标、前页文件 SHA-256 和至少 **2.3 秒**的页间记录间隔。当前私有两页链预检通过：`priorPagesValidated=2`、`priorUniqueKeys=20`、`nextPage=3`、`requests=0`；旧腾讯 JSON 的一个后页样本和原子私有文件拒绝覆盖自测通过。没有精确页号的复审执行标志时，`probe` 以 `requests=0` 停止。

经总控对**当前下一页**另行复审后，脚本在前页采集时间后至少等待到 2.3 秒，排他建立该页私有哨兵，然后只向同一腾讯 `/mp/appmsgalbum?action=getalbum` 发**一次**带已保存 `begin_msgid/begin_itemidx` 的匿名 HTTPS GET；无代理、跳转、重试，12 秒、2 MiB，遇 3xx、验证/限流、非零 `ret` 或字段异常停止，不保存原响应或跳转地址。成功页只原子存私有最小身份元数据、前页哈希及下一游标；公开仅报条数、账号/键/列表时间计数、与此前全部已取键的重复数和运行内唯一键总数。若重复、时间倒序不成立、声明数冲突或达到本轮 **6 页上限**，仅保留该页私有最小元数据与脱敏结果，**不留可续游标**，交总控复审。首屏声明的 54 是本次六页上限的设计依据，不是已经取得的完整数量；第 4 页以后每页须单独以匹配页号的复审标志执行，脚本不会自动继续。列表 `create_time` 始终不代替原文 `ct`，候选文章仍须逐篇身份/正文/图片闭环。

### 第三合集六页闭环与旧来源交集（仅列表，不是原文验收）

总控用上节**每页一次**脚本继续第 3–6 页：第 3、4、5 页各 HTTP **200**、`base_resp.ret=0`、10 条、`continue_flag=true`；第 6 页 HTTP **200**、`ret=0`、4 条、`continue_flag=false`。所有页在采集时逐项核了目标 `biz`、列表 `msgid/itemidx` 与官方原文 URL 的 `mid/idx`、有效 `create_time`，相邻页用真实末条游标前进；没有重取前页、自动跳转或继续请求第 7 页。六页实际条数为 **10+10+10+10+10+4=54**，末页明确无后页，恰与首屏声明 `article_count=54` 相符。这只闭环**该第三合集在这次采集时的列表分页**；它不证明公众号全部文章、所有合集枚举、未来增量稳定性，也不把条目当成本轮新发表文章。

新增只读 [`public-third-album-chain-audit.cjs`](../../scripts/collection-source-probe/public-third-album-chain-audit.cjs) 对六份用户私有最小页文件做离线复核：核私有合集来源、每页页号/键/账号/时间格式、首屏声明数、前页文件 SHA-256、真实请求游标、相邻页逆序且不重复、最后 `continue_flag=false`，只输出合计与交集，不输出精确 ID 或原文 URL。以 2026-09-27 保存的两合集四份腾讯原始 JSON 作为旧基线，其 **13+19=32** 个键与第三合集 **54** 键交集为 **0**，因此当前已从三个不同官方合集得到 **86 个互不重复的列表键**。生产 SQLite 以只读方式核目标号 194 行：38 个规范文章 ID、20 个已核长链可辨 `(mid,idx)`，去重合计 **39** 键；第三合集与这 39 键交集 **8**，余 **46** 键仅是旧库**可辨键集合**之外，不能推断不透明 ID 对应的旧文章不存在，也不能称 46 篇新增。第二页时 20 键交集已为 8，此后 34 个列表键均未增加这一交集。第三合集列表 `create_time` UTC 日期范围为 **2024-10-07 至 2026-09-24**；这是腾讯**合集列表字段**范围，本次离线审计没有取原文 `ct`、正文或图片。脚本运行结果 `requests=0`、六页 54 个唯一键、零跨页重复、末页不可续；私有新合集 ID、54 条身份值和原始 JSON 未提交。

## 2026-09-30 另一篇目标原文的单请求结果与离线差异诊断

从 2026-09-27 保存的 `复旦数学营` 官方首屏 JSON 选第 2 条，与上节已请求的第 1 条不同。其列表 `create_time` 的 UTC 日期为 **2026-09-14**，`SHA256(__biz\0mid\0idx\0sn)` 前 16 位为 `792e0623ba3ee739`。URL 位于腾讯 `/s`，四个身份参数齐全，URL `mid/idx` 分别等于列表 `msgid/itemidx`，`__biz` 等于目标号；这条身份不在八份旧目标原文 HTML 中。按原有 URL 只升级 HTTPS 协议，未改变参数。请求前用当前 main **已构建**的 `articleIdentity/articlePublishTime/articleContentHtml` 在八份旧 HTML 上做离线预检，八份均可解析身份、原文 `ct` 与正文，预检网络请求为零。

随后运行 [`public-article-one-shot.cjs`](../../scripts/collection-source-probe/public-article-one-shot.cjs) 对这条不同的公开原文发 **1 次**匿名 HTTPS GET：禁用代理、无跳转、无重试、无 Cookie/授权，12 秒超时，响应上限 6 MiB，原文仅在内存中解析。返回进入 HTTP **200** HTML 的解析阶段，页面有 `#js_content` 且解析器读出一组文章身份；但把解析器生成的 `__biz/mid/idx/sn` 与旧腾讯合集 JSON 的四字段逐项比较时，**至少一项不一致**，探针立即报 `article_identity_mismatch` 并停止。它没有在停止前保留逐字段布尔值，也没有保存原文，因此**无法判定是哪一字段不同**，也无法判断是页面本身、URL 与正文的规范差异，还是解析器行为所致。不能称这篇是目标号真文章、错号文章、有效新文章或可用的五篇样本；正文图片数量与原文 `ct` 也没有走到最终核验步骤。响应、完整 URL、标题、正文和私有凭据均未输出或保存；本机仅保存不含 URL 的“此摘要已尝试”哨兵，阻止误发第二次请求。

为诊断比较规则，离线读取四份旧腾讯合集 JSON 的 **32** 个条目，再把当前主线解析器应用于八份既存、已核验的目标官方原文。八份都能按 `__biz/mid/idx` 在合集记录中匹配，且其解析出的 `sn` 与同条列表 URL 也 **8/8 相同**，没有 `sn` 缺失或不符。这说明四字段对比没有在这些旧真实样本上发现普遍错误；**不能反推新响应中具体哪项不同**。一次性脚本现已改为在将来的**其他文章**中只报告差异字段名，不输出值；这次已经结束的请求无法追补信息，不对同一 URL 重试。

该实测只排除“选中这条 2026-09-14 列表记录，使用当前主线解析器即可直接闭环身份”的判断。它不排除该合集接口、其他条目、公开文章到合集的发现或其他官方页面路径。后续应先检查可复核的另一个公开原文与列表的字段语义及页面版本，再决定是否对**不同**候选做单次最小验证；仍须逐篇对 `biz/mid/idx/sn`、原文 `ct`、正文和图片做闭环。

## 已知真文章的当前公开页对照：一次请求，诊断层仍不够细

为区分上节的新文章四字段不符与解析器对当前页面的普遍兼容问题，另从六份 2026-09-27 已保存、已核验的目标官方原文中选一篇**本轮尚未在线访问**的旧文章。离线把六份 HTML 逐项与四份腾讯合集 JSON 的 32 条记录、当时的独立身份记录交叉匹配：六篇各有唯一列表条目，`__biz/mid/idx/sn` 均与旧 HTML 和身份记录相同，旧 HTML 的字面 `var ct`、当前主线解析的 `articlePublishTime`、身份记录 `ct` 均一致，六份都有严格 DOM 的 `#js_content`。选择摘要 `8c460d508c0aae1b` 的一篇作对照：旧原文 `ct` UTC 日期 **2026-01-12**，还与该条列表 `create_time` 和原有记录的发布时间精确相同。其本机请求哨兵不存在，亦不同于本轮此前已请求的两篇；与上一文章请求间隔约 43 分钟。其余五篇的列表 `create_time` 比原文 `ct` 早 25–52 秒，因此不能普遍以列表时间代替原文时间。

使用 [`public-article-reference-control.cjs`](../../scripts/collection-source-probe/public-article-reference-control.cjs) 对所选旧文章发 **1 次**匿名、禁代理、无跳转、无重试的腾讯 HTTPS GET，12 秒超时、6 MiB 响应上限，不带 Cookie/授权，不保存原文。得到 HTTP **200** HTML，严格 DOM 检出 `#js_content`；随后当时探针输出 `parser_stop`。这个日志名覆盖了主线 `articleIdentity` 调用、其 URL 的严格四字段规范化，以及 `articlePublishTime` 调用的同一个 `catch`，**没有记录失败的具体步骤**，因此本次没有新旧页面/List 的四字段布尔值，也没有当前原文 `ct` 的比对结果。不可将 `parser_stop` 直接解读为错号、身份字段冲突、缺少 `sn` 或发布时间变化；只能说这次当前公开页未经过原探针完成身份与时间闭环。旧 HTML 的成功解析仍只证明 2026-09-27 保存页面的结构。该 URL 的本机哨兵已记录尝试时间，未重试。

与上节请求相比，**两次都是 HTTP 200 且未闭环，但日志停在不同检查点**：新文章先经 `articleIdentity` 返回了可比较的 URL，四字段比较至少一项不同；本次已知旧文章仅确认 `#js_content`，在合并的解析/规范化/时间异常区停止。因两次均未保存响应，不能从第二次推断第一次的差异字段，也不能从第一次推断第二次的异常原因。对照脚本此后改为分别记录身份解析、规范 URL、原文时间各阶段是否通过，并在取得身份时仅输出四字段的布尔比较；改进后的代码用六份旧 HTML **离线 6/6 通过**，网络请求零次。该改进不能追补已结束响应。本轮同类在线对照至此停止，不发送第三个 URL，后续须先有新的可判别条件再评估不同候选。

## 当前验证顺序与停止条件

1. 独立 Probe Agent 已确认 `复旦数学营` 2026-09-30 两页仍为相同 19 个 `(msgid,itemidx)`；C 线不重复合集请求。新原文逐篇核验身份、原文时间与正文，遇验证码、限流、身份不符或无法闭环立即停止相应 URL。
2. 首屏若成功，按真实 `msgid+itemidx`、URL `__biz/mid/idx`、原文发布时间核验不同文章，再做有限分页与增量；每条新内容应保留确切来源和采集时间。五篇目标真实新来源文章是接入 Provider 前的验收门槛，**不是**单次接口能力探针前置条件。
3. 从新增目标原文 HTML 中提取 `album_info_list` 与 `appmsgalbuminfo`，只接受腾讯官方 `/mp/appmsgalbum`、账号 `biz` 一致且 `album_id` 为页面明示的链接；按 ID 去重后可发现**该文章所属**新合集。若页面没有这些字段，不猜 ID、不把 `album_keep_read_info` 短链当成新合集。
4. 对 `profile_ext`、`homepage` 继续查公开源码与客户端实现；只有得到与旧空列表/频控实测有实质差异的认证来源或栏目 `hid/sn` 一手依据，才考虑另一条隔离只读探针。2026-09-30 另一篇**非目标**官方文章的单次匿名 GET 返回腾讯验证 302，已停止该 URL 请求；这不否定上述已保存目标 HTML 字段或其他源码研究。

本报告排除“旧目标分享 URL 参数自身含合集 ID”和“已发现两合集足以代表全号”两项推断，并新增 **60 个**来自旧目标正文的列表外同号长链种子。这些种子尚无当前页面身份与时间闭环；公开原文发现其他目标合集、合集持续更新、公众号全部列表仍需分别研究和验证。

## 2026-09-30 私有证据丢失后的下一篇短链筛选边界（离线，零请求）

本轮从生产 SQLite 用 `DatabaseSync(..., { readOnly: true })` 仅读目标号的 `source_url/verified_source_url/publish_time` 与正文是否非空；生产库和 2026-09-29 的一致性备份 `quick_check=ok`，目标号均为 194 行。生产库中有 **14** 行同时保有唯一目标 `__biz/mid/idx/sn` 长链、无 query 的官方 `/s/<22 token>` 短链、规范旧文章 ID 和非空旧正文。先前已保存的官方两合集原始列表与这些行交叉核验，14 行均在当时两合集 **32** 键之外；这个历史结论可在上文追溯，但本轮无法重算四份原始 JSON。

本轮检查主仓和 C worktree 的忽略目录、主仓备份与系统 `%TEMP%`：2026-09-27 两合集的四份原始 JSON、八份旧目标 HTML，以及第三合集六页的私有最小键文件与来源 ID 文件均未找到。主仓 `private-data` 现有文件属于另一条 WeRead 尝试，不含这些合集键；2026-09-29 的 SQLite 备份只有旧文章数据库及校验记录，不含后来采得的第三合集 **54** 键。`%TEMP%` 中本轮初查还可列出旧 `.attempted` 文件，随后同一路径的这些哨兵亦全部消失；C 线没有删除动作。**哨兵现在缺席绝不能证明 URL 未请求。**已提交报告仍记载旧两条成功短链，以及多条长链、文章和合集的请求结果；这些历史记录优先于空目录。第三合集 54 键当时经六页审计通过的事实仍有效，但失去私有键文件后，不能再把某个候选实时断言为“三合集之外”。

旧库 UTC **2026-09-28** 的摘要 `5e44e0d46c308fe2` 可作为**待复审短路径候选**：先前仅对它的腾讯长 `/s?__biz,mid,idx,sn` 发过一次匿名 GET，结果 302 且没有跟随；该行原存的短 `/s/<22 token>` 是不同的官方请求形状，上文两篇其他旧目标短链曾在本轮以 HTTP 200 闭环身份、字面原文 `ct`、正文与图片。已提交请求记录没有这篇的短链 GET；由于临时哨兵已丢，仅凭本机现状不能担保其他历史环境没有访问。该候选 2026-09-28 的**旧库存原文时间**晚于第三合集记录的最晚列表 `create_time` 日期 2026-09-24，但两个时间字段不等价，这也不能代替 54 键逐项排重。如果候选实际上已在第三合集，其当前短链仍可能验证旧文章公开页面、重新取得该篇明示的所属合集字段；它不会因此证明第四个合集或提供一篇新发表文章。其余旧短链亦不得因丢失哨兵而批量试探。

下一次**不同短 URL** 的只读实验须先由总控独立复审具体摘要及历史请求记录；本轮**没有发网络请求，也没有制作可放行的在线脚本**。建议将未来的最小来源键集与请求账本移入 Git 忽略的持久 `private-data`：每条候选先核只读生产库、备份一致性、官方短/长身份配对、旧历史已试集合及保存的合集键；请求前以排他创建并同步落盘的私有哨兵记录摘要、请求形状与时间，哨兵已存在即拒绝；匿名单 GET 禁代理、跳转与重试，限时限量，3xx/验证/限制立即停且不读取跳转目的；按 `biz/mid/idx/sn`、短 canonical、字面 `ct`、正文节点和图片分阶段验收。响应中明示的腾讯同号合集 ID 及必要的最小 `(msgid,itemidx)` 证据仅写入私有文件，临时文件同步后原子、不可覆盖地落盘；公开日志只记布尔与计数。旧 `%TEMP%` 哨兵即使日后重现也仅作额外否决依据，不再作为唯一请求账本。先用假网络验证 200、302、验证码、身份不符及落盘失败的单次停止行为，再交总控执行。SQLite 备份保障旧数据，不会补回已丢的官方合集键；若无法恢复旧来源，应明确接受“第三合集成员关系未复核”的实验边界，不能把它写成排重成功。

### 同摘要的官方短路径：只读复审与一次性脚本（仍未联网）

总控独立复核历史请求后，C 线进一步准备**另一 URL 形状**的有界实验。生产库与 2026-09-29 一致性备份均只读运行 `quick_check=ok`，并各找到唯一摘要 `5e44e0d46c308fe2` 的目标旧行；两库的原存短 `source_url`、四字段长 `verified_source_url`、规范旧文章 ID 与旧发布时间逐项相同，备份文件 SHA-256 亦与其私有 `verification.json` 相同。库内短链严格为无 query 的 `https://mp.weixin.qq.com/s/<22 token>`，长链只含目标 `__biz/mid/idx/sn`，均不含凭据。已提交历史报告对这篇只记**长** `/s?...` 单次 302；没有这篇**短** `/s/<token>` 的已试记录。由于过去的 `%TEMP%` 哨兵消失，绝不把当前“无哨兵”本身当作未请求证明；实验还要求总控再次复审。这个短路径假设由同仓 `resolvePublicArticle` 的真实发送代码、既存目标短/长身份配对，以及另两篇目标旧短链本轮 HTTP 200 的独立实测支持。即便该篇属于第三合集，这次只能验证单篇当前公开原文及页面明示所属合集，不能称第四合集、新发表文章或全号列表。

新增 [`public-old-shortpath-next-album-one-shot.cjs`](../../scripts/collection-source-probe/public-old-shortpath-next-album-one-shot.cjs)。`preflight <主仓绝对路径>` 在**零网络请求**下重核上述唯一身份、备份路径/哈希、当前已构建解析器与已提交历史报告，并检查持久私有短链哨兵；它明确报告第三合集成员关系 `unverified`，不会因为 TEMP 清空而宣称历史从未访问。`probe` 缺少精确 `--execute-reviewed-5e44e0d46c308fe2` 标志时在发请求前拒绝。带标志后先在 Git 忽略的 `<主仓>/private-data/public-page-probes/` 排他且同步落盘 `short-<摘要>.attempted.json`，再对库内**原样短链**匿名直连单次 HTTPS GET；使用 Node 原生 `https.request`、`agent:false`、12 秒/6 MiB、无 Cookie、代理、自动跳转或重试。3xx 不读 `Location`，验证码/限制、身份冲突、原文字面 `ct` 冲突、正文不可核验即停，哨兵保留。HTTP 200 全部门禁通过时，脚本在同一忽略目录以不可覆盖的原子文件保存有界原始 HTML 和最小 JSON：页面身份匹配布尔、原文时间匹配、正文图片计数、由内联 `var album_info_list` 静态字面量且腾讯同号官方 `getalbum` 链接交叉确认的精确合集 ID；不执行页面 JS。公开输出只有 HTTP、布尔、计数与旧两合集内/外分类；“旧两合集外”**可能正是已知第三合集**，不能自动解读为新 ID。任何保存失败都不重试请求，生产 SQLite 始终只读。

离线自检：`node --check` 通过；`preflight` 为 `requests=0`、备份核验通过、短形状持久哨兵不存在且第三合集归属未核；无复审标志 `probe` 返回 `review_or_attempt_gate_stop`、`requests=0`。注入假网络运行 302、非 HTML/超限分类、验证码、四字段冲突、HTTP 200 身份/时间/正文成功、网络异常；各例仅调用模拟请求一次并先落哨兵，二次尝试均零请求，此前版本成功例私存文件、失败例不存原文；已有证据文件也阻断首次请求。静态合集解析拒绝 JS 表达式和重复字段。真实目标 URL **本轮没有联网请求**，原文、完整 URL、标题、凭据及私有合集 ID 未写入 Git 或日志。线上执行及其结论由总控另行复审。

### HTTP 200 解析失败时保留私有页面（同脚本增量，仍未联网）

先前脚本仅在身份、时间和正文全部通过后才保存原始 HTML；若单次 HTTP 200 的当前页面使解析器止步，响应退出后便无法离线辨别字段差异。本次把有界保存移到解析之前：仍先排他、同步写入 Git 忽略的持久私有哨兵，再发送至多一次 GET；仅当响应是完整、`text/html`、未超 **6 MiB**、且未命中验证码/限流标志的 HTTP **200** 时，先将原始 HTML 以临时文件同步和硬链接不可覆盖方式保存于 `<主仓>/private-data/public-page-probes/`，随后才尝试身份、字面 `ct`、正文和合集解析。解析失败时只输出停止层、安全布尔及私有 HTML 文件路径，保留哨兵与 HTML 供离线诊断；解析成功才另存最小身份/合集 ID JSON，并输出其私有路径。原文或字段值仍不进入公开日志和 Git。3xx 不看 `Location`；验证码/限流、非 HTML、超限或网络错误不保存响应页，也不重试。保存原文失败时立即返回 `private_html_save_stop`，保留已尝试哨兵，不继续解析。

离线回归：`preflight` 仍为 `requests=0`，备份/旧身份核对通过；无复审标志的 `probe` 为 `review_or_attempt_gate_stop`、`requests=0`，没有建立真实私有目录。假网络新增 HTTP 200 四字段冲突及无 `#js_content` 两例，均证实**先写原文再停止解析**、只存 HTML 不存合集 JSON，模拟 HTML 字节与私存文件相同；302、验证码、非 HTML/超限、网络失败均只留 marker；成功例保存 HTML 与最小 JSON；私有 HTML 写失败仅请求一次并停。所有模拟请求在回调开始前已见哨兵，二次调用均被挡住。本轮仍无真实在线请求；私有文件只会由总控未来复审后的实际运行产生。
