# 无变化缓存的单次正文预检

基线：`f82fadeba752cffbc8934010c0bd05dc35b88675`。

自动缓存同步遇到上游页面未变化、本地没有排队媒体任务时，原流程先做
`inspectLocalMedia`，发现媒体未就绪后再做 `syncText`。这两次调用都会执行本地正文
flags 查询。现流程直接调用一次 `syncText(fetchMedia:false)`，使用这次返回的
`mediaReady` 决定是否排入独立媒体队列。生产服务不再注入额外的媒体预检调用。
只读 fallback 仍支持未提供 `syncText` 的依赖。

每轮都读取当前本地状态；没有跨轮次摘要缓存。缺少结果、缺少 readiness 或明确
未就绪仍排队，失败仍进入 `unavailable` 并按原退避重试。正文缺口、用户编辑保护、
身份校验和写后重新读取 flags 沿用原 `syncCachedWechat2RssPage`；没有修改该函数或
它的 SQL。上游正文/媒体改变时仍走原列表、正文和独立媒体流程。夜间窗口、媒体暂停、
全局风控停止与提交间隔均未改变。

## 隔离验证

本地引擎与真实 SQLite storage 回归共 29 项通过，额外离线媒体回归 22 项通过；
服务端类型检查与改动 TypeScript lint 通过。真实 SQLite 用例在修复媒体后再改变
保存正文，证明无变化上游页面仍发现本地缺口；媒体暂停时只执行一次 flags 查询，
恢复后补图并保留正文编辑、样式和备注，健康轮次不重复下载。

从仓库根目录运行：

```sh
pnpm --filter server exec jest --runInBand src/feeds/cache-sync-engine.spec.ts src/feeds/cache-sync-storage.spec.ts
node --test scripts/offline-media-recovery.test.cjs
node apps/server/scripts/benchmark-cache-reconcile.cjs /explicit/writable/fixture/root
```

基准加载基线与当前实际引擎，在 80 篇、每篇约 128 KiB 内联图片正文的小型合成
SQLite 库执行同一条原生产 SQL。每种情况交替测 5 对，结果见
[完整样本](CACHE_SINGLE_PREFLIGHT_BENCHMARK.json)。下表单位为毫秒、中位数：

| 当前本地状态 |   原流程 | 单次预检 | 查询次数 | 最终状态一致      |
| ------------ | -------: | -------: | -------- | ----------------- |
| 健康         |  409.767 |  423.417 | 1 → 1    | 是，synced-cache  |
| 媒体待补     |  787.604 |  396.784 | 2 → 1    | 是，media-pending |
| 正文缺失     |  806.057 |  411.291 | 2 → 1    | 是，media-pending |
| 结果未知     | 1274.634 |  582.080 | 2 → 1    | 是，media-pending |
| 正文同步失败 |  823.454 |  445.511 | 2 → 1    | 是，unavailable   |

基准的依赖替身执行真实 SQLite 查询，但不包括 Prisma 入场等待、身份元数据读取或
写事务；它验证引擎控制流与查询次数，真实保存行为由 storage 回归覆盖。健康情况
没有减少查询，测量波动不应解释成收益。fixture 保留，不读取或复制生产库，不读
运行时凭据，不发真实平台请求。

这些耗时不能直接换算成生产轮次节省：17:30 轮次 485.168 秒中，正文预检与固定
390 秒间隔及其他工作重叠。该修复作用于自动缓存重复检查，批次缓存路径不一定
经过此分支。不会把备份复用或其他优化收益相加。

## 文件与交付范围

运行时代码只改 `cache-sync-engine.ts`、`cache-sync.service.ts`；补充相应 engine/storage
回归、离线基准和本说明。CI 配置将独立开发分支加入现有 push 白名单，并添加独立
的 `cache-reconcile-offline` 任务，执行对应回归、类型检查与前后合成基准并保存样本。
原有 CI 步骤不变；独立任务避免无关浏览器测试提前失败后跳过缓存回归。
草稿 PR 针对生产基线所在集成分支，避免向分叉的 main 混入历史改动。
生产部署与合并仍由协调后的单独步骤处理。
