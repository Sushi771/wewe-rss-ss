# 私人线上交付：当前精简交接（2026-09-29）

## 接手事实

- 当前执行入口是 [私人线上最终交付任务](PRIVATE_ONLINE_DELIVERY_TASK.md)，不是旧的本机 Docker/公司多人阶段任务。设计背景仍见 [Provider 设计](SUBSCRIPTION_PROVIDER_DESIGN.md)。本轮从干净的 `main` / `6cf3b1c` 开始，接手时远端 `main` 同一提交；下次接手必须重新查工作区与远端，不能假定此值仍最新。
- 本机实际生产库 `apps/server/data/wewe-rss.db` 只读核对 `quick_check=ok`，12 个订阅、1447 篇文章、44 篇缓存正文；`provider_refresh_attempt_time` 列尚未进生产。没有生产写库、服务切换或真实上游请求。
- 用现有在线备份脚本生成一致性备份，报告 `integrityCheck=ok`、12/1447、SHA-256 已核对；备份仅在 Git 忽略的 `output/subscription-implementation/backups/`。又从生产 SQLite 在线复制隔离库，应用新增迁移后比较 `feeds` 和 `articles` 所有旧列逐行摘要，完全一致、`quick_check=ok`。隔离库额外加入一篇测试文章用于 ZIP 验收，绝非真实上游文章。
- 用户已明确：**没有现成服务器或域名，也尚未取得 Wechat2RSS 授权**。本机 `.env.wechat2rss` 的授权邮箱/激活码为空；私有实例未启动、未扫码。Windows 旧配置保留，WSL/Docker 不再是当前部署前置。当前窗口实际模型/思考设置无可查询的已应用值，记为未核实。

## 本轮实现与验证

- 新增 `PRIVATE_ONLINE_MODE=1`：至少 24 字符登录码换取 HttpOnly、Secure、SameSite 严格会话 cookie，匿名 RSS、文章 API、图片代理、ZIP 下载和私有页面被挡住；登录页/静态资源可加载。线上禁用旧微信读书账号管理/登录接口，不把上游凭据交给普通站点使用者。
- 新增 `GET /download/feed/:id.zip` 与“下载本号 ZIP”：浏览器得到附件响应，Markdown 引用相对路径 `attachments/` 图片；每号 `README.md` 明示完整/未完整数。只有有缓存正文且附件成功落地的篇目计为完整；旧库很多正文缺失，不能宣称全部可离线阅读。线上隐藏旧服务器目录导出入口。
- Wechat2RSS Provider 在保存正文前受限下载并内嵌允许的图片，图片失败则保留旧正文、新正文标为缺失以便重试；容器网络的固定服务名 `wechat2rss` 纳入私有地址校验。真实上游字段、图片和目标号仍待实测。
- 新增单机 Docker Compose 线上配置：主应用与固定 digest 上游分别持久化，只绑定 `127.0.0.1`；Tailscale Serve 提供私人 HTTPS。部署脚本在迁移前备份并停应用；备份脚本对 SQLite 在线备份、上游数据短暂停机归档。本机无 Docker；GitHub Actions 的 `private-image` 已成功构建 `Dockerfile.private-online`，尚未做容器运行验收。
- 选定一台 DigitalOcean Basic 2 GiB / 1 vCPU / 50 GiB Ubuntu Droplet（Singapore）+ 周备份，官方价约 $14.40/月，税另计；Tailscale Personal 免费、无需域名，WeChat2RSS 个人授权官方 ¥15/月或 ¥150/年。见 [部署操作卡](PRIVATE_ONLINE_DEPLOYMENT.md)。尚未购买或部署。
- 本机 HTTP 验收使用迁移后的隔离库和测试文章：匿名内容路由 401、私有页 302 登录、错误登录 401、成功登录后 RSS 200、ZIP 200；下载的 47 MB ZIP 经过解压检查，570 个条目中 157 个 Markdown 图片引用对应 ZIP 内相对路径文件。所选旧号 195 篇中 28 篇离线完整、167 篇明确标未完整（含一篇测试夹具）。这仅证明副本上的下载与保护链路。
- 服务端完整 Jest **18 套 / 148 项通过**，服务端与网页构建、两端 lint、格式与 Git diff 检查通过。隔离库上的本机 HTTP 验收在服务重启后复测，六类匿名入口被拒、旧账号接口 403、RSS 200、ZIP 200。首轮 GitHub CI 的私有镜像构建成功；`lint-test` 在测试启动前因工作流误写 pnpm 命令行参数而失败，现已改为 `pnpm --filter server exec jest --runInBand`，待新一轮核实。

## 下一步

1. 推送 CI 命令修复，核对远端 HEAD 与完整 CI；若 Linux 上真实测试再暴露失败则修复并复测。无 Docker 本机不能把镜像构建成功称为容器运行成功。
2. 用户本人购买一台上述服务器并启用周备份，取得合法私人授权；本人登录 Tailscale 并在上游启动后扫码/处理验证码。不要要求在聊天粘贴密钥或激活码。其余 SSH、Docker、部署、备份、联调由代理继续执行。没有这些条件，不能提供真实线上入口或声称订阅恢复。
3. 私有实例可用后先核对同一目标号“妈妈部落畅聊阁”至少五篇不同真实文章的身份、时间、正文、图片；比较 JSON Feed/RSS/`/api/query` 的实际字段。再在 SQLite 一致性副本验收真实导入、重复更新、旧字段保护、离线 ZIP 和重启。通过后重核生产备份，受控迁移到服务器并按单号启用；覆盖第二号和全部旧订阅、定时与重启。
4. 上游任务受理、已有缓存、新文章增量分别记录；订阅前全史、非群发和停机缺口独立记录。没有自然新文时标待验。只剩购买/授权/扫码外部条件时保存检查点，不创建空转后继任务。
