# 搜索结果 URL 与目标身份：结构诊断

2026-09-30。本轮只做公开源码/响应研究和离线实现；**未再向腾讯发目标准确号名请求，未请求任何原文**。总控先前唯一游标对照取得首屏 11、次页 15 个 `source.title` 精确匹配，二页候选键无交集、次页新增 15，游标推进；这些是**索引卡片**，没有 26 篇目标原文身份或 `ct` 证据。[游标探针记录](REFRESHED_MOBILE_SEARCH_CURSOR_PROBE.md#2026-09-30-总控唯一在线续页结果与分类修正边界)已补入实测范围。

## `malformed` 混合桶的明确问题

旧[游标探针](../../scripts/research/probe-refreshed-mobile-search-cursor.cjs)的 `linkShape` 先 `new URL(doc_url)`，任何非 `https:` 协议都返回 `malformed`；相对 URL 也因未传 base 而落同一桶。[首屏探针](../../scripts/research/probe-refreshed-mobile-target-search.cjs)的 `targetBiz` 同样只认 `https://mp.weixin.qq.com`。所以这次 30/30 `malformed`、显式 biz 0 **只描述旧分类器输出**，不能推断 URL 坏、都不是腾讯原文或 biz 不匹配；先前响应没有保存原始 URL，无法事后恢复其真实协议/路径。

腾讯公开搜索页固定 [`read_search.fc739bbf.js`](https://search.wxqcloud.qq.com/t/searchweb/search/weixin-search-outlinks/26090701/js/read_search.fc739bbf.js)（SHA-256 `E5E090EE6B6180DE2ED72EE3EEEBDCDAB9A10C5C0F5C95F442FD7940730F7089`）约字符偏移 47,600–48,900：`doc_url.includes("mp.weixin.qq.com")` 切换为公众号项；PC `window.open(item.doc_url, "_blank")`，其他 H5 项可用 `jumpInfo.jumpUrl || doc_url`。该客户端**没有要求 HTTPS 或把 URL 规范化**，也不保证它一定有效。独立[公开搜一搜响应样例](https://apifox.com/apidoc/shared-410674f9-f451-4b4f-957a-5f54f243bc83/api-264402406)在 `items[].doc_url` 给出 `http://mp.weixin.qq.com/s?__biz=...&mid=...&idx=...`，并带 `bizUin/srcUserName/timestamp/source.dateTime`；这是别的公开样例，**不是本账号这 30 条，也不证明本端点当前都用 HTTP**。它仅说明“HTTP 微信原文链接”是需要单列的真实可能形状。

## 下一次只诊断结构

新增 [probe-search-url-identity.cjs](../../scripts/research/probe-search-url-identity.cjs)只在总控复审后可显式 `--execute`。它从同一私有 Refresh 恢复文件提新 token；生产 SQLite/备份/副本只读核账号 ID、原 token、vid 和计数；要求已有健康与首屏尝试 marker 格式正确，另以 `wx + fsync` 先写本次 marker。新的隔离 BrowserContext 最多一次固定 Web init 和**一次首屏搜索**，无游标续页、原文 GET、页面导航或 Cookie/结果落盘。已有首屏重发只能回答旧探针未观察的 URL 结构，**不是新增文章取回，也不得高频重复**。遇验证码、限流、HTTP/业务错误即停。与先前一样禁代理、调试、跳转、重试，init 10 秒、搜索 20 秒、JSON 解析上限 64/512 KiB；Playwright 响应缓存意味着并非硬网络截断。最多解析 100 个条目，超限整体停止，不截断后假装样本完整。

只在内存中分类每条 `doc_url`：原始绝对 HTTPS/HTTP、协议相对、相对路径、整 URL 百分号编码、HTML `&amp;`、保留的反斜杠斜线、其他协议、真正解析失败、过长、缺失/非字符串；分别统计 scheme、`mp.weixin.qq.com`/搜索页/其他 host、`/s/<token>` 短形或 `/s?...` 查询形，并单列带 URL 用户信息或非默认端口的异常 authority。HTML/百分号/斜线最多做一次**诊断性**解码并保留转义标记，不发请求、也不把解码后的地址当真实官方原文。对腾讯域且 authority 正常的查询形仅本地检查 `__biz/mid/idx` 是否存在、`mid/idx` 是否数字、`__biz` 是否等于已核目标 biz；若索引还给 `bizUin`，可与已知目标数字 ID 作另一布尔对照。`bizUin` 及 URL 参数仍是**搜索索引的主张**，不是原文证明。

从号名精确匹配项中最多择一候选：优先 URL `__biz` 与 `bizUin` 都匹配目标，其次单一字段匹配，再次可解析腾讯域链接，最后第一个号名匹配项。只输出所选条目的 `docID/doc_url` 派生短哈希、结构分类、字段存在/匹配布尔、时间字段存在布尔及 `originalBizAndCtVerified:false`。不输出标题、原始链接、目标 biz、mid/idx、索引时间、Cookie/token、游标或原始响应。没有至少一个原文 URL 声称的目标 `__biz`（或独立 `bizUin` 对照）时，名称匹配仍不能核号；即便两项都匹配，后续仍要**另设单篇原文 GET**，仅从严格允许的 `mp.weixin.qq.com` 原存链接把 HTTP 协议离线改为 HTTPS，核原文 `__biz/ct`。本脚本不做这个 GET，也不发送明文 HTTP。

```powershell
node scripts/research/probe-search-url-identity.cjs --plan
node scripts/research/probe-search-url-identity.cjs --self-test
# 总控复审后才可使用私有路径执行；本线没有执行。
node scripts/research/probe-search-url-identity.cjs --execute --db <ABSOLUTE_DB_PATH> --run-dir <ABSOLUTE_REFRESH_RUN_DIRECTORY> --playwright-core <ABSOLUTE_PLAYWRIGHT_CORE_DIR> --browser <ABSOLUTE_EDGE_OR_CHROME_EXE> --approved-online
```

离线 `node --check`、`--plan`、`--self-test` 已通过。自测分别覆盖 HTTP 腾讯长链、HTML 转义、整 URL 百分号编码、残留斜线转义、协议相对、相对路径、危险协议、文本错误，以及假 SQLite/私有恢复/marker 和假网络的两请求门禁。真实网络 0、生产库读写 0。
