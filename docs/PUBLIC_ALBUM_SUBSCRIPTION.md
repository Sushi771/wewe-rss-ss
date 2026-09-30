# 腾讯官方合集订阅操作卡

当前来源覆盖**绑定的官方合集**。公众号同一 feed 中的旧文章保留；其他合集、合集外文章、全号历史与自然新增均独立验收。第三合集历史 54 键不是全号文章数；其精确入口和账本丢失时，不猜 ID 或生成导入数据。

## 构建与数据保护

仓库根目录运行 `pnpm install --frozen-lockfile`、`pnpm --filter server build`、`pnpm --filter web build`。具体依赖由 `pnpm-lock.yaml` 锁定；容器复用 `Dockerfile.private-online`，构建时禁用商业来源。服务 SQLite 是 `apps/server/data/wewe-rss.db`，凭据和原始响应只存 Git 忽略的私有目录。

先在 SQLite 在线一致性副本验收原文身份、原文 `ct`、正文、完整图片字节、重复更新及重启。旧 ID、已有正文与图片、可信发布时间、阅读与点赞等指标必须保留。离线回放真实响应证明工程与数据保护，不能代替当前在线订阅或自然新增验收。各轮证据见 [正文图片](coordination/ALBUM_BODY_ACCEPTANCE.md)、[Provider](coordination/ALBUM_PROVIDER_INTEGRATION.md)、[副本 QA](coordination/ALBUM_LOOP_QA.md)。

## 手动与定时

在既有订阅的官方合集绑定入口输入官方链接中实际给出的 `album_id`；绑定受本机管理限制。绑定成功后现有“更新本号”与定时入口都应使用持久的 `public-album` 绑定。一次更新完整拉完所选合集的真实分页，再核原文和图片后写库；挑战、跳转、频控或身份冲突立即停止，不把任务受理当取得文章。

第二次更新应报告实际 `新增 0`，已有文章不生成第二个 ID。重启后再次更新沿用库内绑定。阅读/点赞/收藏不由该列表提供，旧有效指标保留。自然出现新文章后，另验新稳定身份、原文发布时间及正文图片真正入库。

Windows 固定产物的 `runtime.cjs` 只监听本机 `127.0.0.1:4000`。当 SQLite 有有效、启用的 `public-album` 绑定时，显式设置 `ENABLE_SCHEDULED_UPDATES=1` 可以启用定时更新，无需其他来源的 Key；默认仍关闭。旧桌面产物保持禁用采集。容器入口使用下述 `DISABLE_SCHEDULED_UPDATES` 开关，两种入口不要混用。

## 独立部署入口

本轮提供 `docker-compose.public-album.yml` 和 `scripts/private-online/deploy-public-album.sh`。配置只有主应用，无第三方开发者中转、商业授权或上游容器；旧部署文件保留作历史入口。当前未在目标 Linux 主机运行，也没有完成线上切换。

部署前把**验收后的 SQLite 副本**放到 `private-data/sqlite/wewe-rss.db`，复制 `.env.public-album.example` 为 `.env.public-album`，私下设置至少 24 字符的 `AUTH_CODE` 和实际私人 HTTPS 地址；保持 `DISABLE_SCHEDULED_UPDATES=1`。用户办理服务器与账户授权。

```sh
bash scripts/private-online/deploy-public-album.sh
```

脚本构建、调用现有在线一致性备份组件并核验、停应用、迁移、再启动。没有现存数据库或备份失败即退出。主机只绑定 `127.0.0.1:4000`；由私人 HTTPS 入口访问，SQLite 不开放网络端口。登录保护覆盖 RSS、正文、图片及 ZIP。受控单号验收通过后，才在私有配置设 `DISABLE_SCHEDULED_UPDATES=0` 并重建容器；默认定时为北京时间 05:35、17:35，间隔由配置决定。

备份失败优先检查 Python 可执行路径和库文件权限；原文身份冲突、验证或频控优先看脱敏状态，停止本次更新；图片未完整本地化不能算离线通过。恢复前停应用，从已核验备份还原副本并检查完整性及旧字段，再切换。原始响应、数据库、导出 ZIP 和环境文件不得提交 Git。
