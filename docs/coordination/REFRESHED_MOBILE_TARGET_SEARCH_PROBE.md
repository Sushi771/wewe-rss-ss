# 新移动凭据：目标准确号名首屏搜索

2026-09-30。总控按[新 token Web 书架健康对照](REFRESHED_MOBILE_WEB_HEALTH_PROBE.md)做过**一次**线上运行：init HTTP 200、五个 Web Cookie、`wr_vid` 与恢复 `vid` 一致；同一隔离上下文的 Web shelf HTTP 200，存在 `books/synckey`，`decision=web_shelf_accepted`。随后本探针对目标准确号名做一次隔离首屏搜索，结果见下文。生产 SQLite 始终只读。

## 一手请求形状

腾讯公开搜索页 [`read_search.fc739bbf.js`](https://search.wxqcloud.qq.com/t/searchweb/search/weixin-search-outlinks/26090701/js/read_search.fc739bbf.js)（68,998 字节；SHA-256 `E5E090EE6B6180DE2ED72EE3EEEBDCDAB9A10C5C0F5C95F442FD7940730F7089`）字符偏移约 65,300–65,600：PC `_get` 通过 axios 向 `https://weread.qq.com/web/wx_search_broker_proxy` 发 `POST`，`withCredentials:true`，对象字段 `query/offset/searchid/searchcookies`。同一组件 `data()`（约偏移 64,400–65,100）初始 `offset:0`、`searchcookies:""`；初次响应的 `content.searchID` 才赋值给 `this.searchID`。因此首屏序列化 JSON 是 `{query:"妈妈部落畅聊阁",offset:0,searchcookies:""}`；`searchid:undefined` 被 JSON 序列化省略，不能猜成空串。请求一次，不以首屏响应游标继续请求。

该 HTML 可从腾讯公开 `https://search.weixin.qq.com/cgi-bin/newsearchweb/userclientjump?path=page/search/weread&platform=pc` 无目标查询访问，2026-09-30 返回 HTTP 200。脚本的请求由无页面的 `BrowserContext.request` 发出，显式 `Origin:https://search.weixin.qq.com`，**不是实际页面 XHR**；公开 JS 没有自定义 Origin、Referer 或 CSRF 头。脚本不猜 Referer/CSRF，也不打开页面。这与曾失败的旧 token Node 直连不同：token 已正常 Refresh，完整 Context Cookie jar 的 Web shelf 已成功；但搜索代理是否接受这种请求上下文仍须一次实测。

响应字段依据同 bundle `handleApiRes`（约 65,980–66,880）：`content.data[].items[]`、`offset/searchID/cookies/continueFlag`；卡片 `source.title/source.dateTime` 与 `docID/doc_url/timestamp` 是待核候选字段。固定[开源接口记录](https://github.com/dailyoozoo/weread-mp-fetch/blob/2b4fd61d921b029075ecad3963a8fbc9568d0fc0/docs/INTERFACE.md#L31-L77)显示有效 `content.data` 可同时有外层 `ret=-1`，探针允许这一形状；`-2010`、`-2012` 均停止并按未确认业务语义记录。`continueFlag` 仅输出布尔，不使用响应的 `searchID/cookies/offset`。目标稳定 `__biz=Mzg5NTQzMTQxMg==` 只用于**本地比较**；号名匹配不能代替原文 `biz` 核号，`source.dateTime` 不能直接当可信发表时间。

## 只读门禁与输出

脚本：[probe-refreshed-mobile-target-search.cjs](../../scripts/research/probe-refreshed-mobile-target-search.cjs)。`--plan` / `--self-test` 不读生产库、不启动真实浏览器或联网。在线模式必须同时传绝对生产 SQLite 路径、本次 Refresh 的私有运行目录、固定 `playwright-core@1.58.2` 和本机 Edge/Chrome 路径，以及 `--approved-online`。拒绝代理、TLS/调试开关；生产库、预检原备份、副本均以 `readOnly + query_only` 打开，核恰一账号、完整性、原始账号 ID/旧 token/订阅和文章计数一致。只接受私有恢复记录 `candidate_identity_matched`、HTTP 200、显式同 `vid`、新 accessToken，以及同次 Refresh marker；要求先前 Web 健康 marker 的结构正确。**健康 marker 仅证明做过对照，不单独保存 `web_shelf_accepted` 决策**；本次运行还需总控核对上一轮脱敏成功输出。独立搜索 marker 在浏览器启动前以 `wx + fsync` 创建；已存在则零请求。

隔离非持久 BrowserContext 起始 Cookie jar 必须为空。用私有恢复文件中的**新 accessToken**和该记录中的同设备 refreshToken 做最多一次固定 Web init；HTTP 200、无验证码/限流/错误码，响应若有 `success` 必须为 1，并要求搜索路径适用的唯一 `wr_vid` 匹配恢复 vid、唯一非空 `wr_skey`。然后最多一次首屏 POST：不请求 Web shelf、分页或原文，不导航、不保存 Cookie/storageState/HAR/trace，不写生产库。`maxRedirects:0/maxRetries:0`，init 10 秒，搜索 20 秒；JSON 解析上限 64 KiB / 512 KiB。Playwright 的 `APIResponse.body()` 先缓存网络响应，因此这是**解析上限，不是传输硬上限**。验证码、限流、HTTP 错误、不可判读结构或业务码均停止，不重试。

输出限于 HTTP/数值业务码、已知 Web Cookie **名称和数量**、`wr_vid` 匹配布尔、桶数/条目数、目标来源名匹配数、明确目标 `biz` 匹配数、双重匹配数、最多 30 个匹配项的文章键 SHA-256 前 16 位及时间字段存在性、续页布尔与停止类别。不输出标题、原始文章 URL、cursor、Cookie/token、原始响应或账号 ID。摘要不可用于完整文章验收；若首屏有目标文章，下一轮仍须在独立门禁内核对稳定身份、原文时间、正文和图片。

```powershell
node scripts/research/probe-refreshed-mobile-target-search.cjs --plan
node scripts/research/probe-refreshed-mobile-target-search.cjs --self-test
# 以下占位路径不可直接运行；本次私有目录已有搜索 marker，禁止同形重发。
node scripts/research/probe-refreshed-mobile-target-search.cjs --execute --db <ABSOLUTE_DB_PATH> --run-dir <ABSOLUTE_REFRESH_RUN_DIRECTORY> --playwright-core <ABSOLUTE_PLAYWRIGHT_CORE_DIR> --browser <ABSOLUTE_EDGE_OR_CHROME_EXE> --approved-online
```

离线 `node --check`、`--plan`、`--self-test` 已通过：假 SQLite/私有恢复与健康 marker 测账号门禁；假 Context 测新 accessToken、首屏请求体、完整 jar、目标 `biz`、键摘要及脱敏；验证码、Cookie 身份不符和 `-2012` 最多分别发一次 init 或一次 init 加一次搜索，缺 `content.data` 停止。线上请求 0、生产库读写 0。

## 2026-09-30 总控唯一首屏结果

新隔离 Web init 与目标搜索各一次，均 HTTP 200；完整五 Cookie 的 `wr_vid` 与恢复账号匹配。搜索顶层 `ret=-1`、`content.ret=0`，返回 `content.data` **15 桶/15 条**；其中 **11 条** `source.title` 精确匹配目标准确号名，11 条都有 `docID`、`doc_url`、`timestamp` 和 `source.dateTime` 字段，文章键摘要各不相同。显式 `doc_url.__biz` 与目标 `biz` 匹配数为 **0**，所以本轮没有把这 11 条当作目标号已核验文章。响应含 `offset/searchID/cookies/continueFlag`，`continueFlag=true`；本次没有使用它们续页。总请求 **2**，分页、原文、页面导航与生产库写入均 **0**；私有搜索 marker 保留，未输出原始 URL、标题、游标、Cookie 或 token。

这个结果证明**当前本人会话的腾讯官方搜索首屏确实返回目标准确来源名卡片**，与旧凭据 `-2012` 的失败有实质差异。索引时间不是已核发表时间，来源名也不能替代 `biz`；下一轮分别核一次官方游标续页是否真新增，以及某条官方原文链接的账号身份、原文 `ct`、正文和图片。首屏 11 条不是五篇真实文章验收，更不是全号订阅恢复。
