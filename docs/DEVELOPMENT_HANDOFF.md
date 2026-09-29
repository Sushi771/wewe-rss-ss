# 公众号订阅恢复：当前精简交接（2026-09-29）

## 当前工作区与数据

- 仓库 `C:/Users/ss/.gemini/antigravity/playground/sparse-comet/wewe-rss-ss`，分支 `main`。设计基线 `2429a7401716a25f07cca9a3ecff806a20019a12`；本轮从干净的 `165f3ad0c4fdd9eb4b018744f3c166495caa5d5f` 继续。接手以 `git rev-parse HEAD`、远端和新 CI 实测为准。
- 上一实施轮从干净的 `61c3372` 继续。生产 SQLite **只读**核对 `quick_check=ok`、12 个订阅、1447 篇文章；没有生产迁移、写库或服务重启。用 SQLite 在线备份建立临时副本，应用 `provider_refresh_attempt_time` 加性迁移后，`feeds` 和 `articles` 的原有列逐行摘要、数量与完整性检查均保持不变；临时副本已清理。正式上线仍须重新核验一致性备份与实际路径，并先在副本跑完整导入流程。
- Windows 11 专业工作站版 Insider Preview build 26340，AMD Ryzen 7 5800H，内存约 15.4 GB，C 盘剩余约 232 GB；固件虚拟化已开启，Windows 报告已检测到 hypervisor。WMI 的 SLAT 字段为 false，但 `systeminfo` 因已检测到 hypervisor 不显示 Hyper-V 要求，是否满足 Docker 实际启动条件须待 WSL 2 安装后验证。`LanmanServer` 运行且自动启动。本会话非管理员，查询 Windows 可选功能需要提权而未执行；`wsl --status/--version/-l -v` 均明确报未安装 WSL。Docker CLI、Docker Desktop 程序与服务均未发现；本机 18080、8080、3000 无监听。
- 已准备 Git 忽略的根目录 `.env.wechat2rss`：`LIC_EMAIL`、`LIC_CODE` 留空待用户本人填写（邮箱须全小写），`RSS_HOST=127.0.0.1:18080`，`RSS_TOKEN` 本机生成 256 位随机值；`apps/server/.env.local` 已设置 `WECHAT2RSS_BASE_URL=http://127.0.0.1:18080` 与对应 `WECHAT2RSS_TOKEN`，原有配置保留，默认采集开关仍关闭。已创建被 Git 忽略的 `.wechat2rss-data/`；这三处 ACL 仅保留当前用户、SYSTEM、管理员。已跟踪的 `apps/server/.env` 未改。`docker-compose.wechat2rss.yml` 固定官方镜像 digest、仅绑定本机 18080、持久化到独立数据目录；YAML 已静态校验，尚未用 Docker 启动、未授权、未扫码、未验证真实目标文章。
- 当前窗口运行模型与思考深度没有可查询的已应用设置，记为**未核实**。

## 已实现与已验证

- `f6ec517` 已加入显式 Wechat2RSS Provider、默认关闭开关、链接添加和手动/批量/定时入口；JSON Feed 仅为候选输入，真实字段仍待验。旧来源不会隐式执行。正文和图片清洗、SQLite 受保护导入、原有 RSS/Markdown/Obsidian 导出保留。
- 本轮新增 `feeds.provider_refresh_attempt_time`：手动 `/add` 在请求前原子占用每号 15 分钟冷却，失败及进程重启后仍生效；定时任务仍只读上游缓存。已有 `syncTime` 只在取得并写入可核验的非空缓存页后推进，不能代表上游异步任务完成。缓存为空且处于冷却期显示 pending，不将任务受理称作文章归档。
- 隔离 SQLite 回归覆盖重启后抑制重复 `/add`、冷却到期可重试、失败不推进成功时间，以及经过 JSON Feed 候选解析的正文和图片写入 Obsidian 本地附件；导出会从图片 URL 路径或 `wx_fmt` 保留受支持的扩展名。它们是**模拟上游**测试，不能证明目标号实际可取。此前独立副本模拟导入 1447→1448、重复新增/更新 0、旧值不变，只证明保护路径。
- 只读联调脚本现在从 `apps/server/.env.local` 读取私有实例 URL/token；执行脚本不要求启用应用采集开关。无实例时仅验证配置存在性，不发请求、不输出 token。真实目标号及接口字段仍未验证。
- 本轮检查：Prisma generate/validate、服务端全量测试 **16 套 / 139 项通过**、服务端构建、服务端 ESLint、`pnpm fmt.check`、`git diff --check` 均通过；导出扩展名修正后相关回归 7 项再次通过。新提交/CI 以本轮最终核对为准。

## 下一具体工作单元

1. 先核对本轮 GitHub 提交、远端 `main` 与 CI。用户在**管理员 PowerShell** 执行 `wsl --install --no-distribution`，按系统提示由本人重启；该选项只安装 WSL、不安装额外 Linux 发行版。重启后验证 `wsl --version` 至少 2.1.5，确认 Windows 可选功能和 Docker 启动所需虚拟化；使用 Docker 官方 Windows x86_64 安装包选择**每用户安装、WSL 2 后端**，首次运行由用户本人阅读并接受 Docker Desktop 协议。安装/重启/协议未经用户处理前，不启动容器。Docker 就绪后运行 `docker compose -f docker-compose.wechat2rss.yml config --quiet`，先核验 18080 仍空闲，再 `docker compose -f docker-compose.wechat2rss.yml up -d`；不输出 `docker compose config` 展开的敏感环境变量，也不共享上游日志（官方日志可能显示 Token）。若私有实例仍缺，不重复旧微信读书探针；只处理发现的实际代码/部署缺陷。部署新构建前必须先在副本验证新增加性迁移，再核验生产一致性备份并运行 `prisma migrate deploy`，不能直接用新二进制读取旧 schema。
2. 实例可用后先构建服务端，再从仓库根目录运行 `node scripts/acceptance-wechat2rss.cjs --execute MP_WXS_<目标数字ID>`；脚本自动读取 Git 忽略的 `apps/server/.env.local`，不要求设置 `WECHAT2RSS_ENABLED=1`。先核验“妈妈部落畅聊阁”至少五篇不同真实文章的稳定身份、原文 URL、时区时间、正文和图片可下载性。JSON Feed 不足时比较同一实例的 RSS 和 `/api/query`，只凭真实字段选择输入。
3. 再以真实输出在 SQLite 副本验收导入、旧 ID/正文/图片/指标保护、重复更新、重启、图片离线展示和按号导出。通过后才逐号受控生产接入，并验证第二号、全部原订阅、定时触发和自然新文增量。
4. 完整历史、非群发文章及长期停机窗口缺口独立记录，不把近期缓存读取视为全史恢复。没有自然新文时增量保持待验。

## 外部动作

用户需自行取得符合个人学习研究用途的 Wechat2RSS 私有实例授权，并只在根目录 Git 忽略的 `.env.wechat2rss` 本机填写 `LIC_EMAIL`、`LIC_CODE`；不要把激活码或 token 发到聊天。项目侧 URL/token 已在 Git 忽略的 `apps/server/.env.local` 准备；`apps/server/.env` 已被 Git 跟踪，**不要把凭据写入该文件**。首次启动还需用户处理 WSL 安装所需管理员权限和重启、Docker Desktop 首次运行协议；本机管理页预计为 `http://127.0.0.1:18080`，本人到“微信账号”→“添加账号”扫码，必要时先按上游指南在微信读书完成授权。扫码后先在上游添加“妈妈部落畅聊阁”目标公众号，再执行上文只读联调。购买、扫码不由代理代做。只有这些条件缺失时，不创建空转后继任务。
