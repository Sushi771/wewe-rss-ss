# 一键更新执行核心

本目录只提供隔离开发的执行核心，不是可安装的正式升级包。未修改主仓、Git 索引、运行实例或真实数据库。

## 接入

`createUpdater({ journalFile, adapter, onProgress }).update({ path, sha256 })` 执行固定包更新；`recover()` 在启动时恢复未完成事务。`journalFile` 必须是每个安装实例固定、受保护的绝对路径，不能由临时安装包任意指定。正式代码应把本文件放进受校验的安装/更新程序，不能从可变工作区加载。

固定包入口必须自带可信 SHA256；`verifyPackage` 必须实际校验 SHA256、受信任发布清单、版本和完整性，并返回稳定不可变的包定位信息。核心不会自行下载或运行包内任意安装脚本。

`adapter` 方法均可返回 Promise：

| 方法                 | 参数/结果                                  | 必须兑现的系统约束                                                                           |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| acquireLock          | `{ journalFile }` → release 函数或 null    | 跨进程独占，覆盖所有启动器和数据库 writer；活 owner 返回 busy；只在证明 owner 已退出后回收锁 |
| verifyPackage        | `{ path, sha256 }` → `{ id, sha256, ... }` | 操作前校验固定包；返回值将持久保存，禁止凭证和易变临时引用                                   |
| currentInstallation  | 无 → `{ id, sha256, ... }`                 | 返回实际当前安装，不能仅相信更新 journal                                                     |
| stopOld              | ctx                                        | 幂等停止旧程序和全部相关 writer，阻止后台任务/正常启动重新打开库                             |
| backup               | ctx → `{ path, sha256, ... }`              | SQLite backup API 一致性快照，验证完成且持久可恢复后返回                                     |
| migrate              | ctx                                        | 只用固定包内的受校验迁移；更新独占期间执行                                                   |
| startNew             | ctx                                        | 事务身份可跨更新器重启定位；以禁止业务写入状态启动                                           |
| health               | ctx                                        | 有限超时的实际版本、HTTP/数据库只读可用性检查，不开启业务写入                                |
| activateNew          | ctx                                        | 原子发布新指针，但仍禁止业务写入                                                             |
| enableNew            | ctx                                        | completed 提交后幂等放行业务写入；跨重启可继续启动/放行                                      |
| stopNew              | ctx                                        | 幂等定位本事务新版及子进程并证明退出，不能仅持有内存 ChildProcess                            |
| restoreDatabase      | ctx                                        | 所有 writer 已停；备份hash/完整性验证；恢复至新文件并安全切换，处理 WAL/SHM；中断后可重复    |
| activateOld          | ctx                                        | 幂等恢复旧安装指针                                                                           |
| startOld / oldHealth | ctx                                        | 以受保护恢复方式启动和确认旧版可用；恢复未提交前仍禁止业务写入                               |

`ctx = { transactionId, package, old, backup, journalFile }`。首次 backup 前 `backup` 为 undefined。所有存入 journal 的返回值都必须可 JSON 序列化，不得包含密钥。

系统 effect hook 可用 undefined 表示成功，显式返回 false 一律作为失败；禁止用 false 健康检查结果放行更新。acquireLock 的 null/false 保留 busy 语义。

completed journal 与实际安装身份冲突时，核心保守阻止更新；宿主需在核实实际版本、数据库及事务已提交状态后执行受控重绑定，不能删 journal 绕过。

业务写入门禁必须由应用启动路径遵守：precommit 任意中断都可能恢复旧数据库，因此 `activateNew` 和 `oldHealth` 不能提前放行业务写入。恢复成功落盘 `recovered` 后，宿主 release 函数/启动门禁才可放行旧版；completed 后只允许继续新版，绝不还原备份。每次正常启动必须读取同一 journal/互斥协议，否则本核心不能保证数据安全。

## 返回状态

- completed：已提交新版且 enableNew 成功。
- completed-start-pending：已提交新版，但幂等启动/放行失败。下次 recover 继续新版，禁止数据库回退。
- already-current：包已是实际当前安装，不重复迁移。
- busy：另一次更新或启动持有独占锁。
- failed-recovered：更新失败，备份恢复（如已生成）、旧版启动和检查均已完成。
- recovered：本次只恢复上次中断，未立即发起第二次更新。
- recovery-failed 异常：恢复未完成，保留 journal 和备份，禁止显示更新成功或启动业务 writer。

## 必要验证

`node --test installer/update-engine.test.cjs` 在合成 adapter 上验证成功、重复点击、每个破坏性步骤的effect后失败、重启恢复、恢复再失败重试、并发点击、损坏journal，以及提交后放行失败不回退。此结果不代表真实 Windows 安装、进程停止、SQLite 还原或业务采集已验收。

现有 `scripts/local-release/switch.cjs` 不可直接接此核心作为通用 adapter：它硬编码特定旧 SHA 和三条 pending 迁移，失败明确 `databaseRestored:false`，只重启旧应用。须由当前固定版本包工作方接入完整系统 adapter，再做一次固定范围安装验收。
