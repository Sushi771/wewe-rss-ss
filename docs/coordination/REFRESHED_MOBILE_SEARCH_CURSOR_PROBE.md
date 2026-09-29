# 微信读书搜索：一次官方游标续页对照

2026-09-30。总控已经按[首屏探针](REFRESHED_MOBILE_TARGET_SEARCH_PROBE.md)做过**一次**目标准确号名搜索：隔离 Web init 与首屏 POST 各 1 次，均 HTTP 200；搜索外层 `ret=-1`、`content.ret=0`，`content.data` 共 15 条，11 条 `source.title` 精确等于目标号名；这些条目均有 `docID/doc_url/timestamp/source.dateTime`，但**显式目标 `__biz` 匹配为 0**。首屏 `continueFlag=true` 且 `offset/searchID/cookies` 字段存在；先前 marker 保留、生产写入 0。该结果支持继续问“官方游标是否真带来不同文章”，不证明 11 条均属于目标号或时间是发表时间。本文件准备下一次对照；**本线尚未在线执行**。

## 请求依据与严格门禁

腾讯公开搜索页 [`read_search.fc739bbf.js`](https://search.wxqcloud.qq.com/t/searchweb/search/weixin-search-outlinks/26090701/js/read_search.fc739bbf.js) 固定 SHA-256 `E5E090EE6B6180DE2ED72EE3EEEBDCDAB9A10C5C0F5C95F442FD7940730F7089`，字符偏移约 65,300–66,900：PC `_get` POST `https://weread.qq.com/web/wx_search_broker_proxy`，body 的小写键为 `query/offset/searchid/searchcookies`，`withCredentials:true`；`handleApiRes` 在数据存在时把 `content.offset/searchID/cookies/continueFlag` 写回状态，`onScrollEnd` 只在 `continueFlag` 真时用它们再调用 `_get`。这与旧开源实现把大写 `searchID` / `conversationID` 拼入请求不同。首屏仍按先前实测的 `{query,offset:0,searchcookies:""}`，未赋值的 `searchid` 序列化省略。续页**只**从本次首屏同一响应的 `content` 取实际 `offset/searchID/cookies`，以原类型、原值在内存中构造 `{query,offset,searchid,searchcookies}`；不从旧实验、数据库或猜测值补游标。

脚本：[probe-refreshed-mobile-search-cursor.cjs](../../scripts/research/probe-refreshed-mobile-search-cursor.cjs)。`--execute` 的生产 SQLite、私有 Refresh 恢复文件、账号 ID/vid、旧库与备份一致性校验沿用[新 token 书架健康门禁](REFRESHED_MOBILE_WEB_HEALTH_PROBE.md)；要求已有健康和目标首屏两枚**尝试** marker 结构正确，新增独立续页 marker 先以 `wx + fsync` 写入。此前 marker 只证明尝试，不单独证明成功；总控执行前须核对上述 `web_shelf_accepted` 与首屏脱敏输出。拒绝代理、TLS/调试环境，生产 SQLite/预检原件/演练副本均只读且 `query_only`。使用私有恢复文件中新移动 accessToken 和同设备 refreshToken，在新非持久 BrowserContext 中最多一次 Web init；init 无验证/限流/业务失败，唯一 `wr_vid` 与恢复 `vid` 相同且有 `wr_skey`，才发一次首屏。首屏无错误、可解析 `content.data[].items[]`、`continueFlag` 为 `true` 或 `1`、`offset` 为正且有界安全整数、`searchID/cookies` 显式存在并在大小/类型门禁内，且续页前 Cookie 身份再次匹配，才发**一次**续页。任何失败立即停止；不发第三页、不读文章、不跳转页面、不保存业务游标或原始 Cookie。

每个请求禁跳转/重试；init 10 秒，搜索每次 20 秒；首屏与续页各最多解析 512 KiB。Playwright 在 `.body()` 前缓存响应，因此这是解析上限，并非传输硬截断。`Origin:https://search.weixin.qq.com` 来自公开搜索页面；脚本没有页面导航或实际 XHR，也不猜 Referer/CSRF。最多 3 个业务请求：init 1、搜索 2；生产库写入 0。遇验证码、限流、HTTP 401/403/429、`-2010/-2012`、首屏游标缺失/非法或 Cookie 身份变化即停。次页游标有无推进只输出布尔，不请求第三页。

## 输出与判读

每页分别仅输出总条目数、精确 `source.title` 匹配数、显式目标 biz 匹配数、候选条目数、`timestamp/source.dateTime` 字段存在数、`continueFlag` 布尔，以及链接形状计数：`official_short` 为 `https://mp.weixin.qq.com/s/<token>`，`official_long` 为带 `__biz/mid/idx` 的 `/s?...`，另列 `official_query_partial/other`、其他微信路径/其他域名/无效/缺失。它们是**URL 结构分类**，不解析短链、不证明文章号身份。两页候选（来源名精确或明确 biz）按 `docID`，缺失时按 `doc_url`，在内存中求 SHA-256 前 16 位去重键；只输出交集数、新增数和最多 30 个键摘要、次页游标是否推进。若某条无键，列入 `keylessTargetCandidates`，不假定它是新文章。两页可能返回相同相关性结果；重复不自动代表真实末页，新增也不代表全史覆盖。

`timestamp` 与 `source.dateTime` 目前只是**搜索索引/展示字段**；原文 `ct` 未取、未核，不能作为可信发布时间，也不能用旧文章填新文章。若有新增，下一阶段仍需在独立门禁下核目标原文 biz、稳定 ID、ct、正文和图片，累积五篇不同真文章后才能考虑 Provider。

```powershell
node scripts/research/probe-refreshed-mobile-search-cursor.cjs --plan
node scripts/research/probe-refreshed-mobile-search-cursor.cjs --self-test
# 总控复审后才可使用私有路径执行；本线未执行。
node scripts/research/probe-refreshed-mobile-search-cursor.cjs --execute --db <ABSOLUTE_DB_PATH> --run-dir <ABSOLUTE_REFRESH_RUN_DIRECTORY> --playwright-core <ABSOLUTE_PLAYWRIGHT_CORE_DIR> --browser <ABSOLUTE_EDGE_OR_CHROME_EXE> --approved-online
```

`node --check`、`--plan`、`--self-test` 已通过。假 SQLite、私有恢复和两枚前序 marker 验账号来源；假网络验证一次首屏 + 一次原样游标续页、同页交集 1 和新增 1、短/长链计数以及无敏感输出；无 `continueFlag`、验证码、限流时按请求上限停止。离线自测的生产库读写和真实网络请求均为 0。

## 2026-09-30 总控唯一在线续页结果与分类修正边界

总控按本脚本做了唯一一次对照：隔离 init、首屏、续页各 1 次，三者 HTTP 200；首屏精确号名 11 条，续页精确号名 15 条，两页目标候选去重键交集 0、次页新增键 15，`offset` 前进；未请求第三页/原文，生产写入 0。**26 条只是搜索卡片来源名匹配，尚未经原文 `__biz/ct` 核号。**

本脚本的 `linkShape` 把所有非 `https:` URL 一律合并成 `malformed`，`targetBiz` 也仅接受 `https:`。本次 30 条 `doc_url` 全被归到该混合桶、显式 biz 匹配 0，**不能据此认定链接无效或目标 biz 不匹配**：正常 `http://mp.weixin.qq.com/s?...`、协议相对/相对 URL、转义 URL 和真正解析失败都没有被分别计数；脚本没有保存原始 URL，无法从这次摘要反推真实形状。腾讯公开页面 JS 只按 `doc_url.includes("mp.weixin.qq.com")` 选择公众号跳转，在 PC 直接 `window.open(doc_url)`，并未限定 HTTPS。下一次仅做重新分类和任选一候选的身份可核条件，见 [URL 身份诊断](SEARCH_RESULT_URL_IDENTITY_DIAGNOSTIC.md)；不把本轮原有混合统计修饰为新文章证据。
