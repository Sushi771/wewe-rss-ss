# 桌面一键启动 WeWe-RSS 与既有 Wechat2RSS

点原桌面 **WeWe-RSS** 图标即可按顺序检查 Docker、启动原 Wechat2RSS 容器、等待本机首页健康，再进入原 WeWe-RSS 发布包启动流程并打开产品。此入口不添加系统开机任务。

桌面快捷方式继续指向项目目录中的稳定 launch-desktop.vbs；快捷方式无须重写。启动脚本从注册表、已有 Docker 快捷方式和 CLI 路径识别原安装位置，支持非默认安装盘。

## 启动顺序与保护

1. 使用独占锁串行处理连续点击；等待前一个启动最多 210 秒。锁覆盖依赖、WeWe 启动和浏览器打开。
2. 从原安装的注册表、桌面 Docker 快捷方式及 CLI 路径查找 Docker Desktop/CLI；实际安装位置只记录在本机私有验收证据中。仅访问本机 `dockerDesktopLinuxEngine` 命名管道，不使用远程 Docker 环境覆盖，不切换 context。
3. 引擎未就绪且原 Desktop 未运行时启动原程序，最多等待 120 秒。已启动中的 Desktop 只等待，不再创建启动进程。
4. 从被 Git 忽略的 `private-data/desktop-start/container.json` 读取本次核实的原容器完整 ID 和固定镜像身份。必须只有一个标记为 `wechat2rss` 的容器，且名称为 `wewe-rss-ss-wechat2rss-1`、Compose 项目为 `wewe-rss-ss`。核对 `127.0.0.1:18080->8080` 和原 `.wechat2rss-data:/wechat2rss` 可写绑定，并确认本机原 `res.db` 存在且非空、目录和数据库未被链接替换。
5. 原容器已运行则复用；停止时只对已核实的完整 ID 调用 `docker start`，且先确认 18080 空闲。暂停、重启循环、身份/镜像/挂载不符或端口冲突均停止。没有 `compose up`、创建、拉取镜像、更新、清库、重建或迁移逻辑。
6. 最多等待 60 秒，仅读本机无认证的 `/` 首页，须 HTTP 200 和 HTML 类型；再次确认原容器仍运行。此健康门只证明本机服务就绪，不证明授权、账号登录或文章抓取成功。
7. 调用原 `startAtLogon()`，沿用发布包、SQLite、4000 监听进程身份和数据保护。端口被其他程序占用时不杀进程。桌面启动继续关闭定时更新；打开原产品地址 `http://127.0.0.1:4000/dash/tools/article-download`。

## 检查与日志

```powershell
# 离线状态机测试：不访问 Docker 或平台
node --test scripts/local-release/desktop-dependencies.test.cjs

# 只核已运行复用路径，不启动 Docker、容器或 WeWe，不打开浏览器
node scripts/local-release/desktop-start.cjs --check --reuse-only

# 普通入口的无浏览器检查：可能启动原有依赖及 WeWe
node scripts/local-release/desktop-start.cjs --check
```

日志仅记录状态、安全错误码、时间、运行包 ID 与 PID，写入 Git 忽略的 `output/playwright/local-release-audit/desktop-start.jsonl`。失败时隐藏包装器显示中文说明，安全详情在同目录 `desktop-start-error.txt`。不复制 Docker 原始 stderr、inspect 环境、凭据或响应正文到日志。

## 失败恢复与回滚

- Docker 超时：手动打开原 Docker Desktop，待原引擎正常再点图标；不改网络、安全策略、数据路径或安装软件。
- 容器身份/数据不符：让维护者核对原实例和原挂载，恢复原记录；不自动重新绑定新 ID，不重建许可实例。`container.json` 是本机身份记录，不是授权密钥；恢复时核原容器完整 ID 和镜像，不把数据库/环境文件提交 Git。
- 18080/4000 冲突：维护者核占用来源，启动脚本不会停止占用者。
- `LAUNCH_BUSY`：先等已有启动任务完成。若确认启动任务已退出且没有新的启动任务，在维护者协调下将 `desktop-start.lock` 移至备份目录再点击；不要在启动中移除锁。崩溃锁不自动清理，以避免并发启动或 PID 复用误判。
- 应用已就绪但浏览器失败：手动打开上面的产品地址。
- 回滚：本次修改前脚本及原快捷方式已备份到被 Git 忽略的 `private-data/desktop-start/backup-20261010/`。确认没有启动任务运行后，从备份还原 `desktop-start.cjs`、`launch-desktop.vbs` 即恢复原启动行为；不需要重启或停止正在运行的服务。快捷方式未改，备份可供核对。保留原数据库、容器和所有私有配置。

## 本轮验证范围

已通过离线状态机 23 项及 Windows WSH 包装器离线替身测试 1 项；实际安装发现与仅复用原运行容器的依赖检查通过。WSH 测试第一次因沙箱拒绝临时目录 junction 而失败，在正常权限下同一离线测试通过。未停止生产、未模拟冷启动、未强制重启电脑、未安装软件、未触发平台登录或取文请求。

完整入口 `--check --reuse-only` 实测通过，复用运行包 `2026-10-10T05-53-44-732Z-d110b28b24bf`、PID 46176，Docker 依赖与应用状态均为 `already-running`，耗时约 7.24 秒，未打开浏览器、未启动或停止服务。当前运行包和 PID 会随后续发布变化。

真正电脑重启后，由用户点击原图标确认 Docker、原容器、WeWe 和浏览器依次就绪；真实登录、文章、图片和更新验收由产品任务分别记录。

后续接入小红书时，桌面入口只检查选定来源确实必需的服务；失败显示具体原因，不隐性改用其他来源。当前候选只接已有 Wechat2RSS 本机依赖，没有启用小红书服务或新增凭据配置。统一的项目内订阅、账号状态和下载原则见 [账号接入说明](WECHAT2RSS_ACCOUNT_LOGIN.md#后续小红书接入原则)。

集成审查补充：桌面入口不再预先覆盖 ENABLE_SCHEDULED_UPDATES/DISABLE_SCHEDULED_UPDATES，保留已经批准的私有日程配置。真实入口函数的离线回归覆盖此边界，最终状态机回归为24项；实际服务复用及WSH包装已通过，真正停止后的冷启动仍未执行。
