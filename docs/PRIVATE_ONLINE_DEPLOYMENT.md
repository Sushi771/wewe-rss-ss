# 私人线上部署操作卡（尚未执行上线）

> **已暂停的历史方案。** 2026-09-29 用户将主线改为可自行维护的微信读书订阅模块，暂停 Wechat2RSS 采购及部署。下文服务器选择、授权和扫码步骤仅保留前轮设计证据，**不是当前待办或购买建议**；当前执行入口见 [自主管理订阅任务](PRIVATE_ONLINE_DELIVERY_TASK.md)。待真实取文能力通过首轮验收后重新确定部署方案。

本配置选择 **DigitalOcean Basic Droplet 2 GiB / 1 vCPU / 50 GiB，Ubuntu 24.04，Singapore**。主应用和 Wechat2RSS 在同一台机器的 Docker Compose 中运行，两个持久化目录分别为 `private-data/sqlite` 与 `private-data/wechat2rss`。应用的正文图片作为 data URI 存在 SQLite 中；按号 ZIP 下载包含相对路径附件。只有主应用的本机 4000 与上游的本机 18080 映射到 `127.0.0.1`，数据库没有网络端口。

访问采用 Tailscale Personal 私人 tailnet 的 HTTPS Serve，不需要另购域名，也不开放 80/443 公网端口。本人及配偶在自己的设备上加入 tailnet，浏览器打开 `https://<服务器名>.<tailnet>.ts.net/dash/` 后输入应用登录码。`tailscale serve --bg 4000` 会在重启后恢复。**不要使用 Funnel**；上游管理页只在服务器本机，首次扫码可用 SSH `-L 18080:127.0.0.1:18080` 临时打开。Tailscale 登录不替代应用会话：RSS、正文 API、图片和 ZIP 同样需要应用会话 cookie。

官方价格核对（2026-09-29）：[Droplet 2 GiB 为 $12/月，周备份为主机价的 20%](https://www.digitalocean.com/pricing/droplets)，合计约 **$14.40/月**，税和汇率另计。 [Tailscale Personal 对六名以内个人用户免费](https://tailscale.com/pricing)。[Wechat2RSS 私有授权为 ¥15/月或 ¥150/年](https://wechat2rss.xlab.app/deploy/)，属于用户另行办理的软件授权。没有进行任何购买。

## 用户当前最少动作

1. 本人决定并购买上述一台 Droplet，启用周备份和 SSH 密钥；将服务器公开 IP 或 SSH 主机别名告知执行代理，私钥不要发到聊天。云控制台账户授权由本人完成。公网防火墙只留本人可用的 SSH 入口，应用与上游端口不用公网开放。
2. 本人取得并阅读 Wechat2RSS 个人授权，把邮箱、激活码只填到服务器 Git 忽略的 `.env.private-online`，不要发到聊天。该文件还需两个独立的随机值 `AUTH_CODE`（至少 24 字符）和 `PRIVATE_UPSTREAM_TOKEN`，由部署代理在服务器本机生成并设置 0600 权限。
3. 本人注册/登录 Tailscale Personal，在服务器登录 tailnet、启用 MagicDNS/HTTPS，自己的浏览器设备加入 tailnet；配偶使用时再邀请。首次上游启动后本人在 SSH 本地端口转发打开管理页并扫码。只有本人处理购买、账户授权、软件协议、扫码/验证码。

## 执行代理在服务器上完成

按 [Docker 官方 Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/)安装 Engine 与 Compose 插件，按 [Tailscale Linux 文档](https://tailscale.com/docs/install/linux)安装 Tailscale 并由本人完成浏览器账户授权。克隆仓库到仅部署用户可访问的目录，复制 `.env.private-online.example` 为 `.env.private-online`，在私有文件填入上述值、实际 `SERVER_ORIGIN_URL`，初次保持 `WECHAT2RSS_ENABLED=0`。勿执行会回显秘密的 `docker compose config`，勿公开原始上游日志。

先在本地 SQLite 一致性副本完成真实上游导入验收。然后复制已核验备份到 `private-data/sqlite/wewe-rss.db`，再执行 `bash scripts/private-online/deploy.sh`。脚本先构建、对现存库执行在线一致性备份和上游短暂停机备份、停应用、迁移、启动。之后 `tailscale serve --bg 4000` 并用 `tailscale serve status` 和浏览器验证 HTTPS 入口。通过真实上游验收前仍保持采集开关关闭；切换时再次备份并按单号逐步启用。

可把 `bash scripts/private-online/backup.sh` 安排为每日 systemd timer。SQLite 在线备份写入 `private-data/sqlite/backups`，上游压缩包写入 `private-data/backups`；DigitalOcean 周备份将这些文件与服务目录一起保存到云端。恢复时先停止应用和上游，从可信备份还原 SQLite 与上游数据，验证 `PRAGMA quick_check=ok` 和订阅/文章数量，再运行部署脚本迁移并启动；先在隔离副本试恢复。单纯的云磁盘快照不能替代 SQLite 在线一致性备份。

## 未完成的真实验收

目前没有服务器、域名、WeChat2RSS 授权或登录实例；上述配置未经目标 Linux 机器启动验证。JSON Feed、RSS、`/api/query` 的真实字段及“妈妈部落畅聊阁”五篇正文与图片待本人授权/扫码后测试。12 个旧订阅逐号状态、新文章增量、线上重启和浏览器 ZIP 下载均待真实部署核验；订阅前全史、非群发、停机缺口单独记录。
