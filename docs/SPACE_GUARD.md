# 测试产物与 SQLite 备份空间防护

磁盘增长来自完整数据库反复复制：演练先备份、再复制 `rehearsal.db`，启动准备又备份；按时间戳建目录让这些文件一直积累。本防护从生成入口限制增长。它是待集成代码，不能替代已批准的历史清理，也不会自动部署或重启服务。

## 使用规则

- `restart.cjs --rehearsal`、`rehearse.cjs`、`switch.cjs --rehearsal` 不传数据库时，默认按公开 Prisma 迁移创建小合成库（2 个 feed、40 篇合成文章）。旧 schema 演练停在正文状态迁移之前。它验证离线字段、迁移、导出与启动逻辑；不能证明真实采集或生产数据完整性。
- 传 `--database` / `--source` 必须同时传 `--real-copy`。仅传路径不会再默认复制生产库。真实验收仍可执行，但需明确为其选择隔离输出盘及容量预算。
- `--output-root` 或 `WEWE_TEST_OUTPUT_ROOT` 指定所有演练输出根；默认系统临时目录的 `wewe-rss-tests`。Windows 本机建议使用 E 盘。不同调用应共用同一根，避免人为分散预算。
- `--keep-test-databases` 可保留本次合成库供诊断。默认成功、失败均清理本次运行目录内的合成 SQLite/SQLite sidecar，保留小报告、日志、哈希与检查结果。不会清理其他运行目录。
- 真实源的验收副本始终保留，由操作者决定回收；失败副本也计入预算。已有的数据库、生产备份和旧报告不会被静默删除。
- 同一输出根只允许一个正在运行的演练。正常结束释放租约；进程崩溃留下 `.space-budget.lock`，后续生成停止。先确认原进程已退出、检查该运行目录，再由操作者处理租约；不要在运行中删除锁。

```powershell
# 默认小库，无需生产 SQLite 或生产 node_modules 副本
$env:WEWE_TEST_OUTPUT_ROOT = 'E:/wewe-rss-tests'
node scripts/local-release/restart.cjs --release E:/release-candidate --mode start --rehearsal
node scripts/local-release/rehearse.cjs --release E:/migration-candidate

# 真实副本是显式隔离验收；预算需覆盖多份完整库，而非仅源文件
$env:SQLITE_TEST_MAX_BYTES = '8589934592' # 本次人工选择 8 GiB 输出预算
node scripts/local-release/restart.cjs --release E:/release-candidate --mode start --rehearsal --database E:/authorized-source/wewe-rss.db --real-copy
```

`benchmark-launch.cjs` 测量当前候选的完整校验冷启动与复用校验冷启动，默认也用合成库。它不再克隆整套 release、历史控制器和生产数据库。旧 `--resume-report` / 非 HEAD 的 `--baseline-ref` 会明确拒绝；若需历史版本比较，应先建立独立、经过审查的预算方案。

含真实官方响应 cassette 的 `album-acceptance-rehearsal.cjs` 以及历史 `replay-owner-search-cache.cjs` 不能凭合成记录证明真实回放，因此要求 `--real-copy`，并接入同一测试空间预算。album 可传 `--output-root`，历史回放可用 `WEWE_TEST_OUTPUT_ROOT`。`resume-legacy.cjs` 也要求显式 `--real-copy` 和匹配的输出根。

## 默认预算

| 范围 | 总文件字节上限 | SQLite 数量上限 | 生成后必须剩余 | 配置前缀 |
| --- | ---: | ---: | ---: | --- |
| 测试输出根 | 512 MiB | 12 | 256 MiB | `SQLITE_TEST` |
| 单个生产备份根 | 64 GiB | 32 | 2 GiB | `SQLITE_PRODUCTION` |

每个前缀可配置 `_MAX_BYTES`、`_MAX_COPIES`、`_MIN_FREE_BYTES`；值必须为正整数。字节按二进制单位计算。测试会扫描整个输出根，包括兄弟运行、失败半成品、报告与导出；生产备份扫描整个备份根。SQLite 数量包含 `.db`、`.sqlite`、`.sqlite3`。目录内链接/junction 被拒绝，真实路径防止源数据库落入其备份目标或形成嵌套副本。

选择 512 MiB 是为了让常规小库测试保持轻量，12 份允许单次启动/回滚链所需副本但无法积累数百份。生产 32 份是明确停点，64 GiB 为较大库保留可配置余量；两者谁先到达就停止。这些是生成限额，不是“保留最近 N 份并删除其他”的授权，也不保证覆盖某个固定历史窗口。生产至少保留 2 GiB 空闲，为 WAL 与应用写入留余量；实际业务增长较大时应人工提高该余量或换输出盘。

单次 SQLite 备份按 `2 × (源 DB + 当前 WAL 字节) + 1 MiB` 估算，覆盖可见快照与一定增长余量。演练开始前保守预留 8 个数据库副本和 16 MiB 非数据库产物；合成路径预留 16 MiB。没有足够总量、数量或磁盘空闲时，在生成数据库之前停止并提示路径、已用量、预计量和人工检查恢复点。开始与获取独占预算租约后都检查，避免并行入口同时通过预检。

示例：180 MiB DB 无 WAL，真实演练预留约 `8 × (360 + 1) + 16 = 2904 MiB`，会被默认 512 MiB 测试预算拒绝。操作者应明确改在 E 盘、批准更大测试预算，而不是让脚本偷偷删除已有数据来通过。

## 生产恢复点

生产受控启动/重启/切换及后台启动审计将备份集中到稳定的 `数据库同目录/backups/full-snapshots`，可用 `SQLITE_PRODUCTION_BACKUP_ROOT` 指定其他盘的稳定根。审计报告可独立用 `--output-root` 或 `WEWE_PRODUCTION_AUDIT_ROOT` 配置。测试根与生产备份根应分开；生产控制器明确设置 production 策略，不继承 test 策略。

Python `backup-sqlite.py` 与 Node/Python 启动准备会复用最新已验证且源未变化的恢复点：比对数据库/WAL 身份；仅元数据变化时按流式 SHA-256 验证文件内容；重新核验备份 SHA-256 与 SQLite 完整性。源或 WAL 内容改变、恢复点缺失/损坏、receipt 无效，均需重新生成并核验。哈希使用固定大小缓冲区，不把整库一次读入内存。复用不修改原恢复点时间，也不假装新增历史恢复点。

周期快照守卫已有自己的未变化版本判断。建立新可信代际（例如服务重启）仍要求新的完整快照，不因复用绕过原有可信性要求；它也受空间限额约束。需要的备份无法完成时，启动/写入保护会拒绝继续，而不是取消必要备份。

恢复点内容、字段保全、完整性检查保持原有要求。失败生成的生产副本保留并计入限额，写入小失败报告供诊断。达到阈值时提示人工复核恢复窗口、唯一恢复点、存档/回收候选或目标盘；代码没有自动永久删除生产历史文件的功能。批准一次历史清理不改变这一规则。

## 边界与人工决策

预算检查是本项目入口的生成门槛，不是 OS 文件系统硬配额。磁盘可能被其他进程占用，在线源或导出内容也可能在估算后增长，SQLite 原有失败处理仍会阻止不受保护的写入。更严格的全盘配额需要操作系统支持。没有接入本入口的外部脚本、旧 release 包、生产数据库本身、长期服务日志、图片/视频缓存与人为选择新的输出根不受此限额统一管理。

历史备份不会被扫描去重后自动删除。换根不会迁移旧历史；应人工确认原根的恢复窗口和剩余空间。测试报告累计至总字节门槛也会阻止新演练；需要保留哪些报告由操作者决定。正常生命周期只允许清理本次生成的合成 SQLite 文件，不删除真实副本或旧唯一恢复点。

## 离线验收

```powershell
$env:TEMP = 'E:\wewe-test-temp'
$env:TMP = $env:TEMP
$env:PYTHONDONTWRITEBYTECODE = '1'
node --test scripts/local-release/space-budget.test.cjs scripts/local-release/startup-sqlite.test.cjs scripts/local-release/startup-audit.test.cjs scripts/local-release/runtime-policy.test.cjs
python -m unittest discover -s apps/server/scripts -p 'test_backup_space.py'
python -m unittest discover -s apps/server/scripts -p 'test_sqlite_snapshot_guard.py'
python -m unittest discover -s scripts/local-release -p 'test_prepare_start.py'
```

覆盖生成前字节/数量/空闲拒绝、真实源 opt-in、嵌套与 junction 拒绝、并行/崩溃租约、成功/失败合成清理、旧恢复点字节不变、内容去重、WAL 失效、变更后新恢复点及周期守卫的原安全约束。使用公开 schema 和小合成数据，不复制生产数据库或大依赖目录，不启动/停止生产服务。
