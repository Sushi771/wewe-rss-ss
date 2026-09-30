# 移动公开文章搜索源码核查（2026-09-30）

## 可复核的新发送链

[岱宗盒子 Android 固定源码 `76ec234d`](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1810-L1822) 有一条此前候选矩阵未记录的**真正移动请求**：`fetchPage` 在桌面 `https://weixin.sogou.com/weixin?type=2&...&page=1` 未解析出结果时，首页回退到 `GET https://weixin.sogou.com/weixinwap?type=2&query=<编码关键词>`。其 [`fetch`](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1761-L1793) 调用 OkHttp `newCall(...).enqueue(...)`，不是搜索导航链接，也没有私人闭源中转。该固定源码的 GitHub 页面显示 2026-09-28 近期提交。

| 核查项 | 固定源码证据与边界 |
| --- | --- |
| 认证 | [`webCookies` 与 `webClient`](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1555-L1608) 在本进程保存公开网页 Set-Cookie；移动回退前程序尝试公开搜狗首页；源码没有账号登录或第三方凭据。**代码设计为匿名访问，并未证明目标时点实际可匿名返回文章。** |
| 卡片解析 | [`parseSogouResults`](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1681-L1707) 用 Jsoup 尝试 `ul.news-list > li`、`.vrwrap` 等容器，按优先级读 `.txt-box h3 a` 等标题链接与摘要；遇验证码返回空结果。**同一个解析器也处理桌面页**，没有保存的移动非空回包或移动专用选择器测试。 |
| 原文 URL | [`normalizeSearchLink`](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1669-L1679) 只将相对 href 补成绝对 URL，未解析或核对 `mp.weixin.qq.com` 目标；结果可能仍是搜狗 `/link?url=` 跳转，不能当作官方原文。 |
| 跨号与身份 | `query` 是任意关键词，理论上索引跨号；返回 `Triple<title,link,snippet>`，**未提取公众号名、`biz/mid/idx` 或稳定文章 ID**。目标号精确过滤和增量覆盖未证实。 |
| 分页、时间、正文图片 | [`MAX_SEARCH_PAGES=1`](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1710-L1717) 且移动端只在第一页作为回退调用；代码没有移动分页、`ct`/发表时间、正文和图片映射。它们须另行确认。 |
| 近期真实返回 | 2026-09-28 的近期提交证明**实现仍在仓库**，不证明移动回退实际命中过文章。本轮公开仓库、issue 与搜索未找到移动支路的脱敏非空回包；源码旁的 2026-09 校园网实测注释说的是[百度与 360 搜索](https://github.com/yeliqin666/xjtu-toolbox-android/blob/76ec234d10e9997cd017754274a5d5e5a6860955/app/src/main/java/com/xjtu/toolbox/agent/AgentTool.kt#L1870-L1875)，不可挪作搜狗移动成功证据。 |

这条移动路径与此前已测的桌面 `/weixin?type=2` **endpoint 不同**，且具有实际发送与解析代码，适合**一次隔离的首屏响应形态探针**。即便返回文章卡片，仍只证明关键词搜索发现，不能直接当成可按号持续更新的订阅列表。

## 公开检索边界

本轮对 GitHub/网页的一手源码、2025–2026 fork/issue 及 [Sourcegraph 的 `weixinwap` 公共代码索引](https://sourcegraph.com/search?q=context%3Aglobal%20weixinwap%20count%3A500%20fork%3Ayes%20archived%3Ayes) 复查，并区别以下实现：

- [2025 更新的移动搜索切换脚本](https://greasyfork.org/zh-CN/scripts/529210-%E8%81%9A%E5%90%88%E6%90%9C%E7%B4%A2%E5%BC%95%E6%93%8E%E5%88%87%E6%8D%A2%E5%AF%BC%E8%88%AA-%E8%87%AA%E6%94%B9/code#L159-L165) 仅构造 `weixinwap?type=2&query=` 导航，不取回或解析结果。
- [旧 JSONP 移动代码的转载](https://blog.51cto.com/u_16213650/11760069)使用 `/weixinwap?_rtype=json` 的 `type:1` **账号搜索**与 `totalPages`；文章抓取仍是 TODO，不能推导 `type:2` 移动文章分页。
- [2026 的 `wx-search-cli`](https://github.com/tjx666/wx-search-cli) 虽有分页、时间与原文跳转解析，但其 README 和代码指向**桌面搜狗**文章搜索，不是本次独立移动机制；[2026 `qbu11` 解析器](https://github.com/qbu11/wechat-article-spider/blob/ccf291ee787a687f6c02d2e7db49275898cfd0a9/packages/runtime/sogou.ts#L23-L113)亦如此。
- [2026-08 移动索引作者反馈](https://lovstudio.ai/blog/wechat-cross-account-index-ret-200013-2026#main-analysis)称有跨号最新 10 篇，但未公开相应移动请求/目标号返回；可作为线索，不能补足本候选的真实回包。

公开索引有覆盖限制；本轮只确定上述新源码值得做一次响应探针，**未证明移动搜索当前成功，也未证明它失效**。

## 单次隔离验证设计

新增 [`scripts/research/probe-mobile-public-article-search.cjs`](../../scripts/research/probe-mobile-public-article-search.cjs) 仅供总控复审后执行，当前 B 线**未发目标请求**。运行一次时由调用者传入已经确认的目标公众号名称：

```powershell
node scripts/research/probe-mobile-public-article-search.cjs --account-name '已确认的目标号名'
```

脚本只向腾讯旗下搜狗域名发**一次** `GET /weixinwap?type=2&query=...`，不做首页预热、重试、翻页、重定向、`/link` 解析或原文请求。请求前在用户主目录 `.wewe-rss-private/mobile-public-search/` 以目标名哈希建立独占持久哨兵；相同名称再次运行会在请求前拒绝。保存不超过 128 KiB 的私有 HTML 前缀和脱敏结构摘要（HTTP 状态、跳转主机与无查询参数的路径、卡片标记计数、截断标志），控制台不输出查询词、文章链接或原文。若遇 302/验证码，只记录并停止；首屏返回后应先离线审查是否真的有文章卡片、号名、分页线索、稳定时间与官方原文 URL，再决定是否值得后续独立验证。此探针的直接裸 GET 可能与源码先访问公开首页后的 Cookie 状态不同，首屏失败仅排除**这次匿名单请求条件**。
