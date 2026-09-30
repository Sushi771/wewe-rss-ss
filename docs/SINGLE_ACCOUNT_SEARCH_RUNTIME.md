# 单号搜索与原文缓存接口说明

唯一当前运行交接见 [DEVELOPMENT_HANDOFF.md](DEVELOPMENT_HANDOFF.md)。本文记录解析和持久化边界，不另列当前“下一步”。

正常更新采用号名搜索候选 → 独立后台原文请求与身份核验 → 现有 ProviderPage / 图片归档 → CollectionService 保存。`getreviewid` 不是前置依赖。搜索 `indexTimestamp` 不映射成 `publishTime`；只有已审原文字段提供可信时间。身份、签名、标题、原文时间冲突必须停止，搜索来源不使用合集的 60 秒容差。

## 正常 Web 会话和后台请求

本人正常登录的项目专用官方页面可以导出认证 Cookie 到 Git 忽略的私有配置，再关闭页面/CDP。只保存 `wr_pf/wr_ql/wr_rt/wr_skey/wr_vid`，不读取其他浏览器配置、storage、HAR、临时签名或票据。`save-owner-web-session.cjs <私有目录绝对路径>` 仅移交已确认的本项目正常授权，账号必须匹配生产旧账号。会话文件及请求状态不可提交、不可放进公开静态目录。

后端 `fetchOwnerSearchPage` 从明确配置文件恢复会话，仅向固定腾讯 HTTPS 搜索端点发送请求。没有浏览器、导航、滚动、自动登录/init/续期或重试。有效期不足、认证拒绝、验证码、频控立即停止；错误只返回受控类别，不日志输出 Axios 请求头。停止按实际正常会话记录保留，新的正常登录不会删除旧证据。成功的探针不永久冻结更新，正常更新至少冷却 15 分钟。跨进程锁与发送前持久预留防止重复请求；中断时不得自动删锁、清停机标记或重放。

每次更新从搜索首屏开始，最多两页。只使用本次响应的实际分页字段，游标不跨更新周期保存。`search-results` 覆盖不保证完整；请求预算停止记录截断，旧日期、已有文章或一页无近期项不是完整性证明。“本轮未发现”不等于公众号没有更新。

## 离线原文衔接与副本演练

`searchArticleCandidates` 只读独立搜索返回项及号配置，缓存不参与候选生成。`verifyCandidateOriginal` 核真实原文来源、请求链接/短 canonical、SHA-256、公众号与文章身份、签名、标题及原文时间。`prepareSearchReplay` 在候选生成后按稳定身份读取缓存，逐张核图片响应来源与字节哈希，再复用现有归档组件；缺原文的候选仍未核验。缓存命中不是本轮联网正文请求，也不证明未缓存文章可读。

`node scripts/research/replay-owner-search-cache.cjs` 读取本轮持久的两页26条返回项，按采集时刻前七天和索引时间降序选5篇；新建一致性 SQLite 副本，调用 `CollectionService.replayVerifiedSearch` 保存核验文章，并在新进程排重。方法仅允许带明确副本标记的 SQLite，不改生产来源绑定或最后成功时间。旧 ID、非空正文/图片、可信时间、封面、有效零值与 null 指标受保护。RSS/Markdown/Obsidian/ZIP 在进一步缩小的导出副本验证，旧生产和保存副本逐列比较。所有输出、备份及原始证据仅在 `private-data/`。

截至本轮实施，两篇漏文可从真实缓存在副本保存、排重与导出；另3篇缺原文。原文匿名网络路线仍受以前腾讯验证响应的有效停止记录约束。正常微信读书 Web 会话只适用于其搜索端点，不替代 `mp.weixin.qq.com` 原文授权。

`start-selected-original-verification.cjs` 复用独立候选和缓存核验，排除已验缓存后才选近期未验原文。它已实际打开一次官方页面，本人确认正常显示；随后独立后台同 URL 的唯一请求302至腾讯验证，已停。入口不清除停止记录、不捕获临时签名，也不能重复启动已记录的验证。浏览器DOM、真实后台响应、缓存命中分别记录，不互相充当证据。

## 原更新入口修复（2026-09-30 晚）

本轮用户要求优先修复实际4000入口，不再以五篇独立验收、导出验收或等待自然新文为前置条件。原按钮 `feed.refreshArticles` 与定时入口统一调用 `TrpcService.refreshMpArticlesAndUpdateFeed`，持久 `collectionChannel=owner-web-search` 路由至 `collectOwnerSearch`。`replayVerifiedSearch` 仍仅供离线副本保护测试，正常更新不读它或原文缓存；4120试用限制没有被移除。

`OWNER_SEARCH_CONFIG_FILE` 指向公开静态目录之外的绝对私有JSON路径，结构为 `feeds[mpId]`，字段为 `mpId/name/biz/ownerVid/sessionFile/stateFile/originalStopFiles/runtimeStopFile`；后四者是绝对路径，前三种会话/状态/历史停止材料复用已有文件，不复制凭据到仓库。原文停止记录优先于搜索：已有验证或认证拒绝时，不发送搜索或原文请求。正常搜索保留15分钟冷却，最多两页；正文最多20条搜索候选，相邻请求至少1秒，每个请求不跟跳转、不重试、不转发微信读书Cookie。搜索原始 `doc_url` 保存为 `requestUrl`，规范链接仅用于身份与排重。正文取不到时不把索引时间当发布时间，也不制造标题行或回放旧缓存。

正常读取成功后复用原保存事务，保护旧ID、已信任时间、非空正文、封面和指标；正文和图片全部有效才提交本批，完成后才推进同步时间。旧合集绑定保留在 `publicAlbumIds`，不会自动回退到固定合集。平台停止会返回 `blocked`，由原页面的最近操作和错误提示显示；无法取得正文不能称作恢复。本人正常微信读书登录仅适用于该域名搜索；目前没有公众号原文可用的正常后台认证材料，已有302停止仍有效。后续请求必须有明确的新正常条件，不能删除历史停止证据或复制浏览器临时令牌绕过。

## 核验命令

```powershell
pnpm --filter server test -- --runInBand collection
pnpm --filter server build
node scripts/research/replay-owner-search-cache.cjs
node scripts/research/start-selected-original-verification.cjs --plan
pwsh -NoProfile -File scripts/research/weread-login-window.ps1 -Action SelfTest
```

真实后台会话验证命令 `check-owner-backend-search.cjs <私有目录绝对路径>` 会发请求，须先检查会话、已有冷却和停止状态；它不使用缓存制造响应、不替代本轮26条发现材料，也不写生产库。
