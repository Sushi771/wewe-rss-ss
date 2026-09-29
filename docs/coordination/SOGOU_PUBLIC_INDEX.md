# 搜狗微信公开索引来源核验（2026-09-30）

本专项审查公开案例、固定版本开源代码和公开运行记录，并于 2026-09-30 对目标号先后做了下述**两次**匿名首屏请求；第二次在本地解析异常后停止，没有发 `/link` 请求。没有使用私有 Cookie 或凭据、没有改生产 SQLite。目标是 `妈妈部落畅聊阁 / MP_WXS_3895431412`，已知可信微信文章 `biz=Mzg5NTQzMTQxMg==` 可作为后续归属校验种子。搜狗候选与已经验过的微信读书 `/mp/chapters`、公众号后台跨号 `appmsgpublish`、有限的目标合集均是**不同来源假设**。

## 结论与来源属性

[搜狗提交给 SEC 的并购完成公告](https://www.sec.gov/Archives/edgar/data/1713947/000110465921118794/tm2123023d4_ex99-1.htm)称 2021-09-23 后搜狗由腾讯间接全资拥有；搜狗此前的 [20-F](https://www.sec.gov/Archives/edgar/data/1713947/000110465921038046/sogo-20201231x20f.htm)明确描述微信公众平台内容搜索合作。因此 `weixin.sogou.com` 是腾讯旗下公开搜索服务，但**不是微信公众平台的完整发文目录 API**，也不是本项目所禁的私人开发者闭源中转或商业授权服务器。搜索索引覆盖和更新时延仍须实测，不能从所有权推定全量能力。

[Lovstudio 2026-08-01 一手故障与修复记录](https://lovstudio.ai/blog/wechat-cross-account-index-ret-200013-2026)称：其产品「微探」的后台跨号列表首屏 `200013` 后，使用搜狗**移动公开入口**按账号 alias 搜索五页、按昵称精确过滤、解析临时签名 URL、从微信 `/s` 正文页核对 `biz`，最终在**另一个号「深思圈」**完成最新十篇列表及十篇正文。文中还给出关键失败：对完整 URL 调 `html.unescape()` 可将 `&timestamp` 的开头误解为 `&times`，使 `timestamp` 缺失和 `src=...×tamp`，修复为只处理明确的 `&amp;`、`&#38;`、`&#x26;` 并校验 `src/timestamp/signature`。这是作者的一手运行报告，但文中没有公开「微探」移动索引采集与解析源码、脱敏的逐条结果或可独立重跑的目标证据；十篇结果不能转写为本项目目标号的成功。

## 固定代码追踪

| 实现与版本 | 真正发送的请求及解析 | 认证、列表、正文和图片边界 |
| --- | --- | --- |
| [tjx666/wx-search-cli `70b75b7`](https://github.com/tjx666/wx-search-cli/tree/70b75b71384b4bcfce86be744b685f02f9440c16)（2026-07-04） | [`src/search.ts:42-58`](https://github.com/tjx666/wx-search-cli/blob/70b75b71384b4bcfce86be744b685f02f9440c16/src/search.ts#L42-L58)直接 `GET https://weixin.sogou.com/weixin`，参数 `type=2, s_from=input, query, ie=utf8, page, _sug_=n`；[`src/search.ts:77-99,146-177`](https://github.com/tjx666/wx-search-cli/blob/70b75b71384b4bcfce86be744b685f02f9440c16/src/search.ts#L77-L99)逐条 `GET` 搜狗结果 `/link?...`；[`src/parsers.ts:101-123`](https://github.com/tjx666/wx-search-cli/blob/70b75b71384b4bcfce86be744b685f02f9440c16/src/parsers.ts#L101-L123)拼接页面内 `url += '...'` 片段，得微信签名 `/s?...`。[`src/search.ts:118-135`](https://github.com/tjx666/wx-search-cli/blob/70b75b71384b4bcfce86be744b685f02f9440c16/src/search.ts#L118-L135)按 `page` 翻页，遇验证码错误中断。 | [`src/parsers.ts:21-45`](https://github.com/tjx666/wx-search-cli/blob/70b75b71384b4bcfce86be744b685f02f9440c16/src/parsers.ts#L21-L45)从搜索响应 `Set-Cookie` 取得同一搜狗会话 Cookie，并解析 `timeConvert('Unix秒')` 为 ISO 时间；无需微信账号登录。[`src/content.ts`](https://github.com/tjx666/wx-search-cli/blob/70b75b71384b4bcfce86be744b685f02f9440c16/src/content.ts#L13-L64)直连微信签名文章 URL，只抽 `#js_content` 纯文本，**没有图片保存、作者精确过滤或 `biz` 校验**。默认单页失败可返空；隔离验证须用 strict 语义区别验证码与无结果。 |
| [fancyboi999/weixin_search_mcp `a5a70a2`](https://github.com/fancyboi999/weixin_search_mcp/blob/a5a70a26ca36dc7ebb201ce9d9bb54a746758ecb/weixin_search_mcp/tools/weixin_search.py)（2026-08-17 仓库提交） | [`weixin_search.py:19-96`](https://github.com/fancyboi999/weixin_search_mcp/blob/a5a70a26ca36dc7ebb201ce9d9bb54a746758ecb/weixin_search_mcp/tools/weixin_search.py#L19-L96)同样 `requests.get('https://weixin.sogou.com/weixin', params=...)`，逐项 GET `/link`，按 `page` 返回；[`107-126`](https://github.com/fancyboi999/weixin_search_mcp/blob/a5a70a26ca36dc7ebb201ce9d9bb54a746758ecb/weixin_search_mcp/tools/weixin_search.py#L107-L126)逐页低速循环。 | [`129-204`](https://github.com/fancyboi999/weixin_search_mcp/blob/a5a70a26ca36dc7ebb201ce9d9bb54a746758ecb/weixin_search_mcp/tools/weixin_search.py#L129-L204)使用**硬编码旧搜狗 Cookie**解析跳转，然后 `requests.get(real_url)` 抽 `#js_content` 文本；未处理图片或目标 `biz`。自部署源码可审查，不需要运行别人的 MCP 服务；但静态 Cookie 不宜作为长期认证来源。 |
| [OpenCLI `2413694`](https://github.com/jackwener/OpenCLI/blob/24136945847afbfad266c6c46a8cd335377f9112/clis/weixin/search.js)（仓库 2026-09-25 提交） | [`search.js:31-37,107-146`](https://github.com/jackwener/OpenCLI/blob/24136945847afbfad266c6c46a8cd335377f9112/clis/weixin/search.js#L31-L37)让 Chrome 打开 `https://weixin.sogou.com/weixin?query=...&type=2&page=N&ie=utf8`，DOM 读取标题、搜狗 `/link`、摘要、渲染时间；**没有解析最终微信 URL**。 | Browser Bridge 读取公开搜狗页，验证码由浏览器里的人正常处理；[`download.js:232-363`](https://github.com/jackwener/OpenCLI/blob/24136945847afbfad266c6c46a8cd335377f9112/clis/weixin/download.js#L232-L363)另需输入已解析的微信 `/s` URL 才能抓 `#js_content`、`data-src` 图片并本地保存。该浏览器路径没有使用 PC 微信窗口，但不能直接作为后台服务器采集组件。 |
| [RSSHub `39ace33`](https://github.com/DIYgod/RSSHub/blob/39ace33f1268e19714278d7dbc7eee2d58e985f1/lib/routes/wechat/sogou.ts)（仓库 2026-09 仍更新） | [`sogou.ts:20-59`](https://github.com/DIYgod/RSSHub/blob/39ace33f1268e19714278d7dbc7eee2d58e985f1/lib/routes/wechat/sogou.ts#L20-L59)直接 GET 同域 `/weixin`，`type=2, query=wechatId`，但 `page` 固定 `1`；[`60-103`](https://github.com/DIYgod/RSSHub/blob/39ace33f1268e19714278d7dbc7eee2d58e985f1/lib/routes/wechat/sogou.ts#L60-L103)追 `/link` 重定向，不能解析时保留搜狗临时链接。 | 源码 [`11,34,66`](https://github.com/DIYgod/RSSHub/blob/39ace33f1268e19714278d7dbc7eee2d58e985f1/lib/routes/wechat/sogou.ts#L10-L35)用硬编码 Cookie；[`121-181`](https://github.com/DIYgod/RSSHub/blob/39ace33f1268e19714278d7dbc7eee2d58e985f1/lib/routes/wechat/sogou.ts#L121-L181)读搜索结果作者及 Unix 时间、调用 `finishArticleItem`。[正文 helper 的真实 HTTP 行](https://github.com/DIYgod/RSSHub/blob/39ace33f1268e19714278d7dbc7eee2d58e985f1/lib/utils/wechat-mp.ts#L603-L654)向微信 `/s` URL 发请求，[图片处理](https://github.com/DIYgod/RSSHub/blob/39ace33f1268e19714278d7dbc7eee2d58e985f1/lib/utils/wechat-mp.ts#L348-L365)将 `data-src` 设为 `src`，并未证明图片字节已本地保存。作为 Provider 样例不足：第一页、没有 `biz` 校验、guid 用会变的签名链接。 |

四套实际列表代码均指向**桌面公开网页 `/weixin`**；没有证据表明它们使用案例所说的移动 `/weixinwap`。公开 [移动搜索入口示例](https://greasyfork.org/zh-CN/scripts/535242-%E7%A7%BB%E5%8A%A8%E7%AB%AF%E8%81%9A%E5%90%88%E6%90%9C%E7%B4%A2ai%E4%BF%AE%E6%94%B9/code)仅给出 `https://weixin.sogou.com/weixinwap?type=2&query=` 的导航 URL，**没有结果 DOM、分页、跳转解析的开源实现**。Lovstudio 文中「按 alias 搜五页」是作者报告，不能凭桌面代码替代移动代码证明这几个字段。

## 近期实测和风险

- `wx-search-cli` 的 [live 测试源码](https://github.com/tjx666/wx-search-cli/blob/70b75b71384b4bcfce86be744b685f02f9440c16/tests/live/sogou.test.ts#L16-L66)明确做一页通用关键词搜索、至少一条 `/link`→微信 URL 解析、Unix 时间和一篇正文请求。[2026-08-10 定时运行 #37](https://github.com/tjx666/wx-search-cli/actions/runs/31355535906)显示 `Success`；这是最近能核实的一次真实外部运行，**不是 2026-09-30 可用性或目标号覆盖证明**。仓库无近期 issue；OpenCLI 的整体仓库仍在 2026-09-25 更新，但其搜索适配器现场成功记录未核实。
- [RSSHub 2025-07 讨论](https://github.com/DIYgod/RSSHub/discussions/19536)有用户报告搜狗路由拿到的竟是 2016 年旧文；[2023-07 issue #12808](https://github.com/DIYgod/RSSHub/issues/12808)报告签名链接更新造成同篇重复。两者说明搜索排序、缓存、URL 不能直接当发表目录和稳定 ID。相关机器人回答只作线索，用户报告也只证明当时个案。
- 搜狗结果阶段只有关键词匹配，不保证跨号结果全属一个公众号。RSSHub 读到了作者昵称但没有严格过滤；TypeScript/Python CLI 连作者都没读。隔离验证须先用显示昵称精确筛，再从腾讯原文 `biz` 与目标已知 `biz` 比较，文章身份取腾讯 `mid/idx`，发表时间与原文 `ct` 核对；签名查询串要完整保存但不作为稳定文章 ID。正文图片须走本项目已有腾讯 `data-src`/图片保存链路，不能把 CLI 的纯文本正文视为图片已达标。
- 验证仅接受原样、完整的腾讯文章链接；解析后限定 `https://mp.weixin.qq.com/s` 主机和路径，检查 `src/timestamp/signature`（若返回的是签名形状），避免 `html.unescape` 损坏。遇搜狗或微信验证码立即停该网络路径，不循环重试，也不保存原始会话 Cookie/页面到 Git。

## 可并入总候选矩阵的一行

| 来源 | endpoint 与源码 | 认证 | 跨号 | 列表/分页 | 发布时间 | 正文/图片 | 近期证据 | 与旧失败差异 | 最小验证 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 腾讯旗下搜狗微信公开**搜索索引** | `GET weixin.sogou.com/weixin?type=2&query=&page=`；逐项同域 `/link` → `mp.weixin.qq.com/s`，见上表固定代码。移动 `/weixinwap?type=2&query=` 只有公开入口和作者回归，无可审查采集实现 | 搜狗匿名搜索 + 搜索响应的会话 Cookie，微信原文公开访问；无闭源私人中转 | 关键词可搜跨号，但目标归属须腾讯原文 `biz` 核对 | 桌面代码分页可审查，搜索覆盖/排序/更新延迟无 SLA；RSSHub 只第 1 页 | 搜狗 `timeConvert` 候选，原文 `ct` 再核 | 腾讯原文 `#js_content`；图需从 `data-src` 下载并核验 | 2026-08-10 通用词 live 成功；2026-08-01 别号十篇作者报告；本项目 2026-09-30 两次目标首屏 HTTP 200、无验证码，首次 9 卡片/8 昵称匹配 | 服务、认证和发现机制均不同于读书 `/mp/chapters` 和后台 `appmsgpublish` | 首屏候选已实测；`/link` 未请求，第二次因本地脚本异常中止；移动入口先补结果页/翻页/跳转一手结构，仍不具备 Provider 条件 |

## 下一步最小验证边界

### 第一阶段：目标首屏一次请求

2026-09-30 以仓库已有的目标号名 `妈妈部落畅聊阁` 为 `query`，只发**一次**匿名 `GET https://weixin.sogou.com/weixin?type=2&query=<已确认名称>&page=1`；采用 `wx-search-cli` 固定源码所示桌面 User-Agent，显式禁用代理、Cookie、自动跳转和重试，15 秒超时。没有访问 `/link` 或微信原文、没有输出或保存标题、完整 URL、Cookie 和原始 HTML，也没有触及生产库。内存中按公开源码的 `sogou_vr_11002601_box_*` 卡片结构计数，对 `all-time-y2` 作者字段作 HTML 解码及精确昵称比对，对 `s2` 时间字段只检查非空。

| HTTP | 验证码/限制特征 | 结果卡片 | 有作者字段 | 有非空时间字段 | 作者精确匹配目标昵称 | 重定向 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 200 | 未检出 | 9 | 9 | 9 | 8 | 无 |

这证明**本时点桌面公开索引首屏存在目标昵称候选**，且当前网络未直接落到验证码页；第九条未匹配目标昵称。候选搜索结果尚无腾讯原文 `biz/mid/idx/ct` 核验，时间字段也尚未与原文发布时间交叉核对。9/8 均不得称为真实目标文章、最新文章、正文或持续订阅恢复。

### 第二阶段：一次新首屏后因本地解析异常中止

经总控复审第一阶段后，重新建立**仅内存**搜狗 Cookie 会话并发一次同形状、无代理/自动跳转/重试的匿名索引首屏 GET；计划在首屏合格时等待 2 秒，再只对列表时间可解析且作者精确匹配目标的最新一条候选发一次 `/link` GET。新首屏实际得到 **HTTP 200、未检验证码特征、9 条结果卡片**。解析第一条精确作者候选及其 Unix 时间后，本地 PowerShell 脚本抛出 `MethodException`，依任务约束立即停止：**没有发送 `/link` 请求**，也没有请求微信原文。此轮作者匹配数和时间可解析数是**不完整的局部计数**，不得引用为全页结果；第一阶段的 8/9 观察是独立的完整首屏计数。第二阶段没有输出或落盘标题、完整 URL、Cookie、原始 HTML，运行进程结束后会话已销毁。

异常原因已用**完全离线的合成卡片**复现：PowerShell 的正则 `-match` 会写自动变量 `$Matches`，变量名大小写不敏感；原脚本又用 `$matches` 保存候选列表，筛选 `<a>` 时把列表覆盖成 `Hashtable`，后续 `.Add(...)` 触发 `MethodException`。离线复现实测为 `remainingType=Hashtable`、`errorType=MethodException`。修正后候选列表改名 `$candidateRecords`，用三条合成卡片的纯解析测试得到：3 条卡片、2 条精确作者匹配、2 条 Unix 时间可解析、选中两条中的较新时间、搜狗 `/link` 主机与路径校验通过。该测试没有网络请求，**不证明真实第二阶段可解析 `/link`**。

下一次网络验证需总控重新 Review 后单独决定，因为当前没有保留合法会话 Cookie 或候选链接；不得把一次中止伪装成 `/link` 失败。若获准，只发新的首屏及至多一条同会话 `/link`，校验最终腾讯 URL 为 `https://mp.weixin.qq.com/s` 且 `src/timestamp/signature` 参数名齐全，不跟随跳转、不访问腾讯原文；后续 `biz/mid/idx/ct` 要作为另一轮验证。遇验证码或限制立即停止。五篇、分页、正文图片与自然更新均未在搜狗路线验收；**Provider 接入条件尚未满足**。
