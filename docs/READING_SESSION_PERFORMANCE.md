# 阅读缓存与导出性能核对

代码基线为 main `33ec7c3ebc20ce55d5f81259a5dd515912b5ca65`。本轮先处理可复现的缓存、重复解析和导出正文保留开销；未修改布局、菜单、数据库连接数、事务、安全门禁或超时。导出实现与独立测量见 [OFFLINE_EXPORT_PERFORMANCE.md](OFFLINE_EXPORT_PERFORMANCE.md)。

## 版本差异与发布边界

独立集成提交 `8a3141c43b1b09e92ebd75780f26c58939557906` 与 main 并不等价。其分组、日期筛选、ArticleReader 和缓存版本监听接线尚未全部回流；main 的 `feeds/index.tsx` 仍有旧入口。本轮没有用旧页面整体替换这些功能；该文件只修改批量导出的调用分组与卸载取消，布局、菜单和现有筛选展示均未改动。

启动也存在相同差异：main 的 `logon-start.cjs` 调用 `controlledRestart(start)`，后者仍有 before-start 备份与完整检查；main `runtime.cjs` 在加载应用前同步调用 `inspect-sqlite.py`。集成提交的 runtime 已使用 schema gate 和 `createStartupAudit`，后台审计结束前禁止写入。不能把后台审计文件“存在”当作 main 已接线，更不能跳过迁移、完整性或外键检查来加速。

本轮仅核对源码入口；没有重启生产、冷启动生产服务、复制真实数据库或制造整库备份，故没有新的生产冷启动时延。启动工具的差异应按已验证实现单独整合，不在缓存补丁里引入通用发布框架。已有部署不得直接换成这个 main 基线整包；应先完成上述功能差异核对，或只移植本轮局部补丁并重新验收。

## 查询策略

- 文章列表、统计和正文结果在当前 QueryClient 会话内保留至多60秒。没有提高 `staleTime`：返回页面仍按原行为重新核对，手动刷新、重试正文和现有 mutation 的失效继续有效。缓存可见与复核完成是两个阶段。
- 只对未观察的阅读查询施加保留预算：4 MiB 保守字符串/对象估值、12页、12个查询，按最近使用淘汰。活动列表和打开的正文不受该保留预算裁剪，整个浏览器堆不承诺小于4 MiB。超大正文离开阅读器后不留作会话缓存；取消的后台请求也释放缓存状态并清理晚建的GC计时器。
- 列表返回第一份快照后才启用四项统计查询，先让主要内容可见。后端统计、筛选、分页协议和未展示的第21行 cursor 均保持原样，没有将正文带回列表。
- 不把正文或页面查询结果写入 localStorage、sessionStorage、IndexedDB 或磁盘；已有浏览位置记忆照常工作。

## 同环境浏览器测量

Windows、Node24.11.1、本机隔离 Chrome，原 ArticleList/TrpcProvider、受认证的原 tRPC HTTP 路由，新建200订阅/1200文章合成 SQLite，正文约32 KiB。服务端页面复用明确旁路；使用开发夹具 bundle，非生产压缩资产。旧版通过 `READING_BASELINE_SHA=33ec7c3…` 读取固定源码，新版使用工作区源码。每个版本一个独立浏览器，旧组随后新组，每项5次，并非交替独占主机实验；同时有其它隔离测试和正常主机I/O。没有请求外部平台或生产接口。

| 阶段，毫秒，n=5/版本       | 旧 P50 / P95    | 新 P50 / P95    |
| -------------------------- | --------------- | --------------- |
| 夹具重载到首20行           | 218.45 / 259.51 | 213.61 / 228.27 |
| 下一页到40行               | 95.17 / 152.07  | 96.46 / 108.15  |
| 返回两页列表，缓存可见     | 115.62 / 157.72 | 65.35 / 79.65   |
| 返回后，后台复核完成       | 143.34 / 188.83 | 141.82 / 190.81 |
| 已缓存正文首次 iframe load | 143.57 / 286.98 | 136.86 / 227.43 |
| 同篇再次 iframe load       | 79.15 / 100.77  | 81.63 / 145.69  |
| 两页手动刷新完成           | 43.88 / 51.91   | 43.86 / 52.64   |

收益集中在返回时不再等待两页读取。每次返回的后台列表请求仍为2个，复核完成时间基本不变；不能声称数据库读取已省去或缓存表示最新状态。首屏、翻页和正文没有可归因的明显加速。页面重载包含夹具JS/CSS与组件执行，P95仍超过150ms；正文首次打开P95也未达到150ms。热翻页在本夹具内低于500ms，不代表任意机器或生产负载都满足。

返回并复核后由同一CDP命令触发GC，JS堆各5样本约为旧7.04–7.07 MiB、新7.79–7.82 MiB，增加约0.78 MiB。这是回收后保留堆，不是整个浏览器进程峰值。原位置/认证的 WebStorage 序列化估值两组均840字节；新增查询缓存没有持久化写入，浏览器 profile 的实际磁盘占用未单独计量。导出的进程采样峰值、暂存字节和内容hash另列在导出文档中。

HTTP记录的 `databaseMs` 来自共享SQL事件区间，并发时可能混入其它请求，不能作为严格单请求归因。表中页面墙钟和独立HTTP记录不依赖该字段。

## 复现与回归

```powershell
# 在仓库根目录；仅创建小型合成库、本地临时端口和隔离浏览器。
$env:ARTICLE_LIST_BENCHMARK_FEEDS='200'
$env:ARTICLE_LIST_BENCHMARK_ROWS='1200'
$env:ARTICLE_LIST_BROWSER_SAMPLES='5'
$env:ARTICLE_LIST_MEASUREMENT_ONLY='true'
# 旧组另设 READING_BASELINE_SHA 为完整基线 SHA；新组不设。
node --test scripts/article-list-browser.test.cjs
node --test scripts/reading-query-cache.test.cjs scripts/export-article-batches.test.cjs scripts/storage-status-ui.test.cjs
```

去掉 `ARTICLE_LIST_MEASUREMENT_ONLY` 可运行完整分页、快速重复点击、失败重试、筛选切换和位置恢复回归。缓存测试使用真实 TanStack Query，覆盖分页链保留、不同筛选隔离、失效、活动正文保留、超预算淘汰和旧后台响应不得重建已淘汰视图。最终准确提交的CI是发布前检查，以上合成测量不替代已部署用户路径验收。

## 实现参考

复用现有 [TanStack Query](https://github.com/TanStack/query) 的 query key、失效、取消和内存缓存机制，依据 [v4缓存生命周期](https://tanstack.com/query/v4/docs/framework/react/guides/caching) 与 [精准失效](https://tanstack.com/query/v4/docs/framework/react/guides/query-invalidation)。没有加入另一套缓存服务。导出继续使用 [Archiver](https://github.com/archiverjs/node-archiver) 的成品暂存方式；本轮没有将“开始传输”改称“导出完成”。组合索引应先用实际查询的 [SQLite查询计划](https://sqlite.org/queryplanner.html) 证明收益，本轮没有盲加索引或改WAL/连接池。

## 局部接线与发布前提

新增本地批量入口 `article.saveToObsidianBatch` 每次最多64个固定ID，只接受ID列表，目录仍来自既有配置。它先读取轻量成员，再按8篇读取正文，逐篇沿用原子发布；不在文件校验期间占用数据库事务。回执只包含用户可见路径、完成/媒体/日期状态，不返回内部回执内容。失败保留已完成文件并停止后续项；断开请求在当前原子项结束后停止，释放整批锁。前端固定选中项，串行提交64项分组，无自动重试；卸载页面取消后续提交。并发采集提交数5及自动缺图修复没有修改。

对已部署 `8a3141c43b1b09e92ebd75780f26c58939557906` 做了临时Git索引的局部补丁检查：store、cached export 和 provider 的对应修改可以直接应用；router、列表和 feeds/index 因既有版本分叉不能整段直接应用。此检查没有修改运行目录，也不代表兼容验收。后续集成必须逐段接入新路由/正文分批、缓存选项及批量调用，保留部署版日期/分组浏览、ArticleReader、缓存版本失效、取消和日期待确认提示，禁止用本候选旧main页面覆盖生产页面。正式发布前仍需在这一集成版本上重做类型、浏览器与实际用户路径验收。
