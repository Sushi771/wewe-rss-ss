# 桌面订阅首页入口（2026-10-11）

桌面主入口始终显式打开 `http://127.0.0.1:4000/dash/feeds`，同时保留 `http://127.0.0.1:18080/#/` 后台页。用户手动点单篇下载工具页仍按原路由正常进入。

真实 `WeWe-RSS.lnk` 已只读核验：目标是系统 `wscript.exe`，参数为本仓库 `scripts/local-release/launch-desktop.vbs`。VBS 与仓库 `启动WeWe-RSS.bat` 共用 `desktop-start.cjs`。根因是该文件把单篇下载工具页硬编码为默认 URL；无独立的环境变量首页覆盖、激活旧工具标签逻辑或前端恢复工具路由重定向。前端 `/dash` 的 index 和 `/dash/feeds` 均为订阅列表，工具页路由保留。

修复统一桌面 URL、已有服务首页就绪探测、启动基准探测及浏览器失败时的手动访问提示。Edge 分支每次传入首页及后台两个完整 URL；Explorer 回退分别打开两页。复用已有服务仍执行相同显式 URL 打开，避免只激活恢复的旧工具页。沿用原启动锁：启动期间重叠点击只由锁持有者开一次双页；启动完成后的再次点击重新请求首页。未新增浏览器会话参数或修改全局设置。

验证：

- `desktop-home-entry.test.cjs`、`desktop-progress.test.cjs`、`desktop-dependencies.test.cjs` 共 41/41 通过。覆盖默认首页、显式运行环境配置保持、Edge/Explorer 双分支、已运行/新启动服务、从工具页再启动、三次重叠点击和后续再次点击。浏览器状态由测试替身记录，不能据此声称真实窗口已目视。
- 沙箱默认临时目录的进度文件 rename 曾报 EPERM；仅将测试进程 `TEMP`/`TMP` 指向获准的 `C:\Users\ss\AppData\Local\Temp` 后完整通过。
- 本机只读 HTTP：4000 `/dash/feeds` 与 18080 `/#/` 均返回 200，无重定向。
- 单独调用实际 `openBrowser()`，确认浏览器进程成功接收上述两页 URL；未调用启动主流程，未重启任何服务。
- CUA 读取窗口失败：`CreateProcessInSandbox` error 203。未实际目视首页、后台或恢复标签的最终选中状态，需统一负责人完成视觉验收。

本线程未提交、推送、部署或重启，未修改用户的 `docs/DEVELOPMENT_HANDOFF.md`；脚本 `available` 进度生命周期改动属于启动校验线程，已保留。交统一负责人整合。
