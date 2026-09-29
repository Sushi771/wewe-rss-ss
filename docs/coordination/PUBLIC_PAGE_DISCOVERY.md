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

## 2026-09-30 另一篇目标原文的单请求结果与离线差异诊断

从 2026-09-27 保存的 `复旦数学营` 官方首屏 JSON 选第 2 条，与上节已请求的第 1 条不同。其列表 `create_time` 的 UTC 日期为 **2026-09-14**，`SHA256(__biz\0mid\0idx\0sn)` 前 16 位为 `792e0623ba3ee739`。URL 位于腾讯 `/s`，四个身份参数齐全，URL `mid/idx` 分别等于列表 `msgid/itemidx`，`__biz` 等于目标号；这条身份不在八份旧目标原文 HTML 中。按原有 URL 只升级 HTTPS 协议，未改变参数。请求前用当前 main **已构建**的 `articleIdentity/articlePublishTime/articleContentHtml` 在八份旧 HTML 上做离线预检，八份均可解析身份、原文 `ct` 与正文，预检网络请求为零。

随后运行 [`public-article-one-shot.cjs`](../../scripts/collection-source-probe/public-article-one-shot.cjs) 对这条不同的公开原文发 **1 次**匿名 HTTPS GET：禁用代理、无跳转、无重试、无 Cookie/授权，12 秒超时，响应上限 6 MiB，原文仅在内存中解析。返回进入 HTTP **200** HTML 的解析阶段，页面有 `#js_content` 且解析器读出一组文章身份；但把解析器生成的 `__biz/mid/idx/sn` 与旧腾讯合集 JSON 的四字段逐项比较时，**至少一项不一致**，探针立即报 `article_identity_mismatch` 并停止。它没有在停止前保留逐字段布尔值，也没有保存原文，因此**无法判定是哪一字段不同**，也无法判断是页面本身、URL 与正文的规范差异，还是解析器行为所致。不能称这篇是目标号真文章、错号文章、有效新文章或可用的五篇样本；正文图片数量与原文 `ct` 也没有走到最终核验步骤。响应、完整 URL、标题、正文和私有凭据均未输出或保存；本机仅保存不含 URL 的“此摘要已尝试”哨兵，阻止误发第二次请求。

为诊断比较规则，离线读取四份旧腾讯合集 JSON 的 **32** 个条目，再把当前主线解析器应用于八份既存、已核验的目标官方原文。八份都能按 `__biz/mid/idx` 在合集记录中匹配，且其解析出的 `sn` 与同条列表 URL 也 **8/8 相同**，没有 `sn` 缺失或不符。这说明四字段对比没有在这些旧真实样本上发现普遍错误；**不能反推新响应中具体哪项不同**。一次性脚本现已改为在将来的**其他文章**中只报告差异字段名，不输出值；这次已经结束的请求无法追补信息，不对同一 URL 重试。

该实测只排除“选中这条 2026-09-14 列表记录，使用当前主线解析器即可直接闭环身份”的判断。它不排除该合集接口、其他条目、公开文章到合集的发现或其他官方页面路径。后续应先检查可复核的另一个公开原文与列表的字段语义及页面版本，再决定是否对**不同**候选做单次最小验证；仍须逐篇对 `biz/mid/idx/sn`、原文 `ct`、正文和图片做闭环。

## 当前验证顺序与停止条件

1. 独立 Probe Agent 已确认 `复旦数学营` 2026-09-30 两页仍为相同 19 个 `(msgid,itemidx)`；C 线不重复合集请求。新原文逐篇核验身份、原文时间与正文，遇验证码、限流、身份不符或无法闭环立即停止相应 URL。
2. 首屏若成功，按真实 `msgid+itemidx`、URL `__biz/mid/idx`、原文发布时间核验不同文章，再做有限分页与增量；每条新内容应保留确切来源和采集时间。五篇目标真实新来源文章是接入 Provider 前的验收门槛，**不是**单次接口能力探针前置条件。
3. 从新增目标原文 HTML 中提取 `album_info_list` 与 `appmsgalbuminfo`，只接受腾讯官方 `/mp/appmsgalbum`、账号 `biz` 一致且 `album_id` 为页面明示的链接；按 ID 去重后可发现**该文章所属**新合集。若页面没有这些字段，不猜 ID、不把 `album_keep_read_info` 短链当成新合集。
4. 对 `profile_ext`、`homepage` 继续查公开源码与客户端实现；只有得到与旧空列表/频控实测有实质差异的认证来源或栏目 `hid/sn` 一手依据，才考虑另一条隔离只读探针。2026-09-30 另一篇**非目标**官方文章的单次匿名 GET 返回腾讯验证 302，已停止该 URL 请求；这不否定上述已保存目标 HTML 字段或其他源码研究。

本报告只排除“旧目标分享 URL 参数自身含合集 ID”和“已发现两合集足以代表全号”两项推断；公开原文发现其他目标合集、合集持续更新、公众号全部列表仍可继续研究和逐项验证。
