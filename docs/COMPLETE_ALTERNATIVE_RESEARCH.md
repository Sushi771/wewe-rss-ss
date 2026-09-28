# 全文章列表替代来源核查（2026-09-27）

## 18 时状态补记

本轮未继续免费目录、reader 或后台请求，没有取得新的可验收替代源。电脑微信路线已修复置顶结构、标签生命周期和取消保护，离线通过但真实运行仍因用户 Esc 暂停，限定单篇恢复授权尚待答复。当前设计范围为“文章”页，其他内容类型和多账号自动持续更新未证明；见 [修复检查点](DESKTOP_COLLECTION_REPAIR.md)。下文历史研究不构成恢复 UI 或重试上游的授权。

## 最新范围与授权（覆盖下文历史研究的执行范围）

用户最新范围为**每个订阅来源最新 20 篇并持续更新**，并已允许先验证免费第三方 RSS/API 的真实覆盖；不向第三方交微信凭据、不购买服务、不运行外部下载器。**WeRead reader 已暂停，不是在等待验证码，也不再发送列表请求。** 下文全历史、原生通道和 reader 清单保留为历史研究记录，不作为最新 20 篇范围的额外门槛。仍须验证目标身份、真实文章、时间覆盖和可持续更新，不能用关键词命中数代替最新文章覆盖。

## 免费公开目录有界验证结果

2026-09-27 本线仅检查自由微信和搜狗公开页面，没有登录第三方、传递微信凭据或写库。证据位于 `output/playwright/complete-alternative/public-directories/`：`summary.json` 保存每个请求的状态或错误及成功 HTML 哈希；`sogou-mama.html`、`sogou-suxun.html` 是实际响应；`coverage-summary.json` 保存脱敏标题、显示作者、时间、分页链接及未验证项。

| 来源与目标               | 实际结果                                                                                                           | 最新 20 篇判定                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 自由微信两个目标 profile | 网页工具不能打开；本机现有请求级代理下 curl TLS 失败，随后一次标准库 TLS 栈核验均为 `UNEXPECTED_EOF_WHILE_READING` | **访问阻塞**。没有取得账号页，不能推断目标未收录                             |
| 搜狗：妈妈部落畅聊阁     | HTTP 200，首屏 9 条，其中 8 条显示精确号名、1 条为其他作者；精确显示作者条目的时间为 2026-03-06 至 2026-03-31      | 未覆盖已知近期漏项；不足 20 条且不是严格时间序，未通过                       |
| 搜狗：苏洵书院升学指导   | HTTP 200，首屏 10 条，其中只有 2 条显示精确号名，时间为 2026-09-16、2026-09-18；其余为近名或其他作者               | 仅两条近期候选，尚未解析微信 canonical/biz，不能认定该订阅最新 20 条，未通过 |

搜狗母号页观察到第 2、3、4 页及下一页链接，苏洵页观察到第 2、3 页及下一页链接；这证明**关键词搜索有分页入口**，没有证明公众号独占来源或最新时间排序。未请求下一页。两个页面的查询表单仅提供 `type=2` 的“搜文章”，没有观察到可操作的按时间排序、精确公众号过滤控件或 `type=1` 公众号入口。页面内空的 `toolParas` 参数对象不足以据此猜参数。根据主线的有界要求，到此停止，不继续换网络栈、盲猜查询或拓展来源。

显示作者相同还不是账号身份核验；本线没有跟随搜狗文章跳转，没有确认文章 canonical，也没有导入这些候选。当前结论仅为这次公开目录实测**未证明两目标最新 20 篇及持续更新覆盖**，不能扩大为所有第三方均不存在该覆盖。

本线只读公开源码、既有第一方脚本和调查证据；没有安装或运行外部采集器，没有访问微信会话、HTTP 缓存、聊天数据库、进程内存，也没有请求带授权的微信列表或修改生产库。目标近期漏项、下一页和历史终点仍未取得，本报告不构成采集验收通过。

## 第一方网页与原生主页的边界

既有证据 `output/playwright/channel-builtin/native-profile-evidence.json` 对应两份微信第一方公开文件：

- [appmsg/profile80ec10.js](https://res.wx.qq.com/mmbizwap/zh_CN/htmledition/js/appmsg/profile80ec10.js)，546 字节，SHA-256 `8fb986d824ec36df14bde1e573fbd39f09eba429c7be56b0a408cf6be5d25fd3`。
- [photo_account_profile/index80ec10.js](https://res.wx.qq.com/mmbizwap/zh_CN/htmledition/js/pages_new/photo_account_profile/index80ec10.js)，753 字节，SHA-256 `e35630d6e2471994c9763708a078feb05cb9508a2c0dc5b6b0955e0720d8cfdf`。

本轮重新核对：两者只向 JSBridge 调用 `profile({username,scene:'298'})`，随后 `closeWindow`，没有 HTTP 列表或分页函数。它们能说明网页将展示交给微信客户端，不能提供原生列表的 HTTP 请求、授权密钥或原生响应结构。

既有 `first-party-script-evidence.json` 指定的公开文章 HTML 中，`callProfileJSAPI` 也调用原生 `profile`。贴图账号的条件分支检查 `support_view_photo_profileext` 等第一方能力标志，部分情况回退到同一个 `profile_ext?action=home`；这不是新的列表协议。脚本确认 `item_show_type===8` 的图片内容分支，但不能据此给目标截图四项内容定型。本轮没有通过改 User-Agent 或猜参数重跑已失败的 `getmsg`。

## 新候选 A：原生 BizProfileV2 的公开 CLI 壳

检索发现 [wxflywheel 0.14.0](https://pypi.org/project/wxflywheel/0.14.0/) 声称 `profile list --ghid --cursor` 使用 BizProfileV2、CGI 2899。这与传统网页 `profile_ext/getmsg` 不同，值得审查，但审查结果不足以支持本机授权实验。

### 固定来源与入口

从 PyPI JSON 获取官方发布的 wheel，只下载、解压和阅读，没有执行其中 Python。版本为 `0.14.0`，wheel SHA-256 为 `975645aaf08caeaf23492eb9478199a118bd5064f4dbcceef6587f92fdeeed36`，与 PyPI 元数据一致。本机副本位于 `output/playwright/complete-alternative/wxflywheel-0.14.0/`。这份包没有可核对的 Git commit；PyPI 指向 `vinsew/weixin`，本轮 GitHub API 返回 404，项目说明明确仓库为 private。PyPI `license` 为 null，wheel 未包含 LICENSE，因此不能按开源许可直接移植。

`wxflywheel/commands/profile.py` 的 `profile_list` 调用：

```text
POST <configured host>/v1/Gh/ProfileV2?key=<API key>
首屏 JSON: { Ghid: <公众号 gh_xxx> }
后续 JSON: { Ghid: <公众号 gh_xxx>, Cursor: <base64 protobuf> }
```

`client.py` 负责普通 HTTP，`config.py` 默认 `http://localhost:8011`。这不是微信第一方 URL；真正的微信传输、CGI 2899 请求封装、加密、账号登录和续期均由未公开的 **wx-ipad 后端**承担。`login.py` 只检查后端现成账号槽的登录状态，不能用当前电脑微信或个人公众号后台 Cookie 创建原生会话。CLI 依赖 click/requests/packaging/filelock，不含上述后端实现。

因此不能声称这条候选不需要 root、Frida、注入、密钥访问或远程中转，也不能反向断言它一定需要这些东西：公开代码不足以确认。没有尝试访问本机 8011 或第三方服务，没有让用户扫描它的二维码或交出会话。

### 内容和分页审查

公开解码器把响应 `msgList` 解成“全部”，把 `articleTab/pictextTab/audioTab/videoList` 解成分类首屏；提取了 `id/msg_id/idx/title/url/original_url/item_type/published_at_ts`。贴图可提取 `picture_list` 和 `multi_pic_count`。这些字段给以后核验主次条、来源与图片类型提供了线索，但没有目标号原始响应支持。

不能照抄其完整性判断：

1. CLI 自行构造 protobuf 游标，`lastTs`、账号 anchor 填 0，再按解码条数/固定步长计算 offset。注释声称服务端会 fallback，不是本机真实游标证据。
2. 首屏 `has_more_all_tab` 用 `len(msg_list)>=5`，后续用列表非空；没有读取明确终止字段或核对上游总数。
3. `_decode_tab_bytes` 遇解析失败返回空数组，`_decode_tab_item` 遇未知/损坏结构返回 None，调用者静默过滤。错误可能被误当空页终点。
4. `profile_list` 未把原生 `baseResponse.ret` 非零当失败，缺失 ret 甚至输出 0。不能用外层 HTTP/code 成功冒充微信列表成功。
5. 分类首屏不等于分类全历史；`original_url` 也不足以区分转载文章与转发事件，尚缺真实字段语义及样本。

### 当前真正缺少的条件

这个候选的阻塞是**缺少可审查、可在本机运行的原生会话/传输实现和许可**，不是“再允许读取更多微信文件”。扩大 HTTP 缓存、读聊天数据库、重复扫码均不能补齐这段代码。现阶段没有具体可执行且符合边界的敏感访问方案，因此不建议要求用户笼统授权微信或安装未知后端。

若继续此候选，先需提供对应 wx-ipad 后端固定源码/版本/许可、设备支持表、登录与密钥生命周期、网络目的地，以及 CGI 2899 的实际请求/响应结构。必须先确认能在本机仅向腾讯第一方发送、无需聊天库和全局代理/证书变更，再审查实际所需的新增权限。只给远程 host 和 API key 不满足这些条件。

审查完成后才可提出最小实验：由用户在明确设备上建立专用原生会话，只允许目标 ghid 的首屏及服务端返回的下一页；预算 2 页、单次 30 秒，不采聊天或联系人，不读取指标，不保存密钥原文。首屏必须含近期漏项的真实身份，下一页必须推进真实游标并含不同身份；原生 ret、原始条目数、成功解码数及未识别类型必须分别记录。任何条件不满足即停止，不写库、不换账号重复扫码。**这只是待前提满足后的验证规格，当前不可执行，也不保证成功。**

## 新候选 B：weread-omni 的首屏形状

固定仓库 [teng-lin/weread-omni](https://github.com/teng-lin/weread-omni/tree/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4)，commit `88bd2e095d7d7ee423eaadf8f40653e72c5be6d4`，MIT，Copyright 2026 Teng Lin。只读下载了模块、登录/传输源码、文档与测试，没有安装运行 CLI。

[public-accounts.ts](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/api/resources/public-accounts.ts) 的 `publicAccountsModule.articles` 仍请求第一方 `/mp/chapters`，不是第三条新列表端点。它将两种参数形状分开：

- 首屏 `{bookId,count,synckey:0}`，不传 offset。
- 后续 `{bookId,count,offset}`，不传 synckey；synckey 作为增量令牌。

源码注释将这个区别归因于官方客户端行为。其 profile 使用墨水屏客户端凭据和 `vid/accessToken`，需要微信读书授权，不能复用公众号后台 Cookie。仅换 User-Agent 不算新依据。

主线随后从旧聊天证据核对：上一轮已经使用 `synckey=0,count=20` 且无 offset，多次得到 HTTP 499 / `-2041`。因此这不是新请求形状，已排除重试。不能因为新仓库或注释再次出现相同参数，就把同一失败请求包装成新实验。

主线另确认“微信读书 reader 真实页面上下文”与旧 Node axios 请求/首页 Referer 不同，旧 reader 调查只下载公开 HTML/JavaScript。这个浏览器上下文候选由后台来源研究线记录和主线集中判断，本线不重复浏览器操作或上游请求；上面的形状排除不能提前代替该候选的实际结果。

它也不能直接提供完整性证明：分页按返回条数少于 count 推算耗尽；本地 integration tests 是 Mock，live 测试仅限单页且没有目标漏项或历史终点证据。项目 Feed/导出默认和上限窗口不符合本项目的全量要求。[docs/endpoints.md](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/docs/endpoints.md) 中其他名字包含 article/list 的端点并未证明是目标账号历史源，本轮没有轮试。

## 共用验收约束

后续无论采用何来源，必须核对页级上游业务码、输入和输出游标、原始分组/条目数、解码条目数、目标号身份与原文身份、所有 idx、未知类型和结束原因。解析失败不能缩短列表后触发结束；转发事件不能把原文 biz 改成目标号。首屏、近期窗口或分类首屏不等于全历史。

本线没有取得任何近期漏项、真实 idx>1 或另一个订阅号的采集结果，也没有修改内置采集器。主线和独立验收已收到候选与排除依据，所有带授权实验由主线集中执行，避免重复请求。

## Reader 真实上下文：分页与次条独立核验清单

用户随后授权主线执行一次 reader 书架查询和目标首屏/下一页验证。本线仅审查本机固定源码，没有读取凭据或操作浏览器。参考 [Pengyf04/weread-mp-fetcher](https://github.com/Pengyf04/weread-mp-fetcher/tree/3944db5e6df3dfb7c12d1ac2fddb902361cbc781)，commit `3944db5e6df3dfb7c12d1ac2fddb902361cbc781`；本机入口 `complete-source-research/fetcher-lib-scripts.mjs` 与 `fetcher-lib-fetchflow.mjs`。实际新证据由主线保存到 `output/playwright/reader-probe/`，本节是审查要求，不是实测结论。

### 固定实现能证明与不能证明的内容

`buildPageJs(bookId,offset)` 在 reader 页面同源 fetch `/web/mp/articles?bookId=...&offset=...`，没有 count/maxIdx。`flatten` 遍历 `reviews[].subReviews[].review`，从 `review.mpInfo` 提取标题和 originalId；`fetchAll` 按原始 `reviews.length` 推进 offset，而非按展开后的文章篇数。这个分组区别必须保留，不能用生产库篇数反推下一页。

但参考实现不能直接拿来当完整性校验器：

- 它将没有 errCode 的任意对象视为成功，缺失 reviews 时默认为空；原始 schema 不成立、非 JSON、HTTP 错误和业务错误必须单独核对。
- `flatten` 只处理 subReviews，不能假定所有类型都在这个字段内。组对象本身是否有主条、其他嵌套项或未知内容，须用真实响应核对。
- title 为空会直接丢弃；最后只保留 `t/title/url/rid`，原始类型、组身份、来源字段和终止信息均丢失。不能只保存这个扁平结果。
- 时间使用 `review.createTime || group.createTime || 0`。0 是未知，组时间是否就是条目发布时间尚需原文验证，不能直接覆盖已可信的发布时间。
- 去重是原始 URL/rid，不处理短长链 canonical；无 URL/rid 的项目虽然保留，却还未获得可入库身份。
- `fetchAll` 只在 `reviews===0` 时停止，没有观察或返回真实终止字段；指定 pages 用尽也不标记 partial。这只提供有限页读取，不能证明完整历史。

### 首屏及下一页必须记录的证据

| 核验层        | 要保留的脱敏证据                                                                              | 失败判据                                                |
| ------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Reader 上下文 | 目标 bookId、书架返回的 reader URL、页面是否实际在 reader、请求时间和响应状态                 | 只登录/书架正常、页面空白、错误码或验证码均不算列表成功 |
| 原始响应结构  | 顶层字段名、业务码、reviews 是否数组、所有服务端游标/继续/终止/总数字段的名字和真实值（如有） | 不能将缺失字段补成空列表或 false，再据此结束            |
| 每页分组      | 输入 offset、reviews 数、每组公开 ID、subReviews 数、组内其他字段及未识别嵌套项计数           | 不得以展开篇数推进 offset，不得忽略未识别组             |
| 每页条目      | 原始子条数、成功解析数、缺标题/身份/类型数；公开 rid/originalId/URL；原始类型字段             | 成功解析数不足须有逐项原因，不能静默过滤                |
| 下一页推进    | 服务端游标优先；若真实协议确为 offset，则 offset 按原始组数增加；记录新旧组和条目身份交集     | 游标重复、不推进、重复整页或未知 schema 时停为 partial  |
| 近期漏项      | 标题候选、目标发布事件身份、原文 canonical、实际内容类型及可访问状态                          | 只匹配标题或封面不能认定漏项已找回                      |

请求完整 URL 中若出现认证字段，应去除再存；书架只保留本次目标及后续验证订阅号的公开标识。不要保存 Cookie、token、二维码、浏览器完整状态或 unrelated 书架内容。日志可以保存字段形状和摘要，但必须保留足以独立重建分组计数与身份集合的脱敏清单。

### Canonical、主次条和内容类型判据

1. `mpInfo.originalId` 是微信短链候选。参考源码把其中 `~` 映射为 `_`，但不能通过改字符串就宣称 canonical 已核验。应在真实原文中取得 `biz/mid/idx` 或 canonical/og:url，并确认非验证页；保留旧短链 ID 和带 sn 原文链接。
2. rid 或 `MP_WXS_...` 前缀可以辅助一致性核对，不能独自证明作品归属。来源账号与目标号不同的条目必须保留目标发布/转发事件和原文身份两层，不能把原文 biz 改成目标 biz。存在跨号条目也不能一律删除。
3. 同组所有 subReviews 都要逐项展开，不能只取第一项；真实 `idx>1` 必须来自原文/可信原始字段，不能由数组下标补造。无样本则记“次条未验证”。
4. 普通文章、贴图、转载、转发、音频/视频等以源字段和内容核对。已知第一方 `item_show_type=8` 分支只证明存在图片类型；不能假定 reader 类型值与该字段相同，也不能根据标题猜类型。未知类型必须保留元数据并列出，完整性仍未通过。
5. 本次授权的首屏和下一页通过仅证明通道和分页起点可用。随后持续采集必须到服务端真实终点，核对最后页、游标与总数（若有）；没有可解释的终止依据时保持 partial。时间/页数/预算上限、网络失败、授权失效均不是终点。
6. 正文受限或失败不能删掉已核验的列表条目；列表完整性和正文成功率分开。文章采集不请求互动指标，已有值保留，缺失保持 null。

首次源验证通过后，交由内置实现逐页持久化游标及页面身份摘要；写库前一致性备份，失败不推进游标。页面验收仍需目标漏项入库、历史终点、再次更新新增 0、另一订阅号同通道多页，以及旧 ID/正文/有效指标、RSS/Obsidian/图片保留。

### 官方 Reader 本轮真实结果独立复核（14:41）

本线只读主线生成的 `output/playwright/reader-live/shelf-summary.json` 和 `first-page-summary.json`，没有重复网络请求。主线报告列表是官方页面自动发送的一次首屏请求。

- 14:41:21（北京时间）书架 HTTP 200，响应有 `books` 数组，无 errCode，命中目标 `MP_WXS_3895431412`，并返回真实 deepLink 的 v 值。可据此确认本次网页登录/书架及目标 reader 地址取得成功；不能推断文章列表权限。
- 14:41:53 目标 offset=0 首屏 HTTP 200，业务 `errCode=-2041`、`errMsg=-2041`，响应键只有 `errCode/errMsg/errLog/info`。`reviewsIsArray=false`，`reviewsCount=null`。这是错误对象，不是 reviews 空数组，更不是历史为空或真实终点。
- 未取得任何可供展开的组、subReviews、文章身份、内容类型或继续标记。因此近期漏项、次条、分页推进和全历史终点均未验证；不具备请求下一页的游标依据。第二号也未通过同通道采集。

新网页登录与真实官方 reader 上下文已经产生这次失败结果，不能再以“尚未实际打开 reader”为由重试，也不能要求再扫码并承诺会恢复。此证据只适用于本机本账号该次目标请求，不能证明接口全球永久关闭或唯一成因。

当前经审查的候选尚无满足实施门槛的来源。继续 Web reader 路线需要腾讯上游实际接受当前账号的目标文章列表请求，或出现可核验的官方新请求条件；单纯等待、换参数或再次登录不是已有成功依据。原生路线仍缺公开可审查的会话/传输实现与许可，不能用扩大敏感读取替代。只有拿到真实目标条目及下一页后，才有依据实施正式全量通道；本轮未写生产采集适配器，也未将错误或空结果标为完成。

## 用户反馈 Reader 反复验证后的其他路线：PC 微信界面采集

用户报告官方阅读器反复弹验证后，本线停止 WeRead 探测，只审查公开源码。起点为 [Access_wechat_article @412b4a6d2f5005f01f70b20ad1c8530849eaafd3](https://github.com/yeximm/Access_wechat_article/tree/412b4a6d2f5005f01f70b20ad1c8530849eaafd3)。未安装运行其程序，也未操作本机微信。

已审查 `home_scan_service.py`、`wechat_home_scroller.py`、`wechat_browser_tabs.py`、`wechat_document_reader.py`、`main_flow_coordinator.py`、`main_flow_models.py` 和既有 `wechat_request_matcher.py`。它有 Windows UIA 读取主页日期/卡片、展开“余下 xx 篇”、滚动、打开和关闭文章页的实现。但这些模块没有提供“仅通过官方菜单复制链接”的完整采集链；现成链接识别仍从 MITM 请求或 Referer 取得，matcher 还要求授权 key。不能把该项目直接描述为无代理采集器。

可以研究另写 WeWe-RSS 内置 Windows helper：读取目标公众号主页可见卡片，逐条打开，触发官方“复制链接”，只读取本次复制结果，回到主页继续滚动，再以原文 canonical 验证身份。这个技术候选不必天然依赖代理、证书或聊天数据库，但是否适用于当前电脑版微信、贴图/转发是否都有可复制链接、PC 是否展示手机全部历史，均未验证。它不是已打通通道。

最小验证需要先取得新增访问授权：只访问用户指定的目标公众号主页/文章窗口 UIA，执行展开、滚动、打开、复制链接及返回；仅读取本次操作产生的剪贴板文本，不枚举剪贴板历史、不读聊天列表/消息/本地数据库或凭据。先限两屏和少量卡片，核对近期漏项、主次条、实际类型、复制链接与 canonical；未通过就不扩大自动化范围。具体 Windows helper、操作边界和暂停机制须先准备可审查实现，再申请实际执行。

历史终点不能从参考代码直接保证。`scroll_next` 在 UIA 快照不再变化或加载超时后返回 false，协调器即停止；这也可能是加载失败或控件没更新，并非真正“没有更多”。参考候选 fingerprint 使用账号、日期和标题，不能作生产文章去重身份。内置实现需明确区分停滞/错误/真实末尾，保存断点，未知状态保持 partial，不得改用屏数或短页猜全量结束。

维护代价是 Windows 微信登录常驻、交互桌面解锁、采集期间可能占用焦点和剪贴板；首次逐篇扫描较慢，微信 UI、窗口布局和缩放变化需维护。定时采集依赖可交互的桌面，不能承诺服务器后台无人值守。该项目许可为 CC BY-NC-SA 4.0，不能按 MIT 复制其模块；本轮只审查实现思路，未移植代码。
