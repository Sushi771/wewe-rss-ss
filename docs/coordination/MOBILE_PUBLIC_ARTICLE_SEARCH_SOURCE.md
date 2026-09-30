# 移动公开文章搜索源码核查（2026-09-30）

## 可复核的新发送链

[岱宗盒子 Android 固定源码 `76ec234d`](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1810-L1822) 有一条此前候选矩阵未记录的**真正移动请求**：`fetchPage` 在桌面 `https://weixin.sogou.com/weixin?type=2&...&page=1` 未解析出结果时，首页回退到 `GET https://weixin.sogou.com/weixinwap?type=2&query=<编码关键词>`。其 [`fetch`](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1761-L1793) 调用 OkHttp `newCall(...).enqueue(...)`，不是搜索导航链接，也没有私人闭源中转。该固定源码的 GitHub 页面显示 2026-09-28 近期提交。

| 核查项 | 固定源码证据与边界 |
| --- | --- |
| 认证 | [`webCookies` 与 `webClient`](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1555-L1608) 在本进程保存公开网页 Set-Cookie；移动回退前程序尝试公开搜狗首页；源码没有账号登录或第三方凭据。**代码设计为匿名访问，并未证明目标时点实际可匿名返回文章。** |
| 卡片解析 | [`parseSogouResults`](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1681-L1707) 用 Jsoup 尝试 `li[id^=sogou_vr_]` 等容器，再按 `TITLE_SELECTORS` 取标题；遇验证码返回空结果。该源码没有移动专用选择器测试。本项目保存的真实移动页标题在 `h4 a`，不在其四种标题选择器中，故该实现**会丢掉本次页面的全部九张卡**。 |
| 原文 URL | [`normalizeSearchLink`](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1669-L1679) 只将相对 href 补成绝对 URL，未解析或核对 `mp.weixin.qq.com` 目标；结果可能仍是搜狗 `/link?url=` 跳转，不能当作官方原文。 |
| 跨号与身份 | `query` 是任意关键词，理论上索引跨号；返回 `Triple<title,link,snippet>`，**未提取公众号名、`biz/mid/idx` 或稳定文章 ID**。目标号精确过滤和增量覆盖未证实。 |
| 分页、时间、正文图片 | [`MAX_SEARCH_PAGES=1`](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1710-L1717) 且移动端只在第一页作为回退调用；代码没有移动分页、`ct`/发表时间、正文和图片映射。它们须另行确认。 |
| 近期真实返回 | 2026-09-28 的近期提交证明实现仍在仓库；源码旁的 2026-09 校园网实测注释说的是[百度与 360 搜索](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1870-L1875)。**本项目 2026-09-30 单次移动 GET 已取得完整 HTML 200 和文章卡片**；这是本项目自身的搜狗索引回包，不是开源项目运行成功或目标号订阅恢复。 |

这条移动路径与此前已测的桌面 `/weixin?type=2` **endpoint 不同**。它现在已证明可以在本次条件下返回关键词搜索卡片；尚未证明按号持续更新、官方原文身份与可信发表时间。

## 本项目单次首屏回包：离线复核

总控于 2026-09-30 对已确认目标号名运行一次隔离只读探针，得到 **HTTP 200、43,612 字节完整 HTML**。私有原始页不入 Git；其 SHA-256 为 `169880e6c825d70cc7c0258150414426265af5d0eaab745055ceee1152dbd13b`。以下仅对这一份离线快照用 HTML DOM 和字段存在性检查，**本轮没有发网络请求，也没有访问 `/link`**。

| 问题 | 快照中的一手结果 | 可作何种结论 |
| --- | --- | --- |
| 文章数与来源 | 原始字符串 `sogou_vr_` 出现 11 次，其中 9 次是 `li` 的真实 DOM ID，另 2 次在脚本里。9 张卡均有不同标题、DOM ID 与跳转 href。`span.s2` 来源名 **8/9 精确等于目标号名**；另 1 张属于其他号，目标词仅在它的卡片文本里。 | 搜狗索引当前能返回八个**标注为目标号**的不同搜索结果；必须按来源名筛选，不能把 11 个正则命中或 9 张卡全当目标文章。来源名仍不是官方 `biz` 身份证明。 |
| 标题解析 | 9 张卡的标题都在 `h4 a`。Android 源码的四个标题选择器 `.txt-box h3 a`、`h3 a`、`.vrTitle a`、`a[target=_blank]` 在 9/9 张卡均没有命中；其 `li[id^=sogou_vr_]` 容器选择器能命中。 | 此移动 HTML 需要单独适配解析器；现有开源 Android 回退逻辑虽然会发送请求，却不能从这份页面输出文章。 |
| 日期 | 每张卡 `span.s3` 都展示 `YYYY-MM-DD`，本页范围 **2026-03-02 至 2026-03-31**，顺序不是日期倒序。 | 这是搜狗**展示日期**；快照没有官方原文 `ct` 可交叉验证，不得作为可信发表时间。2026-09 的本次首页也不能证明发现当期新文或持续增量。 |
| 稳定身份与原文 | 九张卡的标题链接均是搜狗相对 `/link`，含 `url/token/query/type` 查询键；`url` 值是 280 字符不透明串，离线解码后仍无 URL 主机。卡片中没有直接 `mp.weixin.qq.com` 链接，也没有 `__biz/mid/idx/ct`。 | DOM ID 与搜狗跳转仅是搜索索引标识，不能当作微信原文稳定 ID；本页无法离线核验官方原文地址、正文或文章真实归属。 |
| 图片 | 每张卡的缩略图来自 `img01.sogoucdn.com/v2/thumb`。 | 只能证明搜索卡片有缩略图，不能代表官方原文图片可保存。 |
| 分页 | 内联脚本有 `totalPages=4`，页面引用同域 `/new/wap/js/next_page.min.js?v=20200326`；静态 HTML 没有 `#next_page` 元素或下一页 href。随后单独审查该公开 JS，查到真实翻页请求表达式，见下节。 | 代码提供**候选页 2 请求形状**，但按钮在保存的 DOM 中缺席；后续一次匿名请求被探针保守归为验证停止，未取得可审的分页条目；四页不代表目标号全量。 |

## 第一方分页脚本与一次性页 2 设计

总控随后授权只读公开静态资源。页面实际引用的 [同源 `next_page.min.js?v=20200326`](https://weixin.sogou.com/new/wap/js/next_page.min.js?v=20200326) 返回 HTTP 200、3,154 字节，SHA-256 为 `a2c62f23a3e989914fd45795a5eab98b13a82bc365ec660c8621ebb9833935c7`。其代码先设 `window.curPageNum=1`、`window.moreResultUrl=window.location.href`（仅在两者未定义时）；点击 `#next_page` 时在该 URL 的首个 `?` 后插入 `page=<curPageNum+1>&_rtype=json&`，由同源 `$.ajax({url:b,dataType:"json"})` 发 GET。保存的目标 HTML 没有覆写这两个全局量，因此以**探针原始首屏 URL**为基底，推导的候选请求是 `GET https://weixin.sogou.com/weixinwap?page=2&_rtype=json&type=2&query=<原首屏编码目标号名>`。这是代码推导，**不是页 2 已成功的回包**；保存的静态 DOM 没有 `#next_page`，其他 JS 是否动态插入按钮未知。

该 JS 的成功回调把 JSON `items[]` 各项作为 XML 解析，可读 `display.url/title/lastModified/sourcename/docid`，以及外层 `openid/encArticleUrl` 等字段；这些只是**解析器期望字段**，目前未见可审的页 2 条目。回调若收到 `token` 还会额外 GET `/approve`，此副作用不属于取文验证，研究探针明确不执行。原页面在浏览器中发同源 AJAX 时可能自动附带 Set-Cookie；首屏探针没有保留响应 Cookie，私有 HTML 也不提供可核实的同会话 Cookie，故探针**只代表匿名页 2 条件**，不猜测或伪造 Cookie。

[`probe-mobile-public-article-page2.cjs`](../../scripts/research/probe-mobile-public-article-page2.cjs) 的 `--preflight` 离线核对目标名哈希、首屏 HTML 和静态 JS 的 SHA-256、`totalPages=4`、默认游标与同源页 2 URL；`--self-test` 用假响应验证正常 JSON、文章文本含“验证码”、302、挑战 JSON/HTML、429、非法 JSON、超限和重复哨兵，真实网络调用为零。总控已对页 2 执行**唯一一次匿名同源 GET**；脚本先 `wx` 建立并同步私有哨兵，没有跟随跳转、重试、请求 `/approve`、`/link` 或原文。仅 HTTP 200、完整、无验证/限流且具 `items[]` 的合法 JSON 才可私存原始内容（最多 256 KiB）。

这次私有脱敏摘要为 HTTP 200、`application/json`、完整读入 51,307 字节、无跳转，分类 `verification-stop`、`shape:null`、原始字节保存 0。**这是保守分类器触发验证停止；原始响应未留，实际 JSON schema、是否存在 `items[]` 与条目内容均未知。** 旧脚本在 `JSON.parse` 前对整段响应匹配 `验证码|captcha|antispider|…`，可能误中合法文章正文；另一路是解析后顶层 `anti` 非空。无法从摘要区分触发源，更不能声称腾讯确实返回了验证码。固定 JS 对 `anti.account` 的处理位于账号搜索分支，不足以证明本次文章页 2 的 `anti` 含义。脚本已改为先解析 JSON，仅对顶层错误描述或 `anti` 判保守停止；合法 `items[]` 内文章文本含关键词仍可私存。**修复只适用于未来独立证据支持的探针，不重发本目标页 2；已有哨兵继续拒绝相同请求。**

本次既未取得官方原文身份，也未证实翻页能力。下一次在线请求须先找到与此匿名 Sogou 页 2 **不同的**公开源码发送机制及近期一手有效回包，明确请求状态和所需认证，再单独复审；当前这份摘要本身不提供这样的候选。

关于单篇原文 URL，[2026 `wx-search-cli` 固定代码](https://github.com/tjx666/wx-search-cli/blob/70b75b71384b4bcfce86be744b685f02f9440c16/src/search.ts#L138-L179) 会用同次桌面搜索响应签发的 Cookie 请求搜狗 `/link`，自动跟随跳转，再从响应 HTML 的 `url += '...'` 片段拼出 `mp.weixin.qq.com` URL；[其 Cookie 读取代码](https://github.com/tjx666/wx-search-cli/blob/70b75b71384b4bcfce86be744b685f02f9440c16/src/parsers.ts#L21-L34)称缺失 Cookie 会触发反爬。[`qbu11` 固定实现](https://github.com/qbu11/wechat-article-spider/blob/ccf291ee787a687f6c02d2e7db49275898cfd0a9/packages/runtime/http.ts#L91-L124)虽然以 `redirect: manual` 发单跳，但函数会自动接续最多五次跳转，随后才在[业务层判验证码](https://github.com/qbu11/wechat-article-spider/blob/ccf291ee787a687f6c02d2e7db49275898cfd0a9/packages/runtime/service.ts#L275-L296)。两者均不能原样用于本项目的验证码停步探针。首屏同会话 Cookie 缺失也限制 `/link` 解析的解释力；本轮没有执行 `/link` 请求，页 2 停步不构成它的成功依据。

## 公开检索边界

本轮对 GitHub/网页的一手源码、2025–2026 fork/issue 及 [Sourcegraph 的 `weixinwap` 公共代码索引](https://sourcegraph.com/search?q=context%3Aglobal%20weixinwap%20count%3A500%20fork%3Ayes%20archived%3Ayes) 复查，并区别以下实现：

- [2025 更新的移动搜索切换脚本](https://greasyfork.org/zh-CN/scripts/529210-%E8%81%9A%E5%90%88%E6%90%9C%E7%B4%A2%E5%BC%95%E6%93%8E%E5%88%87%E6%8D%A2%E5%AF%BC%E8%88%AA-%E8%87%AA%E6%94%B9/code#L159-L165) 仅构造 `weixinwap?type=2&query=` 导航，不取回或解析结果。
- [旧 JSONP 移动代码的转载](https://blog.51cto.com/u_16213650/11760069)使用 `/weixinwap?_rtype=json` 的 `type:1` **账号搜索**与 `totalPages`；文章抓取仍是 TODO，不能推导 `type:2` 移动文章分页。
- [2026 的 `wx-search-cli`](https://github.com/tjx666/wx-search-cli) 虽有分页、时间与原文跳转解析，但其 README 和代码指向**桌面搜狗**文章搜索，不是本次独立移动机制；[2026 `qbu11` 解析器](https://github.com/qbu11/wechat-article-spider/blob/ccf291ee787a687f6c02d2e7db49275898cfd0a9/packages/runtime/sogou.ts#L23-L113)亦如此。
- [2026-08 移动索引作者反馈](https://lovstudio.ai/blog/wechat-cross-account-index-ret-200013-2026#main-analysis)称有跨号最新 10 篇，但未公开相应移动请求/目标号返回；可作为线索，不能补足本候选的真实回包。

公开索引有覆盖限制；上述外部代码只辅助定位请求。**本项目自己的单次真实回包已证明移动关键词搜索首屏有卡片**，后续官方身份、原文、分页与持续增量仍各需独立验证。

## 单次隔离验证设计

[`scripts/research/probe-mobile-public-article-search.cjs`](../../scripts/research/probe-mobile-public-article-search.cjs) 已由总控在已确认目标号名上运行一次；B 线只离线复核，**不要重跑首屏**。原调用形式留作方法记录：

```powershell
node scripts/research/probe-mobile-public-article-search.cjs --account-name '已确认的目标号名'
```

脚本只向腾讯旗下搜狗域名发**一次** `GET /weixinwap?type=2&query=...`，不做首页预热、重试、翻页、重定向、`/link` 解析或原文请求。请求前在用户主目录 `.wewe-rss-private/mobile-public-search/` 以目标名哈希 `wx` 独占创建、`fsync` 持久化哨兵；相同名称再次运行会在请求前拒绝。结果先同步写入旁文件，再原子替换哨兵，并在系统支持时同步目录项。只有 **HTTP 200、HTML、非验证码/限流、未截断**的响应才私存原始 HTML（上限 128 KiB）；其余情况只保留脱敏结构摘要（HTTP 状态、跳转主机与无查询参数的路径、截断标志），控制台不输出查询词、文章链接或原文。若遇 302/验证码/限流，只记录并停止；首屏返回后应先离线审查是否真的有文章卡片、号名、分页线索、稳定时间与官方原文 URL，再决定是否值得后续独立验证。此探针的直接裸 GET 可能与源码先访问公开首页后的 Cookie 状态不同，首屏失败仅排除**这次匿名单请求条件**。

离线门禁可运行 `node scripts/research/probe-mobile-public-article-search.cjs --self-test`：假网络覆盖 200 文章卡片、普通 302、验证码跳转/页面、限流页面/429、超过上限、重复哨兵，并断言真实网络调用为零。自测只在用户主目录的私有目录创建短暂假数据，结束逐文件清理，不使用系统 TEMP。
