# 冷启动打包候选与实际页面计时（2026-10-05）

候选在独立 `codex/compact-cold-launch` worktree 完成，承接 `1fb5425` / PR16。生产部署、组合包与真实桌面验收仍由唯一 owner 执行。本轮没有停止、重启或写入 4000，没有腾讯请求、账号/配置改写、定时刷新，也没有改变 ExecutionPolicy、安全策略或自启动。

## 已测结果及限制

原目录包的真实应用冷 controller 为 18.034 秒；PR16 同轮对照为 19.376→17.301 秒，最后两轮 17.441/16.927 秒。新候选完整普通模式冷演练为 **4.484 秒**，私有模式为 **4.950 秒**。完整演练包含额外建立测试数据库副本和生成 20 篇 RSS，不能当作真实桌面点击计时。

日常冷入口演练先在计时外建立隔离 SQLite 副本，再计时端口 Discover、包校验、控制器必需的新一致性备份、全字段保护、启动、RSS 就绪、完整身份和指针校验。每轮应用均已停止，没有常驻预热；安装验收及 OS 文件缓存可以存在，不是机器重启后的磁盘冷缓存测试。使用真实 Nest/Prisma 和 Edge 页面，未模拟业务响应。

| 同一最终冻结包，普通模式   |   第一轮 |   第二轮 |
| -------------------------- | -------: | -------: |
| 冷入口及控制器，含指针核验 | 2.945 秒 | 3.102 秒 |
| 首次内容绘制 FCP           | 3.164 秒 | 3.484 秒 |
| 保存设置响应完成           | 3.295 秒 | 3.609 秒 |
| 状态数据响应完成           | 3.365 秒 | 3.734 秒 |
| 浏览器 load                | 3.446 秒 | 3.831 秒 |

页面实际显示文章链接输入框、保存设置和路径选择控件；没有执行下载或刷新。响应完成是数据到达时刻，不冒充精确 React 渲染完成时刻。热服务只做一轮新布局回归：完整 Discover 身份、整包 receipt 核验及实际页面探活 **0.513 秒**；此前热路径 2.183→0.624 秒仍是已交付历史测量，没有重跑那五轮。

**稳定冷启动到可用页面 ≤3 秒仍未实现。** 上表不包含 WSH/入口 Node 进程启动或关闭浏览器后的 Edge 进程创建；实际桌面总耗时须由 owner 测量。私有模式真实 HTTP 登录、匿名拒绝和受保护 RSS 已通过，私有冷 controller profiler 为 3.599 秒；浏览器工具不支持仅给当前测试标签页添加临时 Cookie，未修改用户浏览器 Cookie，因此没有把普通模式页面计时写成私有浏览器验收。

## 剩余耗时定位

最终包私有模式分段 profiler，包含 profiling 开销及测试标记 SHA 核验；父子项有包含关系，不能全部相加：

| 父进程步骤                                       |    秒 |
| ------------------------------------------------ | ----: |
| 完整包元数据 receipt 核对                        | 0.061 |
| 第一轮监听归属检查                               | 0.156 |
| 全字段基线、一致性备份、独立逐值等价和源身份复核 | 1.228 |
| 启动前第二轮监听归属检查                         | 0.160 |
| child spawn 至 HTTP、匿名拒绝、登录及 RSS 就绪   | 1.273 |
| Windows 完整进程身份及独占监听快照               | 0.527 |
| controller 合计，含演练子进程关闭                | 3.599 |

子进程包核验 0.036 秒，数据库完整性/迁移/必需列核验 0.085 秒；Prisma 预检完成累计 0.333 秒，应用模块加载 0.492 秒，HTTP 绑定 0.006 秒，开始监听累计 0.949 秒。较早同机普通模式备份约 0.82–0.85 秒，说明有负载波动，不能称为 OS、磁盘或 Nest 的固定下限。

编译缓存原型只减少约 0.08 秒，总耗时没有稳定改善；SQLite 备份批量改变只改善约 0.01 秒；内存摘要与异步备份重叠两轮不稳定，均未进入补丁。下一项有测量依据的方向是全字段摘要序列化：既有全字段 JSON 摘要 0.286/0.245 秒，带类型和长度的流式摘要原型 0.144/0.127 秒。它会改变基线格式，须先完成跨语言、全部值类型及旧基线兼容审查；本轮未更换已经交叉验证的 SHA 算法。该局部收益也不足以证明整个桌面路径稳定 ≤3 秒。

## 实现与保护

- 沿用既有 `build.cjs`，新增显式 `--compact`，默认目录包不变。先运行原 tsc，保留 Nest decorator metadata，再用已安装的 esbuild 0.21.5 打包 CommonJS；保留类名、依赖版本、锁文件/源输入哈希及第三方许可证文本。真实 ZIP、hbs 和类身份回归通过。
- 运行包从旧包 13,305 文件、417 链接缩为 **75 文件、1 个链接**；201 个依赖版本可追溯。保留固定 Node 24.11.1、匹配的 Prisma 5.10.1 Client 和 Windows engine。Uglify 动态源码加载使用原包，不重写其 loader。
- 既有整包成功 receipt 仍绑定规范路径、manifest、verifier 和每个目录/文件/链接的身份、大小、时间及真实链接目的地。任何缺失、变更或坏 receipt 回退严格字节审计。模块不能逃出包；每次 native DLL 加载还核验规范路径和 manifest SHA，防止生成的 Prisma 回落到源安装目录。
- 冷启动数据库用固定 Node 的 SQLite API：只读事务、完整 integrity/FK 检查、全部迁移校验及必需列核验、全字段 JSON 基线、同一快照一致性备份、独立查询副本逐值比对、备份 SHA 和源 DB/WAL 身份复核全部保留。64 位整数不转成不精确 Number。REAL 走已有 Python 检查/基线；Python 原本不支持的值仍失败关闭。该 Node API 在已测 24.11.1 文档中标为 experimental，候选固定版本，不依赖系统 SQLite 或更改 OS 设置。
- 20 篇 RSS 功能验收保留在新包首次安装、更新、重启及普通演练。成功后只给同一规范包、manifest、验收代码和私有模式写忽略的本地 receipt；日常未变化包验证一篇真实 RSS。私有模式每次仍检查匿名 401、登录响应/会话合同和授权后的 RSS；receipt 不替代包核验、数据库核验或完整身份。
- 测试模式可使用仅在内存中的临时私有口令，未写用户配置或审计。`--prepared-rehearsal` 和 `--cold-launch-rehearsal` 仅允许隔离 start，拒绝 production/restart；已准备数据库必须在自身 audit 目录、匹配包 ID/规范路径/SHA、无 WAL，启动必需备份仍会新建。
- 删除 render-blocking 的 Google 字体样式链接，使用已有系统字体栈及 Windows 系统字体，避免本地页面启动等待外部字体。

参考：[esbuild 与 TypeScript decorator metadata 限制](https://esbuild.github.io/content-types/#no-type-system)、[固定 Node 24.11.1 SQLite 文档](https://nodejs.org/download/release/v24.11.1/docs/api/sqlite.html)。

## 复现及 owner 集成

构建和 controller 均使用已核的 Node 24。当前 schema 必须已经完成受控迁移；compact 包不携带 Prisma CLI，不用于执行未完成的迁移，缺迁移会在启动前拒绝。旧迁移/回滚包沿用现有目录布局与流程。

```powershell
node scripts/local-release/build.cjs --compact
node <新包>/runtime.cjs verify
node <新包>/runtime.cjs probe --database <已迁移的隔离SQLite副本>
node scripts/local-release/restart.cjs --release <新包> --database <隔离SQLite副本> --mode start --rehearsal
```

第一次普通演练保留完整 20 篇验收。日常冷计时用已验收包加 `--cold-launch-rehearsal`；额外测试副本复制仍在默认演练时钟内。计时外准备数据库时才可加 `--prepared-rehearsal`，满足前述 marker/目录/SHA 检查；不要把这个标志用于生产。正式部署仅由 owner 在整合当前应用、严格审计新包、备份及副本演练后使用现有受控机制，不原地修改旧运行包。

最终冻结实验包为 `2026-10-05T05-55-24-541Z-e84b3a2fa0e3`；212 个源输入的 SHA 全部与构建时一致，manifest sourceHash 匹配，整包严格审计通过。源代码、记录版本和候选 commit 可提交；包、数据库、凭据、原始日志、截图及备份不提交。

本地 **65 项 Node、14 项 Python** 通过。两个最终浏览器演练的运行库及新备份均由独立 Python 对全字段基线再次核验，全部订阅及文章字段保留；offline guard 外部网络/子进程拦截计数均为 0。CI 新增 bundling/native 边界、Node 24 SQLite 与 Python 交叉及验收 receipt 回归；准确远端结论按 PR 当前 SHA 和 Actions 结果核对，不能沿用 PR16 的绿色结果。

原始证据只保存在忽略的 `output/playwright/launch-followup/` 与 `local-release-audit/`：`compact-final-validation.json`、`prepared-ui-controller.json`、最终私有 `cold-profile-*.json`、对应全字段基线/新备份和 guard 报告。编译缓存、流式摘要等原型仅供审查，没有进入运行源码。
