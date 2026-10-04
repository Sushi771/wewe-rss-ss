# 手动刷新与文章下载集成（2026-10-04）

集成分支 `codex/manual-refresh-download-integration` 合并订阅主线 `185ea7f` 与下载分支 `b7c0895`。原下载分支及其隔离 worktree 保留。两边无文件冲突；下载模块不改 Provider、账号或文章库，原 Markdown、Obsidian、公众号 ZIP 继续调用抽出的同一导出实现。集成审查补齐内嵌图片与远程图片合计20 MB的限制，并用混合图片回归验证超额时不生成最终下载文件。

## 当前本机部署（2026-10-04）

集成包已通过受控冷启动，固定监听 `127.0.0.1:4000`，活动指针已切到下述包。启动审计为本机忽略目录 `output/playwright/local-release-audit/controlled-restart-1791111748983-19472`，包含一致性备份、完整进程身份及检查结果。2账号/12订阅/1450文章与启动前备份逐字段一致，SQLite quick_check=ok。定时更新继续关闭，来源凭据、绑定、目录开关和旧停止记录不变；未点击取文或刷新。

原阻点为 Windows TCP 状态字段异常：自有回环监听的 CIM 原始状态为0，原生 TCP 行也观察到0/2/6；netstat查无该行，不能归因于文字编码。底层系统原因未确定。启动器改用微软支持的 [GetExtendedTcpTable](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable) 的专用 `TCP_TABLE_OWNER_PID_LISTENER` 表，由 Windows 选择监听端点，再核本地端口、地址和归属PID。它不会把ALL表的未知状态当作监听，也不以HTTP成功代替归属检查。Process句柄、创建时间、程序路径、命令行和停止预期身份保护均保留；API失败仍拒绝启动或停止。

新增Windows原生回归2项通过，覆盖IPv4/IPv6、同端口已连接端点排除、客户端端口排除、关闭端口、外来PID、时间/路径/命令行错配拒绝以及完整匹配的自有进程停止。运行策略/就绪/依赖闭包16项再次通过；CI增加独立Windows回归。只修改仓库外层受控启动器，包内应用、运行策略和导出代码不变，因此复用完整性已核包。应用源码对应集成提交 `68aa31f39c5de6fd5b462beedddd005f5ee2127d`（原始清单的换行差异见下文），外层启动器对应本次修补提交。

## 集成验证结果与产物

- 组合服务端完整回归37 suites/503 tests通过，含原刷新路由、SQLite去重与旧正文保护、工具安全入口和原导出行为。服务端构建、前端类型检查/构建及ESLint通过；部署运行策略/就绪/依赖闭包16项测试通过。
- 固定部署包：`.local-releases/2026-10-04T10-18-17-755Z-213913c1bd74`，源码输入哈希 `213913c1bd7475ce5b23f3309705279e8fb25d1d32f426baa1bf86c7e434e6df`。包内固定Node.js 24.11.1、Prisma Client 5.10.1及已核同一引擎、264项依赖、13294个清单文件；当前schema，无桌面采集helper。清单包含Windows原始输入字节，Git会归一化CRLF；集成提交仅另加文档及归一化换行，不改变已构建逻辑。
- 包完整性`verify`返回`integrity=ok`；固定Node执行`probe`在一致性SQLite副本上返回`runtime-verified`、12订阅/1450文章、pending为空，实际Prisma引擎哈希与清单一致。受控生产启动也重新核验包、schema和一致性备份。
- 生产库只读核对2账号/12订阅/1450文章、quick_check=ok；启动后全部账号、订阅和文章字段与启动前备份一致，未改变来源凭据或绑定。
- 下载分支原先已通过合成浏览器ZIP下载、解压后断网HTML/PNG验收。本轮组合重新执行上述全量测试与构建；真实微信链接、当前官方账号的实时最新10篇尚未验收。不能把合成结果、已有40篇目录或1篇历史正文图片称为订阅恢复。

## 部署步骤（已完成一次受控冷启动）

在项目根目录执行包完整性检查，不读取账号或启动服务：

```powershell
& '.\.local-releases\2026-10-04T10-18-17-755Z-213913c1bd74\runtime\node.exe' '.\.local-releases\2026-10-04T10-18-17-755Z-213913c1bd74\runtime.cjs' verify
```

实际部署前，单一集成者须确认私有运行配置可正常读取，保持现有登录设置和来源停止；不要直接按缺少定时禁用项的源码`.env`启动。当前schema沿用受控冷启动器，它实时检查端口、schema、一致性备份和数据基线；不调用旧schema的`switch.cjs`。4000仍空闲时，部署命令如下：

```powershell
$env:ENABLE_SCHEDULED_UPDATES='0'
$env:DISABLE_SCHEDULED_UPDATES='1'
node scripts/local-release/restart.cjs --mode start --production --release .local-releases/2026-10-04T10-18-17-755Z-213913c1bd74 --database apps/server/data/wewe-rss.db
```

受控运行固定监听 `127.0.0.1:4000`，上述环境值优先于配置文件，定时更新保持关闭。如果届时4000已有监听，冷启动器拒绝启动；需要重启时必须先取得该进程的实时身份，再用`--mode restart`及对应`--expected-*`参数，不能复用旧PID。此包不包含账号凭据，不能独立拷走就获得现有账号。

构建、完整性检查和本轮离线测试均不执行微信平台抓取。按上述手动模式启动不主动取文；用户之后点击文章下载会发起一篇公开文章及其图片请求，限制/验证/跳转或图片失败则停止。原刷新仍受既有账号归属、停止和私有来源配置保护；`wereadDirectoryEnabled`生产未启用，只有选定当前官方网页账号的受支持可重复读取通路核实后才能启用。不得靠开关、重放认证头或绕过浏览器停止来补这个缺口。

## 后续验收

独立工具需要一条用户选定的具体文章链接来验收真实正文与图片；订阅需要当前官方账号的安全可重复实时来源，再以原按钮核最近10篇、再次去重和后续新文。账号选择已明确，不再询问或要求手工收集10篇。本机启动成功不等于这两项真实平台验收已完成。
