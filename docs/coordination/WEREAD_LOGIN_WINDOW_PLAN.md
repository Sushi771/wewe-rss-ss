# 官方微信读书可见登录窗口：Windows 一次性启动预案（2026-09-30）

## 已完成的离线预检

本机标准安装位置可找到签名有效的 Microsoft Edge `154.0.4258.37` 与 Chrome `154.0.8037.57`；本轮检查时本机 `9222/9223` 均无监听，Edge/Chrome 未配置覆盖 `UserDataDir` 或禁用远程调试的策略。此前 `cua.getState()` 返回 `Browsers: Error: nodeRepl.fetch request failed`，不能据此判断浏览器是否已登录。仓库已有[一次 Web 搜索代理 POST 探针](../../scripts/research/probe-web-search-broker.cjs)和[一次官方搜索页滚动探针](../../scripts/research/probe-weread-natural-scroll.cjs)，两者都只连接操作者明确提供的本机 CDP，不负责登录或启动浏览器。现有 [`acceptance-edge.cjs`](../../scripts/acceptance-edge.cjs)是本地产品页面验收脚本，不适合复用为微信读书登录窗口。

[Chrome 官方说明](https://developer.chrome.com/blog/remote-debugging-port)指出 Chrome 136 起默认用户数据目录不再接受远程调试开关，须使用不同的 `--user-data-dir`。[Microsoft Edge 开发文档](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server)说明 Edge 支持远程调试与 `DevToolsActivePort` 发现；[Edge 策略文档](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/userdatadir)提示策略可覆盖命令行的用户数据目录。因此[启动脚本](../../scripts/research/weread-login-window.ps1)先拒绝相关策略覆盖、无有效浏览器签名、可共享的本地资料目录，再为**单次研究会话**创建用户 `%LOCALAPPDATA%` 下的独立私有 profile；不打开或复制用户原 Edge/Chrome profile。

本轮只执行脚本 `Plan`（Edge 和 Chrome）、`SelfTest` 及 `Status` 的无会话失败分支：两种浏览器均返回可准备，离线门禁通过 **8** 项检查，无会话时状态查询安全停止；**浏览器启动 0、登录页打开 0、profile 写入 0、目标请求 0**。本轮没有运行 `Start/Stop` 或 `Status` 的真实会话路径，没有扫码、读取 Cookie/本地存储、保存会话或访问目标搜索接口。`Plan` 不创建目录，且预检后研究 profile 根目录仍不存在。离线结果只证明启动条件与部分脚本逻辑，不证明实际浏览器会话和官方登录可用。

## 本人操作时的最小流程

待总控安排实际在线实验后，操作者可在可见交互的 Windows 桌面依次执行：

```powershell
pwsh -NoProfile -File scripts/research/weread-login-window.ps1 -Action Plan -Browser Edge
pwsh -NoProfile -File scripts/research/weread-login-window.ps1 -Action SelfTest
pwsh -NoProfile -File scripts/research/weread-login-window.ps1 -Action Start -Browser Edge
```

`Start` 仅打开固定官方首页 `https://weread.qq.com/` 的**可见**浏览器窗口，采用新随机 profile、`--remote-debugging-address=127.0.0.1`、`--remote-debugging-port=0`，不使用默认浏览器 profile，也不自动扫码。本人在该窗口按官方流程完成登录；会话失效时由本人在同一窗口正常重新登录。脚本只读 `DevToolsActivePort` 的**第一行端口号**，核对监听均为 IPv4 `127.0.0.1` 后才输出 `http://127.0.0.1:<动态端口>/`；它不读取文件中的 WebSocket 标识、标签页内容或任何 Cookie/Key。若 Edge 不可用，可把 `-Browser` 改为 `Chrome`，但同一时刻只允许一个被脚本记录的研究会话。

登录后的 `-Action Status` 只核对本机进程与回环监听，显示 CDP 地址，**不能证明已登录**。操作者需在可见官方页面确认登录。随后总控按各探针原有门禁分别决定是否执行：直接代理探针最多一次目标准确号名 POST；自然滚动探针要求已打开并确认官方目标搜索首屏，只做一次浏览器 wheel。启动脚本自身不打开搜索页、不发送查询、不运行这两个探针。官方验证、限频或异常出现即按各探针的停止规则结束，不换 profile 规避限制。

结束时执行：

```powershell
pwsh -NoProfile -File scripts/research/weread-login-window.ps1 -Action Stop
```

`Stop` 仅对记录的、可核实命令行含本次随机 profile 的可见浏览器进程尝试正常关闭；若窗口未关闭，会要求本人先手动关闭再重试。确认没有使用该 profile 的浏览器进程及 CDP 监听后，才检查绝对路径属于脚本创建的私有父目录、各级父目录不是重解析点，删除此单次 profile 与不含凭据的会话标记。启动后若端口或进程校验失败，脚本保留会话标记并停止后续探针；先关闭可见窗口，再运行 `Stop` 清理。若启动在会话标记写入前失败而留下空的私有目录，须由本人核对窗口和目录后手动清理；不得猜测目录名或让脚本批量删除。清理前不得把 CDP 地址暴露给其他程序。

CDP 虽只监听本机回环，但**本机其他进程仍可能控制这个已登录研究窗口**。因此端口只在短时人工实验中开启，窗口单独使用，结束立即关闭并清理；不作为最终产品登录、续期或长期运行机制。不改变全局代理、防火墙、证书、系统浏览器配置，也不读取电脑微信、聊天数据库或用户原浏览器资料。在线实验仍须分别核验真实目标文章身份、原文发表时间、分页与覆盖，不能把登录成功当作订阅恢复。
