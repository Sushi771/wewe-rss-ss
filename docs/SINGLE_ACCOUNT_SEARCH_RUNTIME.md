# 单号搜索与原文缓存实施入口

当前工程采用号名搜索候选 → 独立原文核验 → 现有 ProviderPage / 图片归档 → CollectionService 保存与导出。`getreviewid` 不是前置依赖。搜索 `indexTimestamp` 不映射成 `publishTime`；只有已审原文字段提供可信时间。身份、签名、标题、原文时间冲突必须停止，搜索来源不使用合集的 60 秒容差。

## 正常 Web 会话和后台请求

本人正常登录的项目专用官方页面可以导出认证 Cookie 到 Git 忽略的私有配置，再关闭页面/CDP。只保存 `wr_pf/wr_ql/wr_rt/wr_skey/wr_vid`，不读取其他浏览器配置、storage、HAR、临时签名或票据。`save-owner-web-session.cjs <私有目录绝对路径>` 仅移交已确认的本项目正常授权，账号必须匹配生产旧账号。会话文件及请求状态不可提交、不可放进公开静态目录。

后端 `fetchOwnerSearchPage` 从明确配置文件恢复会话，仅向固定腾讯 HTTPS 搜索端点发送请求。没有浏览器、导航、滚动、自动登录/init/续期或重试。有效期不足、认证拒绝、验证码、频控立即停止；错误只返回受控类别，不日志输出 Axios 请求头。停止按实际正常会话记录保留，新的正常登录不会删除旧证据。成功的探针不永久冻结更新，正常更新至少冷却 15 分钟。跨进程锁与发送前持久预留防止重复请求；中断时不得自动删锁、清停机标记或重放。

每次更新从搜索首屏开始，最多两页。只使用本次响应的实际分页字段，游标不跨更新周期保存。`search-results` 覆盖不保证完整；请求预算停止记录截断，旧日期、已有文章或一页无近期项不是完整性证明。“本轮未发现”不等于公众号没有更新。

## 离线原文衔接与副本演练

`searchArticleCandidates` 只读独立搜索返回项及号配置，缓存不参与候选生成。`verifyCandidateOriginal` 核真实原文来源、请求链接/短 canonical、SHA-256、公众号与文章身份、签名、标题及原文时间。`prepareSearchReplay` 在候选生成后按稳定身份读取缓存，逐张核图片响应来源与字节哈希，再复用现有归档组件；缺原文的候选仍未核验。缓存命中不是本轮联网正文请求，也不证明未缓存文章可读。

`node scripts/research/replay-owner-search-cache.cjs` 读取本轮持久的两页26条返回项，按采集时刻前七天和索引时间降序选5篇；新建一致性 SQLite 副本，调用 `CollectionService.replayVerifiedSearch` 保存核验文章，并在新进程排重。方法仅允许带明确副本标记的 SQLite，不改生产来源绑定或最后成功时间。旧 ID、非空正文/图片、可信时间、封面、有效零值与 null 指标受保护。RSS/Markdown/Obsidian/ZIP 在进一步缩小的导出副本验证，旧生产和保存副本逐列比较。所有输出、备份及原始证据仅在 `private-data/`。

截至本轮实施，两篇漏文可从真实缓存在副本保存、排重与导出；另3篇缺原文。原文匿名网络路线仍受以前腾讯验证响应的有效停止记录约束。正常微信读书 Web 会话只适用于其搜索端点，不替代 `mp.weixin.qq.com` 原文授权。

恢复原文路线的正常入口已离线准备：本人执行 `node scripts/research/start-selected-original-verification.cjs --start`，在专用 Edge 对本轮最新自主发现文章完成官方验证；仍受限即停。此入口不清除停止记录、不后台取文、不捕获临时签名。官方页面正常打开后，需审查实际正常授权范围，才对同一自主发现且未缓存的文章做一次最小原文验证。不能换 URL、账号/IP 或命令绕过停止状态。

五篇原文身份/时间及正文链真实达标后，才允许接入现有单号正常更新、持久来源配置和受控生产切换。当前没有启用生产搜索来源；后台搜索成功与副本缓存回放均不能冒充页面更新恢复。后续还须验证正常入口写副本、服务重启、分页预算与自然新文。

## 核验命令

```powershell
pnpm --filter server test -- --runInBand collection
pnpm --filter server build
node scripts/research/replay-owner-search-cache.cjs
node scripts/research/start-selected-original-verification.cjs --plan
pwsh -NoProfile -File scripts/research/weread-login-window.ps1 -Action SelfTest
```

真实后台会话验证命令 `check-owner-backend-search.cjs <私有目录绝对路径>` 会发请求，须先检查会话、已有冷却和停止状态；它不使用缓存制造响应、不替代本轮26条发现材料，也不写生产库。
