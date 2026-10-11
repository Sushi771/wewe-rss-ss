# SQLite 周期完整快照与快速新增守卫

用户选择方案 3：可核验纯新增允许快事务；覆盖、删除、迁移继续逐次执行原写前完整备份。主库损坏可能丢失最近快照后的新增。15 分钟是检查周期，不能当成备份成功保证。现有完整备份和恢复流程保留，本轮不删除旧备份、不改实际配置、不部署。

## 产品行为和风险

启动必须成功完成新的一致性完整备份及验证，才能授予快事务许可；重启不加载旧 JSON 权限。每 15 分钟检查一次：有变化才新建完整快照；完全未变更则延长经过证明的保护水位，保留真实备份开始和成功时间。纯本地工作不调用刷新、采集、正文、图片或任何网络，可在用户禁止主动采集的 00–06 运行。

快照失败、完整性或校验失败、记录损坏/丢失、备份文件损坏/丢失、源库身份/schema 变化、时钟回退及过期立即禁止快事务。消费模块必须回滚后走原写前全备；原全备也失败时拒绝新增，不能无保护继续。异常只使用现有短通知或日志，不增诊断面板。时钟回退、库替换、owner 死亡或锁文件替换后需重新启动并完成新备份。

`backupStartedAtMs` 是保守快照起点；`backupSucceededAtMs` 是完整验证实际成功时间。`elapsedSinceBackupSuccessMs` 报告成功之后经过多久；`conservativeRecoveryWindowMs` 从开始时间计算更保守的恢复窗口。两个 elapsed 值同时考虑 monotonic 时间，避免冻结或慢墙钟缩短风险窗口。并发备份代表开始到结束之间某个一致性版本，完成时间不能解释为全部并发新增都已进入快照。

完全未变更证明仅更新 `coverageAtMs`，不更新备份起点或成功时间，不伪造新快照。持续连接的 `PRAGMA data_version` 与 schema 证明源库版本相同；水位取检查开始时间，早于版本观测，避免把观测后的写入算作已覆盖。丢失 dirty 通知也会被 `data_version` 捕获。源数据库路径、文件身份、schema、generation 或证据无法可靠核实时，必须安全回退。

## 实现与依赖

复用 Python 标准库和现有 `apps/server/scripts/backup-sqlite.py`：SQLite 在线 API、完整 `integrity_check`、订阅/文章计数、SHA-256 及 `verification.json`。CLI 原参数与原输出字段保留，新增 `startedAtUtc`。连接显式关闭，修复原上下文管理器不会关闭连接而在 Windows 残留文件句柄的问题。周期和原写前全备共用一次操作系统锁；锁等待有界，失败拒绝写入，禁止完整备份堆叠。

常驻 owner 另持有数据库路径对应的单实例系统锁：Windows `msvcrt`、Unix `flock`，重复启动立即拒绝，不偷锁、不删除锁文件。单队列执行周期工作。锁、备份目录和 receipt 都留在数据库旁的私有目录，文件不提交。JSON 只作诊断：进程在内存持有精确内容并检测编辑/丢失；启动始终重新备份，没有磁盘 JSON 信任恢复。

Python 与 Node 在 Windows 编码 volume identity 不同。两个运行时各自持有本运行时的完整 dev/inode 并独立核验，不截断或混比 ID。Python 核验自身只读连接与源文件；Node 查询和事务校验核验启动时捕获的 Node 文件身份。UNC 网络库拒绝快事务；无法提供可靠文件身份的环境走原全备。

没有新增依赖库、数据库框架或业务表；追加批次业务表及原子提交由纯新增模块负责。Prisma/SQLite、Python、Node 沿用项目既有依赖版本。父统一集成两个补丁后追溯原锁文件版本，并按现有部署文档构建。

## 最小消费契约

模块：`apps/server/src/collection/sqlite-snapshot-guard.ts`。

```ts
type InsertOnlySnapshot = {
  source: string;
  sha256: string;
  verifiedAtMs: number; // 实际全备验证成功时间，仅作元数据
  lease: FastInsertSnapshotLease;
};

await startSqliteSnapshotGuard(); // 应用启动；不等待首个完整备份结束
const originalPermit = await recentVerifiedSqliteSnapshot(); // 只读查询
if (originalPermit) {
  await prisma.$transaction(async (tx) => {
    await assertInsertOnlySnapshotPermit(tx, originalPermit);
    // 消费者验证纯新增，原子提交文章、批次记录和订阅状态。
    await assertInsertOnlySnapshotPermit(tx, originalPermit);
  });
  await notifySqliteSnapshotDirty(originalPermit);
}
// permit 不合格或 assert 失败：回滚，返回 null，走原写前全备。
```

消费者保留原 permit，不用重复查询的新 permit 替代原事务的许可。`lease` 绑定 token、owner/snapshot generation、真实路径、文件身份、源 schema cookie/定义 hash、快照 SHA、保守时间与截止时间；最长 5 秒，校验不续期。复制外层元数据允许，嵌入的 lease 必须是私有 stdio 返回、owner 当前内存持有的原对象。源路径、SHA 和 verifiedAtMs 单独不足以授权快事务。

事务内执行 `PRAGMA database_list`、文件身份、源 schema cookie/hash 以及原 token 校验，写入前和写入后均需通过，否则回滚。迁移/数据库替换必须与应用事务互斥。不以消费者自定义的 verifiedAtMs 年龄覆盖 owner 水位资格，否则长时间未变化时会误拒绝已证明的旧快照。

`main.ts` 启动 owner，HTTP server close 和进程正常 exit 时停止；进程异常退出/stdio EOF 后 worker 自动释放系统锁。消费者不增加生命周期框架或定时器。首次备份期间或 owner 查询超过 2 秒返回回退资格，查询本身不执行全备。提交后 dirty 仅安排下一周期，不把每批新增变成全备。

配置见 `.env.sqlite-snapshot.example`：默认 `SQLITE_PERIODIC_SNAPSHOT_ENABLED=0`；父审查后统一 enable。默认 interval/max-age 都为 900 秒，可配置 `60 <= interval <= maxAge <= 86400`；解释器复用 `SQLITE_BACKUP_PYTHON`。本轮未修改用户实际配置。

## 回归与交付

```sh
python apps/server/scripts/test_sqlite_snapshot_guard.py -v
pnpm --filter server test --runInBand sqlite-snapshot-guard.spec.ts sqlite-backup.spec.ts
pnpm --filter server build
```

19 项 Python 有限合成库回归包括：fake clock 启动/15 分钟、未变更水位、漏通知、重启、双进程、统一完整备份锁超时、记录/快照损坏与丢失、库替换、schema 变化、磁盘失败、并发时间边界、真实在线备份中 WAL 写入、实际备份恢复与旧正文保留。6 项真实 Python/Prisma 事务回归包括许可与批次原子提交、备份消失后整批回滚、错误数据库、伪造/复制 token、停止 owner、最终契约。原 SQLite 备份门禁 34 项回归保留。

本轮只在独立 Temp 副本构建和验收，无生产全库压测、无上游或媒体请求。父需将本 owner 替换消费窗口的 fail-closed 临时 stub，统一集成纯新增功能后再做产品入口验收、enable、提交或发布。
