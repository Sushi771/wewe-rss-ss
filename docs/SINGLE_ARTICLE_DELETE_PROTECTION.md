# 单篇删除的独立恢复保护

已有 `article.delete` 入口保持同一输入和返回文章 ID；未新增删除入口，也不改变文件导出保留行为。过去单篇删除直接进入 Prisma，缺少删除前恢复点；现在与 PR39 订阅单删/批删共用 `protected-delete.ts` 的独占保护边界。

先读取并冻结目标。获得独占应用准入后重新检查目标及实际 Prisma 数据库身份，再请求一次已验证的 protected 备份。周期快照、错误源库、无完整性/校验和证明或备份失败均不允许删除。备份成功后，仍在同一独占准入中开始事务；先以零行 UPDATE 获得 SQLite 写预留，再复核耐久模式、foreign_keys、源库身份和全部目标字段，最后执行原删除。排队期间、备份期间或事务入口发生变化时明确失败，不自动重试删除。

共享 helper 从 PR39 原 `protected-feed-delete.ts` 提取；订阅级联删除仍保留原有目标筛选、去重、空批次、缺失单目标、回执与一次原子事务语义。单篇不存在或未登录在保护前失败。删除后只更新缓存失效水位，不清理用户导出文件。

该路径只接受 SQLite 的可验证恢复保护；不能将 MySQL 或缺失证明当成免保护删除许可。恢复点仍可能复用经正式备份组件独立证明完全相同的已有 protected 快照；业务入口一次调用不代表强制制造一个重复文件。

验证使用 Node 24、原 PrismaService 和实际 Python 备份组件，只创建小型合成 SQLite。`protected-feed-delete.spec.ts` 共 26 项通过，新增覆盖单篇成功与恢复内容、备份失败、错误/普通/损坏证明、未登录/不存在、并发正文/归属变化、准入等待、其他应用写排队及 SQL 故障回滚。生产类型检查通过。没有生产查询、平台请求、迁移或部署。

```powershell
pnpm --filter server exec jest --runInBand src/trpc/protected-feed-delete.spec.ts
pnpm --filter server exec tsc --noEmit --incremental false -p tsconfig.build.json
```

冻结开发基线为 PR39 `d3f4af046accbd2453bf403691338c9592f938c6`。分组及采集普通增量由独立开发窗口修改；共享 `incremental-write.ts`、`sqlite-backup.ts` 和 Prisma 准入接口不在此删除补丁中重写。最终合并后另验与 PR42 及两路后续提交的兼容性。
