# 先打开页面，再校验已有数据

日常冷启动先检查数据库可读、完整字段/索引/外键定义与固定包兼容，以及迁移记录、校验和与完成状态。检查不修改数据库，不自动迁移。正常页面和已有文章/RSS可先使用；顶部显示后台检查提示。启动反馈窗口只报告“页面已打开”，不会把页面可用称为完整数据校验通过。

原有一致性备份、SQLite完整性/外键检查、正文等受保护字段的哈希与备份逐值比对仍执行，但由服务启动后的一个临时工作线程完成。读事务固定同一个快照，使用SQLite备份API包含WAL；检查源文件身份变化，异常不发布通过基线。通过后自动开放写入；失败或工作线程中断时保留可读页面，短提示说明更新和修改暂停，详细诊断留在本地服务日志。超过15分钟按失败处理。重新启动会重新检查，不缓存一次通过结果。

检查期间，数据库写操作有Prisma统一门槛（包括嵌套与raw操作）；HTTP/tRPC在创建更新任务、触发GET更新或登录结果落库前拒绝受保护操作。已有内容、私人产品登录、账号入口、独立下载目录设置和纯Markdown读取仍可使用。任务恢复和开机补更新等待通过，定时更新在未通过时跳过，后续正常周期恢复。页面不提交自动重试请求，也没有增加常驻服务。

升级、迁移和受控重启仍先同步备份和完整验证，再切换服务；原有失败回退保留。本轮没有修改迁移脚本、旧文章或账号凭据，也没有进行新批次、扫码、`/add`或真实平台采集。完整校验尚未通过的冷启动摘要明确记录`startupAudit=background`及`finalBackup=null`，不能充当完整验收证据。

验证覆盖健康WAL快照、重复启动、物理列序兼容、不兼容schema/索引、迁移失败/未知版本、文件损坏/独占锁、后台外键失败和工作线程异常；服务回归检查可读/受保护操作/失败提示与通过后的写入恢复。命令：

```powershell
node --test scripts/local-release/startup-sqlite.test.cjs scripts/local-release/startup-audit.test.cjs
node --test scripts/local-release/desktop-progress.test.cjs scripts/local-release/readiness.test.cjs scripts/local-release/launch.test.cjs
pnpm --filter server exec jest --runInBand startup-audit.spec.ts
pnpm --filter server exec jest --runInBand feeds trpc
node scripts/local-release/build.cjs --compact
```

本机离线副本已验证14个真实订阅和20篇已有RSS条目在后台检查期间可读，写请求先返回412，GET更新返回503，通过后同一写请求返回200；离线守卫证明没有外部网络调用。初步三次服务读就绪为2.154/2.048/1.953秒，完整校验结束为21.045/15.861/12.695秒；前两次与回归有资源重叠，仅用于生命周期验收，不能作为同条件性能对比。正式桌面三次时间及部署证据补充后再报告。

原有用户`DEVELOPMENT_HANDOFF.md`修改保留。数据库、备份、日志、缓存、截图和原始证据位于忽略的本地目录，不提交。默认浏览器双页真实可见性仍受既有CUA203限制，不能据HTTP或启动回执宣称已目视验收。
