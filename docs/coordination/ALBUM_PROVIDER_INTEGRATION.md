# 官方合集 Provider 接入（2026-09-30）

本单元把现有 `public-album` 接入 `SubscriptionProvider`，复用已有手动更新、定时任务、原文净化、图片归档和导出。范围始终是 **所选官方合集订阅**；`coverage=selected-albums`、`complete=false`、`hasHistory=-1`，即使一个合集分页读完也不表示公众号全部历史。

## 实现与保护

- `PublicAlbumProvider.fetchArticles` 从腾讯真实 `getalbum` 字段映射文章身份与所选合集页数。没有第三方中转、账号凭据或授权购买依赖；账户检查不会把未请求来源标为可用。
- canonical URL 与 `WX_<biz number>_<mid>_<idx>` 用于排重；原文请求保留真实官方 `chksm`。A 核实当前 19 项 URL 只含 `__biz/mid/idx/sn/chksm`，与此请求形状相同，其他凭据或跟踪参数不进入请求。
- 首次缺正文时，`fetchArticleBody` 严格核验 biz/mid/idx/sn、原标题、短 canonical 及原文 ct。未绑定可信时间的新规范 ID 最多容许列表 `create_time` 和原文 ct 相差 60 秒；已存发布时间保持不变。这个容差不能替代身份核验。
- 真实原文的 `var sn = "" || "hex" || ""` 由静态字面解析器读取，不执行 JavaScript；非空字面身份必须一致。已存真实 HTML 离线解析通过。
- 原文和图片请求都无自动重试、无重定向；原文拒绝/挑战/身份异常或任一图片失败立即终止后续请求，文章与合集绑定不写入。网络、正文与图片核验全部在事务之前完成。
- 旧 ID、发布时间、非空正文、来源、封面和指标保留，只补空字段。遇多个旧行指向同一身份时拒绝批次，不删除旧 ID。旧正文不重取；旧内联图片用容器核验检查可离线状态，损坏或远程图片使 `bodyCache.missing` 增加，正文仍保留。
- 正式入口先核验 SQLite 一致性备份；`lastCollectionResult` 持久保存 `pages/albums/created/updated/bodyFetch/bodyCache`。失败只保存脱敏操作状态，不改旧文章或绑定。

## 入口与结果

首次显式绑定：`TrpcService.collectPublicAlbums({ mpId, albumIds })`，保持已有服务器本机入口限制。

普通更新：`refreshMpArticlesAndUpdateFeed(mpId, 1, 'local-manual')`。定时任务通过相同入口传 `'scheduled'`，来源与合集 ID 从 SQLite 读取；重启不靠进程内配置。UI 按所选合集表达范围，新增 0 直接显示新增 0，不称全号完整恢复。

结果字段：`source=public-album`、`status=partial`、`coverage=selected-albums`、`complete=false`；`articles/created/updated/pages/albums` 是本次读取与写入计数。`bodyFetch.succeeded` 是本次新取得并本地归档的正文数，`bodyCache.retained` 是保留旧正文数，`bodyCache.available` 只计无远程图片且所有内联图片容器核验通过的正文。

## 验证与下一工程单元

服务端完整 Jest 19 套 / 171 项通过；追加 Provider 字段映射、签名请求及图片 302/429 停止回归后，针对性 4 套 / 47 项通过。服务端与前端构建、改动服务端文件 lint、前端 lint 通过。合成 SQLite 测试覆盖重复新增 0、重建服务后的手动/cron 更新、文章逐字段无漂移及失败无写入；它们不是线上新增文章证据。

下一步由 C 用 A 私存的当前真实列表、原文与图片通过上述正式入口回放到生产一致性副本，核验全部旧行保护、再次更新、重启及 RSS/Markdown/Obsidian/ZIP。之后再做当前官方列表真实第二次读取与自然新增验收。此单元未写生产库，也未宣称真实新增订阅已恢复。
