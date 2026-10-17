# 文章列表等待与分页

列表元数据包含存放在大正文之后的列。直接用宽投影筛选、排序和分页时，SQLite 可能为许多最终不展示的文章读取这些数据页，并建立临时排序树。只从响应中去掉正文并不能避免这项成本。

现在先用同一筛选、排序、方向和游标只选页 ID，然后按这些主键读取当前页的原元数据及正文存在性，并按 ID 页的顺序重排。三次文章查询和关联公众号读取处于原有一次事务快照。可能增加一次小 SELECT，但宽列只对当前页读取。没有索引迁移、正文复制或 schema 变化。指标排序仍可扫描对应排序列，不能据此保证任意查询恒定耗时。

游标仍为从结果末尾弹出的下一条未展示记录；后页包含该 ID，不增加 `skip: 1`。发布时间的双向排序、指标排序的降序、ID 并列排序、空指标、公众号、分组、搜索、上海日期范围及未知时间保留原语义。`bodyCached` 对 null/空字符串为 false，对空白字符串为 true；详情和导出仍读取原正文。

原批处理 HTTP 要等最慢的同批过程完成。`article.list` 现在使用同一个认证客户端内的独立 HTTP 分支，其余查询和写操作继续批处理。两个分支共享原 URL、动态认证 headers 和错误处理，不绕过认证或改变批次/任务门禁。统计仍是原有精确查询；不能用更少的 SQL 数量代替实际耗时验证，直接 `COUNT(content_html)` 的试验在含大正文时出现退化，因此没有采用。

加载更多时禁用按钮，并通过 React Query `cancelRefetch: false` 合并在途下一页调用，位置恢复也使用同一函数。文章读取失败不再自动重放三次，而是立即显示原有错误及重试入口；保留已加载行的错误说明，不用旧缓存冒充新读取成功。缓存修订后的多页重读、页面返回时逐页恢复和单次加载下一页分别验收，原选择与滚动位置保护保留。

现有轻量页缓存的数据库文件身份、提交修订计数、WAL/活动 journal 绕过、有限 TTL/内存及错误传播均未改变。性能基准不传可证明的缓存数据库 URL，强制每次执行 SQL，不能用页缓存掩盖慢读或失败。读路径不调用整库备份，不触发上游、正文重试、下载或任务提交。

## 可重复验证

```powershell
pnpm --filter server exec jest --runInBand article-list-page article-list-ui article-date-filter
node --test scripts/article-list-performance.test.cjs
node --test scripts/article-list-browser.test.cjs
pnpm --filter web build
pnpm --filter server build
```

性能脚本在同一个小型合成 SQLite 上交替运行基线算法与当前实现，记录 P50/P95、实际 SQL 引擎时间、SELECT 次数及 `EXPLAIN QUERY PLAN`。默认 1800 篇、合成正文最多 32KiB，大小预算不超过 128MiB；不复制生产库、不清系统缓存、不创建整库备份。另逐页验证完整 ID 并集、无重复遗漏及筛选/排序。可用 `ARTICLE_LIST_BENCHMARK_ROWS`、`ARTICLE_LIST_BENCHMARK_BODY_BYTES`、`ARTICLE_LIST_BENCHMARK_SAMPLES` 调整有界输入。

浏览器脚本使用电脑已有 Chrome/Edge、实际 ArticleList/TrpcProvider、受保护的原 HTTP 路由与合成 SQLite，其他用户数据不参与。它故意扣住统计回执，要求文章先显示且统计最终成功；同时覆盖快速重复下一页、两页恢复与刷新、选择、文件夹筛选、搜索、日期空范围、读取失败与人工重试。认证 headers 在两种传输上均核验。每轮单独记录首屏、下一页与两页刷新；可通过 `ARTICLE_LIST_BROWSER_SAMPLES` 调整样本数。`ARTICLE_LIST_MEASUREMENT_ONLY=true` 仅用于隔离基线对照，会跳过候选行为断言，不能作为候选验收。

原始测量、生产只读请求记录、数据库和本机审计只保留在忽略目录，不提交。合成结果不能当作生产或完全冷启动保证；生产上线后仍需在真实磁盘和原有读路径单独验收。此开发修复以冻结候选为基线，与任务占用修复联合发布，发布前核准最终组合 SHA；本开发窗口不部署、不重启生产。
