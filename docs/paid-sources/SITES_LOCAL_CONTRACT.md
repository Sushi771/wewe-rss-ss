# Sites 客户端与本机窄接缝：仅本地准备

2026-10-09 · 元数据合同基线 `68a692b`，缓存与受限刷新增量基线 `e428983a`

实现为 [`sites-local-contract.mjs`](../../scripts/sites-local-contract.mjs)，无第三方依赖，仅使用 ESM 与 Web Request/Response/fetch 接口；默认导出符合 Worker `fetch(request)` 形状。当前未注册 Site、未发布、未配置身份或连接，也未在 Nest/App 路由挂载任何接口。不是已连通网关或手机可用成品。

本轮补齐可提前完成的缓存读取、当前设备离线下载，以及单作者显式刷新/进程内回执合同。未建立任务队列、同步框架、持久连接、云端副本、D1/R2 或新的认证协议；默认运行仍拒绝真实访问。

## 三层接缝与默认拒绝

| 层           | 已准备的入口                                                                                                       | 当前边界                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 浏览器       | `createSitesClient(fetchImpl)`                                                                                     | 只 POST 同源 `/api/subscriptions`，使用同源会话，不接后端地址或秘密；不请求 loopback、不跟随重定向、不重试                                                       |
| Sites Worker | `createSitesWorker({ authorize, transport })`                                                                      | 缺身份适配器返回 `IDENTITY_UNCONFIGURED`；匿名返回 401，非 owner 返回 403。连接未配置/电脑离线返回 `PC_UNAVAILABLE`；单次连接 5 秒截止，传递 AbortSignal，无重试 |
| 本机合同     | `createLocalSitesGateway({ authorize, caller, projectWechatCachedBody, refreshAccess }).execute(command, context)` | 仅进程内方法，没有监听器。须独立核本机连接的权限；使用已有授权的 appRouter caller，不创建管理员会话或伪造 `isLocal`                                              |

两个 `authorize` 都是服务端适配接缝，返回的 `{ isOwner: true }` 必须来自未来已验证的权限判断。该对象不是线上认证凭据，不能来自 JSON、浏览器 header 或“请求由 loopback 转发”的推断。测试中的 owner 判定仅为合成注入，不能启用真实访问。

已读取 Sites 技能的 Identity and Secrets 参考：托管 dispatch 提供 visitor identity；站点内用户 ID 与其他站点不同，身份不等于 workspace/owner 权限。服务访问 bearer 也不提供 visitor identity。真实托管来源、owner 对照和本机身份传递合同尚未核实，本轮不读取 `oai-authenticated-user-id` 来放行，不生成 bearer、cookie 或签名协议，不添加环境变量开关。

未来 Worker 打包必须使用 Sites 支持的 Worker ESM 工作流；本模块不是 hosting manifest 或可直接发布的源包。本机 Nest/Prisma SQLite 仍留在 Windows，Worker 不能直接运行它们或访问这台电脑的磁盘。

## 最小允许操作

| 命令         | 输入                                                                         | 复用的已有受保护路由                                         | 返回                                                                    |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `capability` | `platform: wechat / xiaohongshu`；微信可显式传 `source: native / wechat2rss` | `feed.addCapability` / `xiaohongshu.capability`              | 配置状态；微信当前选择。`canRefresh` 固定 false，不代表跨端刷新可用     |
| `authors`    | platform、limit（默认 20，最大 50）；仅微信可传 cursor                       | `feed.list` / `xiaohongshu.list`                             | 内部 ID、显示名称；微信沿用数据库游标                                   |
| `items`      | platform、authorId、limit；仅微信可传 cursor                                 | `article.list({mpId})` / `xiaohongshu.notes({creatorId})`    | 该作者的内部 ID、标题、原可信发表时间                                   |
| `body`       | platform、authorId、itemId                                                   | `article.byId`＋原缓存校验/解析；`xiaohongshu.body`          | 缓存纯文本、标题、可信发表时间、按序 data URI 图片；无回源              |
| `download`   | 同 body                                                                      | 同 body，不调用可能回源的公众号导出接口                      | 相同有界缓存投影；`sitesDownloadBlob` 生成当前浏览器设备的单篇离线 HTML |
| `refresh`    | platform、authorId、operationId、`confirmed:true`；微信必须指定 source       | `feed.refreshArticles({mpId})` / `xiaohongshu.refresh({id})` | 经服务端独立门禁后单作者执行；固定状态和代码，不透传上游错误            |
| `status`     | platform、authorId、operationId                                              | 当前合同进程内已有回执，不调用刷新                           | running/complete/partial/pending/blocked/failed/unknown，查询不提交任务 |

微信来源省略时继续由原服务决定默认；明确选择原样传递，响应来源不符拒绝，不自动回退。配置通过仅表示原本地能力检查通过；此合同不验证账号、套餐、余额或真实 upstream。

已有缓存元数据可在来源未配置时查询，不触发采购来源、正文重试或图片下载。小红书原 notes 路由按 creatorId 查库，但其输出未带 creatorId；适配复用此路由作用域。真实供应商 author/note schema 不在这里猜测。小红书原 list/notes 尚无分页合同，响应只截取指定上限并标 `truncated`；不能称全量，也不编造 cursor。小红书原服务仍会读取整个作者/笔记列表，此模块只限制传输结果，没有宣称改善本机大库查询。

元数据只构造上述字段，不透传账号、token、外部作者 ID、profileUrl、原错误消息、HTML、供应商 URL、本机目录或完整路由对象。body/download 的图片仅允许缓存 data URI，通过 MIME、canonical Base64、容器及大小门禁；不允许远端 URL、SVG 或任意文件。与原校验器一样，容器检查不代表完整像素解码。电脑离线且尚无云端副本时不可读取本机内容；不得伪造空列表表示读取成功。

命令严格拒绝额外字段；单请求流式读取最多 4096 字节，单页最多 50 条，字符串有界。仅接受同源 Origin 与 JSON POST。仍拒绝注册、删除、正文重试、任意路径/文件、设置、账号管理、shell、任意 tRPC 方法和批量刷新透传。没有挂载生产或 Sites 路由。

## 缓存读取与浏览器下载

微信先按原 `article.byId` 检查文章 ID、公众号归属、已存 HTML 和 unavailable 状态。`projectWechatCachedBody` 未绑定则返回 `CACHE_ADAPTER_UNCONFIGURED`；已提供 `createWechatCacheProjector({verifiedDownloadBody, load})`，未来本机绑定原 `article-verified-download.ts` 的 `verifiedDownloadBody` 和现有 Cheerio load 即可，先完整验证再解析纯文本/换行和缓存图序。该函数只接缓存 HTML，不接 URL、路径、caller 或图片 fetcher，不调用旧 exportMarkdown/retryBody。

小红书复用原按 creatorId/noteId/status 查询并校验图片的 body 路由。两平台都整篇拒绝缺失、假图、稀疏媒体、超量或越界内容，不截断、不自动补抓。当前传输上限为文字 UTF-8 250KB、每图 1MB、图片合计 4MB、最多 60 图；比本机归档限制更小，超限可继续使用原本机保存器。

`sitesDownloadBlob` 从投影生成真实 `text/html` Blob 和固定文件名 `缓存图文.html`：文本转义、图片内嵌、带禁网络/脚本的 CSP，可断网打开；文字段落和图序保留，不承诺原 HTML 的精确排版/图文交错位置。没有隐藏自动下载行为，未来页面须由用户点击后保存 Blob 到浏览器所在设备。此合同采用单篇离线 HTML，不透传原公众号可能回源的 ZIP/Markdown 路径；原本机 ZIP 和 `正文.md + image/` 保持。手机不假装写 Windows vault。

## 单作者手动刷新与状态

新增操作是内部应用合同，不是认证协议或供应商 schema。未绑定 `refreshAccess` 时仅返回 blocked/REFRESH_UNCONFIGURED。该服务端接缝在已有身份授权之外，核实际 sourceAvailable、accountAvailable、manualAccessConfirmed 和 budgetApproved；明确来源/账号不可用分别给固定代码，条件未知返回 POLICY_UNCONFIRMED。浏览器不能提交这些布尔值、预算批准或账号凭据。当前不执行真实账号检查，不配置来源或批准预算。

微信先核原明确来源能力和 `feed.byId.collectionRoute` 的已存绑定。只允许已绑定 Wechat2RSS 的单号原刷新；native 的新增能力不能推成已获 native 刷新授权，不能重绑或解除旧停止。小红书先核注册来源和已启用博主。service 仍保留自己的权限、备份、冷却和进行中锁；此合同不伪造 caller 的本机权限。

同平台/作者在途互斥；同 operationId 只返回已有回执，不能改作者或来源。成功、阻塞、失败、不确定回执均不重放；存储最多 128 个操作，容量满拒绝新操作，不清掉未知回执来腾位。仅进程生命周期有效，没有持久 job、定时重试或跨重启至多一次保证；进程丢失时不能由此合同宣称可恢复。

回执保留 complete/partial/pending/blocked/failed 的区别；complete 只表示来源窗口处理完成，不承诺全历史或供应商完整覆盖。微信 accepted/pending 不冒充新文取得。服务抛错或回执不符合已知合同后，可能已提交的操作标 unknown/RESULT_UNKNOWN；Worker 的刷新连接超时也返回 RESULT_UNKNOWN，之后只能查原 operationId，不自动重试。显式新操作仍须重新通过门禁，不表示上次未扣费。

未来文件夹分组只属于本地作者展示；当前不新增未经 owner 确定的分组字段，也不把组名、上游 ID 或分组变更放进刷新操作身份。待正式字段确定后最小对齐。

## 离线验证与后续门槛

运行：

```powershell
node --test scripts/sites-local-contract.test.mjs
```

测试全局禁止真实 fetch，使用合成 appRouter 形状与服务端身份适配器，执行实际客户端、Worker fetch 和本机合同方法。覆盖默认拒绝、伪造身份 header、匿名/非 owner、电脑离线、源未配置、原默认/明确来源、不匹配来源拒绝、受限读操作、字段脱敏、作用域、截断、同源/大小限制、超时和不重试。未启动服务、读生产配置或迁移数据库；不等于真实 appRouter 集成、Sites 身份或跨设备验收。

原19项元数据回归已纳入主 CI；整合审查曾以编译的真实 appRouter、原服务及合成 Prisma SQLite 核五种查询及原权限拒绝。当前增量测试仅使用合成 caller，另覆盖实际 PNG 字节、纯文本、离线 Blob、恶意文本转义、缓存归属、媒体/体积拒绝、服务端解析接缝、来源/账号/批准缺失、单作者防重入、操作去重与状态查询、pending/失败/不确定及刷新超时。未启用真实刷新、数据库或供应商，也未将此次增量标为真实 appRouter/Sites/浏览器跨端验收。

后续只有真实身份及连接合同核实后才绑定上述接缝：

1. 确认目标 Site 的私有 audience、dispatch header 来源及 server-side owner 权限；确认连接服务访问与 visitor 权限分别如何核验。
2. 确认本机主动连接或经授权的窄 HTTPS 网关的可用方式、凭据保管、失效与防冒充；保持主应用管理面和本机保存接口不对外暴露。
3. 在隔离测试中绑定真实受保护 caller，复验匿名、非 owner、电脑离线，以及微信旧身份/小红书 creator 作用域。随后再做手机和另一电脑的元数据验收。
4. 缓存读取/下载和手动操作的离线投影已准备，真实跨端仍需确认受保护实时连接或另获授权的私人云端副本；真实收费刷新还需账号、显式操作和实际预算门禁。未绑定的接缝保持拒绝，不能把合成执行或生成 Blob 写成手机已下载真实图文。

本轮没有发布、隧道、公网监听、来源授权、真实平台请求或生产迁移。代码及此非私人说明交由唯一 owner 整合后上传 GitHub；独立 worker 不 push。
