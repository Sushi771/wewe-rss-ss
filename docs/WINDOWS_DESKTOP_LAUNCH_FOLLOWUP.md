# 桌面启动第二轮优化（2026-10-05）

用户已经使用首轮桌面入口，本轮继续缩短已有服务打开和服务未运行时的启动时间。基于已提交 `bbb8d5324e4e965349b1788bcf1b68d11c0205ba`，在独立 Temp worktree / `codex/instant-desktop-launch` 开发。生产部署仍由唯一 owner 执行，本轮没有安装真实桌面、停止或重启 4000、触发腾讯请求、账号修改、定时刷新或修改系统设置。

## 测量边界和结果

热路径全部包含端口监听归属、进程创建时间/可执行路径/完整命令行、固定产物启动文件与应用/页面资源哈希、真实本地工具页 GET。未包含 WSH/浏览器进程启动或窗口绘制，不能把数字直接称为点击到可见页面的时间。测量时生产包为 `2026-10-05T03-33-00-867Z-eb9caffd3b54`，PID 33824，创建时间 `2026-10-05T03:49:28.0570527Z`；每轮重新读取指针和身份，没有硬编码运行包。

| 范围                               | 已部署机制 |  最终候选 |
| ---------------------------------- | ---------: | --------: |
| 完整热路径（5 次中位数）           |   2.183 秒 |  0.624 秒 |
| 已验证包的隔离冷启动 controller    |  32.029 秒 | 18.034 秒 |
| 单次完整元数据扫描（逐项结果相同） |   7.084 秒 |  4.070 秒 |

热路径原始 5 次为 4.737/2.494/2.181/2.177/2.183 秒；候选最终为 0.654/0.624/0.617/0.637/0.600 秒。此前候选一组为首次编译 1.320 秒，随后 0.541/0.543/0.525/0.525 秒。负载和文件缓存会波动，这些是实测而非时延保证。

冷启动基线和候选使用同一真实应用和同一 SQLite 一致性副本，候选包只更新启动脚本和相应 manifest。关闭定时更新并安装既有 offline guard，临时端口：基线/第一候选 2468，最终候选 8356。包含 controller 产物核对、完整备份、schema/迁移核对、真实 Nest/Prisma 启动、本地 HTTP 与 RSS 就绪、启动后进程归属核对。第一候选 23.647 秒，原生链接遍历改动后为 18.034 秒（较基线减少约 44%）。启动后再次与完整旧字段基线比较，12 订阅/1450 文章不变，blockedNetwork=0、blockedChildren=0。未安装依赖或重新构建应用；未重启 Windows/清空 OS 文件缓存，属于进程冷启动。新测量不能与首轮 165.712/64.736 秒直接拼为同一次实验。

首次生成新产物的完整字节审计独立记录：第一候选 140.227 秒，最终候选 10.973 秒；不能藏进“复用包冷启动”指标，缓存和磁盘负载也有影响。产物或 verifier 改变时会重新审计。一次测量中 formatter 改变了 verifier 字节，缓存正确失效，该轮 93.990 秒保留为失效证据，不作为未变产物复用的计时。不能承诺冷启动一秒。

## 最小改动

- 将原 Windows 监听表和 WMI 身份检查封装为小型 C# console helper，用系统现有 .NET Framework 编译器按源码 SHA 编译一次。每次调用先核源码绑定 receipt 和 executable SHA。保留原 PowerShell 后备；编译锁冲突走后备，损坏 receipt/可执行文件拒绝运行。安装原桌面入口时提前编译，避免首次点击承担编译时间。没有新增服务或依赖安装。
- 进程检查仍持有同一 OS handle，核对 WMI/handle 创建时间、可执行路径、命令行及所有 IPv4/IPv6 监听归属；Stop 必须完全匹配身份，只测试自建 fixture。新旧实现对同一 fixture 的完整输出相同。辅助工具 receipt 同样是当前用户可写目录中的本地优化记录，不提供签名或抵抗同权限恶意写入的保证。
- 模块越界检查和产物链接核对改用 `fs.realpathSync.native`，仍取得实际规范路径并检查包边界。没有用字符串路径替代真实链接目标，也没有移除元数据枚举或完整字节审计。
- 当前 schema 包仅在没有保存基线的启动预检中使用 `--schema-only`，保留 SQLite integrity/foreign_key、迁移 checksum/完成状态、必要列核对。完整基线、备份等价和旧字段哈希仍执行；该参数不能与 preservation baseline 合用。新 manifest 写入能力版本，旧包 controller 保持完整预检。
- 无旧服务的生产 start 保留一次 before-start 一致性备份，省去重复的 before-stop 备份；restart 的备份保护不变。浏览器选择、300ms 就绪轮询、端口/未知 PID 拒绝和失败诊断沿用首轮。

## 验证和 owner 整合

相关 Node 回归 42 项、SQLite 回归 8 项通过，覆盖篡改 receipt/同大小 executable、编译并发、IPv4/IPv6/已建立连接、旧 PowerShell 等价、错误创建时间/命令行/路径拒绝 Stop、模块 junction 越界、缺失必要列/迁移 checksum、旧正文/NULL 指标保护等。Windows CI 增加 helper cache 测试，Linux CI 增加 SQLite 回归；远端准确结果以候选 HEAD 的 CI 为准。

本地原始证据在忽略的 `output/playwright/launch-followup/`（`baseline-warm.json`、`optimized-warm.json`、`cold-final.json`、`cold-native-final.json`）及对应 `local-release-audit/`。数据库、备份、helper executable、缓存、日志及原始证据不提交。

owner 整合脚本后即可使用热路径提升；在稳定 checkout 重新执行已有 `install-desktop.cjs` 可预编译 helper。冷路径需要按已有构建/隔离演练/受控部署流程发布包含新版 `runtime.cjs/lib.cjs/inspect-sqlite.py` 和 `startupInspection` manifest 的新不可变包，发布时提前完成完整审计。不要修改正在运行的包文件。开发/CI 通过不表示生产已经采用本轮冷启动修补。

复用 [首轮启动说明](WINDOWS_DESKTOP_LAUNCH.md)中的操作与基准脚本。基准脚本已同步复制新版 SQLite inspector 及 manifest 能力，避免将新 runtime 配旧 inspector。当前机器/缓存状态、额外安全软件扫描和数据量都会影响耗时。
