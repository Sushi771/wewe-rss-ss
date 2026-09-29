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

## 当前验证顺序与停止条件

1. 独立 Probe Agent 正用**旧官方 HTML 确认的目标 `biz+复旦数学营 album_id`**只请求一次 2026-09-30 匿名首屏；C 线不重复该请求。先看 HTTP/业务状态、账号身份、条目数和字段名。若遇验证码、限流、身份不符立即停止相应网络请求。
2. 首屏若成功，按真实 `msgid+itemidx`、URL `__biz/mid/idx`、原文发布时间核验不同文章，再做有限分页与增量；每条新内容应保留确切来源和采集时间。五篇目标真实新来源文章是接入 Provider 前的验收门槛，**不是**单次接口能力探针前置条件。
3. 从新增目标原文 HTML 中提取 `album_info_list` 与 `appmsgalbuminfo`，只接受腾讯官方 `/mp/appmsgalbum`、账号 `biz` 一致且 `album_id` 为页面明示的链接；按 ID 去重后可发现**该文章所属**新合集。若页面没有这些字段，不猜 ID、不把 `album_keep_read_info` 短链当成新合集。
4. 对 `profile_ext`、`homepage` 继续查公开源码与客户端实现；只有得到与旧空列表/频控实测有实质差异的认证来源或栏目 `hid/sn` 一手依据，才考虑另一条隔离只读探针。2026-09-30 另一篇**非目标**官方文章的单次匿名 GET 返回腾讯验证 302，已停止该 URL 请求；这不否定上述已保存目标 HTML 字段或其他源码研究。

本报告只排除“旧目标分享 URL 参数自身含合集 ID”和“已发现两合集足以代表全号”两项推断；公开原文发现其他目标合集、合集持续更新、公众号全部列表仍可继续研究和逐项验证。
