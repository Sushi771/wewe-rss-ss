# 开发演练的合成输入与产物收尾

`replay-browser-dom-images-copy.cjs` 仍被 CI 和单篇导入的合成夹具调用；`replay-weread-directory-copy.cjs` 仍有开发文档命令。两者此前可创建生产库副本，图片入口在恢复环境后仍留着演练库。现在两者都复用 `local-release/test-artifacts.cjs` 的预算、归属台账和收尾，默认从公开迁移创建小型合成库。输入 DOM、目录和图片仍需通过原有来源及字节校验，网络继续封锁。

这两个 CLI 不提供生产源路径或保留数据库选项。图片测试内部的 `sourceDb` 和 `keepTestDatabases` 只接受 Node 测试上下文，用于复用已有合成导入夹具；它们不是生产演练许可。普通运行不再产生可用于旧真实单篇导入的生产基线证明。旧版真实导入历史和其来源绑定门槛不变，不能把新的合成结果冒充该证明。

本补丁从 PR65 `cc15cfe4910b019180bab9b05b08e0af6c34846b` 最小提取到 main `2ce4af106cb5a953dc6b9544bd16a6318ce6f981`，仅接入这两个活跃回放入口和必要的受管产物模块；不把原集成分支的应用或发布历史合入 main。main 的其他历史演练工具没有在此改写，不能将原集成分支的合成默认值视作 main 的现状。过往一次性平台探针及其已消费的审批、停止状态和证据仍保留；历史审计中的路径列表不是重新运行或复制真实库的命令清单。

Prisma 确认断开后，成功或普通异常均调用已有 `finish(error)`，只回收本次受管的 SQLite 文件与 sidecar，保留报告、manifest 和空间摘要。未知断开、变化的文件身份或锁继续保留现场。不会删除以前的文件、输入缓存、外部库或已保留的恢复点；不会绕过共享预算。各窗口继续共用已配置的 `WEWE_TEST_OUTPUT_ROOT`，不要用时间戳换根来重新取得额度。

离线验证先构建服务，再运行：

```powershell
node --test scripts/research/replay-browser-dom-images-copy.spec.cjs scripts/research/replay-weread-directory-copy.spec.cjs scripts/research/commit-browser-dom-images-once.spec.cjs
```

新增断言覆盖默认合成运行、正常和普通失败后的零数据库残留、源夹具与无关文件不变、环境和网络函数恢复，以及断开回执不明时保留数据库与锁。测试保留模式只在所属测试根内供下一步复用，测试任务结束后关闭连接并移除自身新建的临时根。该定向验证使用 Node 原生测试，不创建 Jest 缓存；日志写在测试根之外。受管小报告仍计入原预算，本次不增加报告清理工具。

这是开发入口修复，不修改应用数据写入、生产备份生命周期、配置、启动保护或服务；部署和生产用户路径验收需另行完成。历史文件清理与本补丁分开批准。
