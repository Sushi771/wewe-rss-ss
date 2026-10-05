# Windows 桌面快速打开（2026-10-05）

桌面 `WeWe-RSS` 图标打开原文章下载工具。已有服务时复用当前实例；没有服务时调用既有受控启动，不安装依赖、不构建、不迁移数据库。原 `启动WeWe-RSS.bat` 和 `--check` 保留，使用同一个入口。

## 当前交付边界

本次从提交 `2900d20f0bc049832f28ddcc021e0ed5889cbd7c` 的独立 worktree 开发。没有部署生产、重启 4000 或向真实腾讯接口发请求；真实桌面快捷方式由唯一整合 owner 在稳定目录创建。当前在线实例只读核对为包 `2026-10-04T22-46-13-841Z-7b0afbf5c3cf`，PID 13256。版本/PID 均是测量时状态，整合前须重新核对。

## 为什么原入口很慢

原 `logon-start` 先逐字节校验完整发布包，再判断是否已有服务；构造预期命令行又重复完整校验。包有 13,303 个文件，其中 13,208 个是依赖文件。首轮单次全包校验 63.721 秒；同轮完整热启动路径的两次校验为 179.005 和 100.056 秒，Port/Snapshot 为 2.601 和 2.863 秒，共 284.525 秒。磁盘缓存及扫描负载会造成明显波动。

新热启动先在一次 PowerShell 调用中取得监听 PID、句柄/创建时间、CIM 创建时间、程序路径、命令行，并复核监听归属。随后核当前指针、Node/启动代码、应用代码及页面资源，匹配当前数据库和完整预期命令行，再探活本地工具页。此路径不会执行新的服务器代码，无需重新读完整依赖包。

最终热检查三次为 **5.821、6.272、4.477 秒**，中位数 5.821 秒；包含本地页面探活，未包含浏览器从请求打开到用户可见绘制的时间。这是“分钟降到数秒”，不是一秒保证。浏览器没有改用更慢的路径：优先检查 x86/x64 安装位置的 Edge，以固定参数启动；缺失时由 Explorer 打开系统默认浏览器。

浏览器独立测量：现有 x86 Edge 的全新 headless 实例启动 **0.791 秒**，本地工具页到输入框可见 **0.908 秒**。两项单独测量，不能直接称为桌面可见窗口端到端时间。测试仅放行本地 GET，拦截 2 个外部页面请求，未点击保存/刷新/登录；实际工具页截图留在忽略的 `browser.png`，不提交 GitHub。浏览器路径和原 300ms 探活轮询没有造成分钟级延迟。

## 冷启动如何复用已验证产物

`verifyRelease` 默认仍执行完整 SHA256 核验，用于部署、审计及显式 `verify/probe`。启动路径允许复用 `.local-releases/.verification-cache/` 下成功核验的记录，记录绑定真实发布目录、清单哈希和校验器代码哈希。每次复用仍遍历目录，核对所有文件/目录的 dev、ino、mode、size、mtimeNs、ctimeNs，以及链接真实目的地。首次、清单/校验器变化、记录损坏或任意元数据/文件集合变化都会回到完整字节核验；不一致则拒绝启动。首次核验前后还核对元数据，变动时不生成记录。

部署/激活成功时预先建立记录，后续点击无需重读整个依赖包。记录是当前用户可信本地目录内的启动优化，不能替代制品签名或防御同权限恶意改写。发布包应保持不可变；不要手工改包内文件，不要把缓存、数据库或凭据提交仓库。

数据库一致性检查、备份、schema 校验、固定 loopback、定时关闭、占用端口拒绝、受控启动标记、模块不得越出包目录、RSS 就绪检查均保留。遇外部条件或未通过检查时显示错误并保留本地日志，不为提速放行未知 PID。

冷启动副本实测：原受控 controller **165.712 秒**，复用已核产物后的 controller **64.736 秒**。两者包含一致性备份、schema/字段检查、实际应用启动、RSS 就绪和精确身份核验；不含入口前置的进程查找/启动文件检查和浏览器打开时间。首次建立新包记录仍需完整核验，实测 180.424 秒；后续单次复用核验为 6.670 秒，不能把这一步称为完整冷启动耗时。冷启动仍需几十秒，不承诺一秒。

比较使用当前实际应用包的隔离副本，只替换本次 `runtime.cjs/lib.cjs` 并生成对应清单；没有安装依赖或重编未改动的应用。隔离端口 11206，前后冷启动的 offline guard 均为 blockedNetwork=0、blockedChildren=0，数据库副本全旧字段检查通过；生产 PID/创建时间保持不变。原始测量保存在独立 worktree 的忽略目录 `output/playwright/launch-benchmark/1791168725583/measurements.json`，最终热测量另存 `warm-final.json`。

## owner 整合与安装

1. 将本次提交整合进稳定 checkout。仅更新启动脚本即可改善正在运行的实例的热打开。
2. 冷启动复用要求发布包内的 `runtime.cjs/lib.cjs` 也包含本次代码。依照既有构建、核验、数据库副本演练及受控部署流程生成并部署新包；不要直接改当前运行包的字节，不要在本次任务中自行重启生产。
3. 在稳定项目根目录执行：

```powershell
node scripts/local-release/install-desktop.cjs
```

安装器通过 Windows `DesktopDirectory` 已知文件夹位置解析实际桌面，兼容 OneDrive 重定向。它创建 `WeWe-RSS.lnk`，指向稳定目录的 `launch-desktop.vbs`，图标来自原 `assets/logo.png` 转换的多尺寸 `assets/wewe-rss.ico`。同名其他快捷方式拒绝覆盖；同项目同入口快捷方式可重复安装。临时 worktree 默认拒绝安装到真实桌面。

双击图标由 WScript 隐藏窗口调用固定安装的 Node，并隐藏服务器子进程窗口。没有 Electron/Tauri、开机启动任务、管理员权限要求或系统安全设置改动。若系统禁用 Windows Script Host，保留 bat 作为兼容入口，由 owner 报告实际外部条件。

只检查而不打开浏览器：

```powershell
node scripts/local-release/desktop-start.cjs --check
```

成功/失败及启动耗时记录在 `output/playwright/local-release-audit/desktop-start.jsonl`；原 `logon-start` 审计入口保留。失败时 bat 保留错误窗口，桌面入口显示本地日志位置。

## 回归与测量

```powershell
node --test scripts/local-release/launch.test.cjs scripts/local-release/process-identity.test.cjs scripts/local-release/runtime-policy.test.cjs scripts/local-release/readiness.test.cjs
node scripts/local-release/benchmark-launch.cjs --baseline-ref 2900d20f0bc049832f28ddcc021e0ed5889cbd7c --release <已核当前包绝对路径> --database <当前数据库绝对路径>
```

测量脚本只读核对真实热实例；用 SQLite 在线一致性备份及既有 offline guard，在隔离临时端口运行前后冷启动。基线 controller 放在较短 Temp 目录，避免 Windows MAX_PATH；生产 4000 始终不停止。输出、数据库副本、备份和守卫证据均在忽略的本地目录，不提交 GitHub。

已通过热路径启动/应用/页面篡改拒绝、缓存同尺寸改写并恢复 mtime、增删文件、清单变化、记录损坏、越界链接、监听归属/创建时间/精确停止、临时桌面快捷方式身份与图标、私有 RSS 就绪及定时策略回归。CI 新增 Windows 和 Linux 启动测试入口；远端结果须按最终提交精确核对，不能用此前 CI 代表本次通过。
