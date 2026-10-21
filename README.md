# WeWe RSS SS

面向个人知识归档的微信公众号订阅、阅读和离线保存工具。在 [cooderl/wewe-rss](https://github.com/cooderl/wewe-rss) 基础上继续开发，保留 RSS 输出，并增加来源管理、持久刷新任务、作者分组、单篇下载和 Markdown / Obsidian 归档。

## 版本范围

默认 `main` 已合入订阅、缓存、阅读与导出的多项集成改动；本文有效的历史源码链接固定到核对基线 [`33ec7c3`](https://github.com/Sushi771/wewe-rss-ss/commit/33ec7c3ebc20ce55d5f81259a5dd515912b5ca65)（2026-10-18）；已修复的断链使用当前相对路径，不再以旧集成分支是否合入判断功能。独立集成提交 [`8a3141c`](https://github.com/Sushi771/wewe-rss-ss/commit/8a3141c43b1b09e92ebd75780f26c58939557906) 的分组/日期筛选、阅读器和后台启动审计接线尚未全部回流到该 main 基线。构建已有部署的替换包前必须核对这些差异；不能用 main 的旧接线覆盖已交付功能。README、开发分支或测试通过均不代表已有部署已升级。

## 已实现功能

- **公众号订阅与更新**：通过实际注册并配置的来源添加订阅。Wechat2RSS 路径支持持久任务、增量缓存同步、手动刷新全部合资格订阅和后台自动轮次。来源选择受配置和订阅绑定约束。
- **阅读与管理**：文章搜索、分组数据、拖拽排序、批量选择与操作、阅读位置保留及深浅主题。日期筛选、完整分组视图和正文内查找的已交付集成接线需按上述版本范围核对，不能仅凭底层组件存在认为 main 页面已接入。
- **单篇链接下载**：在「工具 → 文章下载」粘贴公众号链接，确认保存位置。正文仅使用 Wechat2RSS 的可靠缓存；必要时通过已有队列按需订阅公众号并等待目标文章。无精确链接映射时提供缓存文章选择，不按标题或顺序猜测目标。
- **本机归档**：保存 Markdown 和相对路径图片，可直接放入 Obsidian，支持目录选择与路径记忆。同目录通过稳定文章身份及回执预检，完整文件跳过、可确认的缺图补齐，保留用户编辑的正文和独立笔记。
- **按范围导出**：按公众号、分组、搜索和日期导出当前筛选的完整本地集合，覆盖分页后的文章；另有 ZIP 快照导出。RSS、Atom、JSON Feed 和 OPML 继续用于阅读器与订阅源迁移。

“已发现文章”只表示列表中有记录。正文可用、图片就绪和离线保存完整是不同状态；刷新批次成功不代表每篇正文、每张图片都已归档。

## 工作流程与实现依据

1. **注册来源和订阅**：后台读取私有配置，按公众号来源与启用状态选择适配器。Wechat2RSS 是外部授权实例，本项目负责管理、缓存和导出；旧微信读书登录或研究代码不等于当前已恢复的全文订阅服务。见 [Provider 注册][provider]、[订阅服务][subscription]。
2. **排队刷新**：手动与自动刷新复用持久批次队列，串行提交、保留受理回执与单号冷却；重启后依靠原任务状态续接。鉴权、风控或未知受理会暂停流程。见 [批次实现][batches]、[调度说明][schedule-doc]。
3. **同步缓存**：读取来源已有缓存，按稳定身份去重；无变化的完整文章跳过，新增及符合条件的正文缺口通过受保护写入保存。正文提交与自动媒体补齐分离；后者使用有界任务、退避和安全停闸，不阻塞正文回执，也不覆盖用户已有导出正文。见 [缓存实现][cache]、[缓存恢复说明][recovery-doc]。
4. **离线保存**：先核对目录、身份和已有回执，再准备缺失媒体；图片校验后落盘，Markdown 使用相对路径。结果区分新增、跳过、补入和失败；媒体未齐不会被描述为完整归档。见 [保存实现][local-save]、[增量导出说明][export-doc]。

### 自动更新时段

主动轮次的代码时点固定为上海时间 **09:15、14:00、17:30**。需要同时设置 `WECHAT2RSS_ACTIVE_SCHEDULE=1`、`ENABLE_SCHEDULED_UPDATES=1`、`WECHAT2RSS_ENABLED=1`，且 `DISABLE_SCHEDULED_UPDATES` 不为 `1`。这是显式启用模式，并非安装后默认运行。

每轮动态选取全部当前启用、来源合资格的订阅。首次启用安排下一时点；重启不逐轮补发历史任务。17:30 后不启动新的补跑轮次，已开始的队列可以继续到晚间；**00:00–06:00 不自动提交**。手动与新增订阅任务不受自动时刻表控制。此模式不使用旧 `CRON_EXPRESSION` 或 `SCHEDULED_MP_IDS` 决定时点和范围，详见 [调度源码][schedule-code]。

这些时点是计划配置，不保证每轮都成功。实际结果取决于来源、账号、缓存、数据库和安全停止状态，应查看批次回执以及正文、媒体状态。

## 使用与导出

1. 配置合法可用的来源，进入来源/账号管理完成该来源所需的本人登录，再添加公众号。分享链接用于识别和注册，不保证能取到链接对应的旧文章。
2. 在公众号页搜索、分组或设置日期范围，再选择刷新或导出。关闭页面不取消后台已受理任务，结果可在任务列表查看。
3. 「全选已加载」只选择当前已加载文章；「导出当前筛选全部」取得稳定 ID 快照，导出整个本地筛选集合，**不是只导出当前 20 篇列表页**。单次最多 5000 篇，超出时缩小范围；日期按上海时区处理，未知发布日期不计入明确日期筛选。
4. 本机归档使用 `YYYY-MM-DD_分组/公众号/文章标题.md`，图片在该公众号目录的 `image/`，Markdown 引用相对路径。日期取可信原文发布时间；未知日期使用“日期待核”，无分组使用“未分组”。同名冲突加稳定身份后缀；分组改变不自动移动旧文件。
5. 再次保存到同目录，先跳过完整文章，只补可安全确认的缺图，保留手写正文和笔记。旧回执缺少可靠映射、文件冲突或损坏时明确失败，不猜测覆盖。补图可能写入同目录的补充图片 Markdown，保留原正文。

**ZIP 每次生成独立快照**，不对用户解压后的目录执行增量补图或保护编辑；本机目录保存才具有上述同目录增量语义。导出范围是本地已记录集合，不代表平台所有历史。

RSS 示例：`/feeds/all.atom`、`/feeds/MP_WXS_<公众号ID>.json?limit=30`；支持 `title_include`、`title_exclude` 标题筛选。远程访问的认证范围应按实际部署核对，不能只因设置 `AUTH_CODE` 就假设所有 RSS 路径已保护。

## 运行与配置

当前集成源码使用 NestJS / tRPC、React / Vite、Prisma / SQLite。不要使用旧 README 中删除 Prisma 目录、切换旧 MySQL schema 的步骤，也不要用上游 `cooderl/wewe-rss:latest` 镜像代替本 fork 的构建。

### 新建本机测试实例

以下 PowerShell 命令只用于**独立检出和全新小型测试库**。先安装 Node.js 22 或更新的受支持版本、pnpm 10.32.0 和 Python 3（SQLite 备份与缓存读取需要）。密码和目录自行填写。生产升级先备份、用副本演练并构建固定产物，不能把这套初始化流程直接指向旧库。

```powershell
git clone https://github.com/Sushi771/wewe-rss-ss.git wewe-rss-ss-test
Set-Location wewe-rss-ss-test
git checkout 33ec7c3ebc20ce55d5f81259a5dd515912b5ca65
$env:DATABASE_TYPE = 'sqlite'
$env:DATABASE_URL = 'file:../data/wewe-rss-test.db'
$env:HOST = '127.0.0.1'
$env:PORT = '4000'
$env:AUTH_CODE = '<填写自己的长随机访问密码>'
$env:OBSIDIAN_PATH = '<填写自己的归档目录>'
$env:DISABLE_SCHEDULED_UPDATES = '1'
New-Item -ItemType Directory -Force apps/server/data
pnpm install --frozen-lockfile
pnpm --filter server exec prisma migrate deploy
$env:NODE_ENV = 'production'
pnpm build:server
pnpm build:web
pnpm start:server
```

环境变量保持在同一终端有效，端口需空闲。浏览器访问 `http://127.0.0.1:4000/dash`。来源默认未启用，启动页面不等于已接通采集。后续在私有运行环境配置来源；不提交实际 `.env`、Token 或会话。

| 配置                                                      | 作用                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` / `DATABASE_TYPE`                          | 当前版本使用 SQLite；`file:../data/...` 相对 Prisma schema 目录解析，示例落在 `apps/server/data/`。 |
| `HOST` / `PORT`                                           | 默认监听 `0.0.0.0:4000`；本机显式设为 `127.0.0.1`。                                                 |
| `AUTH_CODE`                                               | 管理接口访问密码，自行设置长随机值。                                                                |
| `SERVER_ORIGIN_URL`                                       | 对外地址，用于生成 Feed 链接；远程部署使用实际 HTTPS 地址。                                         |
| `OBSIDIAN_PATH`                                           | 服务所在电脑的归档根目录；显式指定自己的目录，也可通过工具页选择。                                  |
| `WECHAT2RSS_ENABLED`                                      | `1` 才启用 Wechat2RSS 来源。                                                                        |
| `WECHAT2RSS_BASE_URL` / `WECHAT2RSS_TOKEN`                | 已授权实例的地址和 Token，仅在后台私有环境配置。                                                    |
| `WECHAT2RSS_FEED_IDS`                                     | 显式放行已有公众号 ID，逗号分隔；新增订阅另走来源注册与持久队列流程。                               |
| `WECHAT2RSS_CACHE_DB`                                     | 本机实例缓存库位置；本地缓存同步/恢复需要可信、可访问的库。                                         |
| `WECHAT2RSS_ACTIVE_SCHEDULE` / `ENABLE_SCHEDULED_UPDATES` | 同时为 `1` 才请求启用主动轮次，还需来源与启动检查通过。                                             |
| `DISABLE_SCHEDULED_UPDATES`                               | `1` 禁止定时更新；测试库保持关闭。                                                                  |

Windows 固定产物、启动与回滚机制见 [本机版本化部署演练][deployment-doc]；其中旧日期的部署记录属于历史，不是本次部署指令。容器构建入口需按目标版本核对迁移、来源授权和计划开关，不能只运行容器就认为订阅已就绪。

### 数据、备份与安全

- **主库与任务**：SQLite 主库保存订阅、文章和管理信息；数据库同目录还保存调度水位、刷新队列、单篇任务及锁。备份和恢复需同时考虑这些状态，避免只搬库文件后重复提交。
- **来源数据与归档**：Wechat2RSS 缓存/授权数据与本项目主库分开；Markdown、图片和手写笔记另在自己确认的目录。它们都不应上传公共仓库。
- **一致性备份**：使用 SQLite backup API 的 [备份脚本][backup-code]，检查完整性及结果，再用副本演练升级或恢复。运行中不要只复制主 `.db` 忽略 WAL 状态。回退程序不能用旧库覆盖新增文章和编辑。
- **运行空间**：监控主库、来源缓存、写前备份、导出与固定产物占用；保留可用备份和回滚版本后再整理旧产物。代码已包含空间预算和有限恢复点管理；实际启用方式需按固定产物核对，不能认为磁盘膨胀已永久解决。
- **访问边界**：本机绑定回环地址；远程配置 HTTPS 和受控访问，不直接暴露数据库、来源后台或私有目录。本人登录、合法授权和凭据保管由部署者负责。

## 已知边界与开发状态

- 列表发现、正文缓存和图片归档分别受来源能力影响。单篇导出可能显示“正文未缓存”或“最近重试失败”；可读列表、成功定时任务或已有正文都不能证明所有媒体已齐。
- 无法保证订阅前全部历史、所有非群发内容或永不漏文。单篇下载也不保证任意短链接、旧文章均有可靠缓存和身份映射。
- 原图片地址失效、来源缺失或映射不可确认时可能无法补齐；部分可保存内容会明确标记媒体不完整，应保留失败信息和旧笔记。
- **小红书**已有管理与离线缓存界面骨架，真实来源接入未完成。独立 `redbook` 候选尚未集成、上线或完成真实签名、字段和图片完整性验证，不是当前可用订阅来源。
- **Rnote**仍为评估备选，多账号登录链路未通，不是已接通来源。实验适配器存在不代表可用于当前生产流程。

## 相关文档

链接固定到本文核对基线，可区分源码、独立集成接线和文档中的历史记录：

- [增量归档、筛选范围和 ZIP 合同][export-doc]
- [单篇下载与缓存来源边界][download-doc]
- [主动更新调度][schedule-doc] / [自动缓存同步与恢复][recovery-doc]
- [Windows 固定产物与部署演练][deployment-doc]
- [产品需求与规划][product-doc]（规划项不等于已交付）
- [开发指南][development-doc] / [本地增量归档合同][layout-doc]

## 许可证与致谢

沿用 [MIT License](LICENSE)，原作者 **@cooderl**，原项目 [cooderl/wewe-rss](https://github.com/cooderl/wewe-rss)。本仓库是继续开发的 fork，与上游版本、镜像及第三方来源分别维护；来源服务的授权、条款和可用性仍由其提供方决定。

[provider]: https://github.com/Sushi771/wewe-rss-ss/blob/33ec7c3ebc20ce55d5f81259a5dd515912b5ca65/apps/server/src/collection/provider-registry.ts
[subscription]: https://github.com/Sushi771/wewe-rss-ss/blob/33ec7c3ebc20ce55d5f81259a5dd515912b5ca65/apps/server/src/trpc/trpc.service.ts
[batches]: https://github.com/Sushi771/wewe-rss-ss/blob/33ec7c3ebc20ce55d5f81259a5dd515912b5ca65/apps/server/src/collection/wechat2rss-subscription-batches.ts
[cache]: apps/server/src/collection/collection.service.ts
[local-save]: https://github.com/Sushi771/wewe-rss-ss/blob/33ec7c3ebc20ce55d5f81259a5dd515912b5ca65/apps/server/src/article-local-save.ts
[schedule-code]: https://github.com/Sushi771/wewe-rss-ss/blob/33ec7c3ebc20ce55d5f81259a5dd515912b5ca65/apps/server/src/feeds/active-refresh-schedule.ts
[backup-code]: https://github.com/Sushi771/wewe-rss-ss/blob/33ec7c3ebc20ce55d5f81259a5dd515912b5ca65/apps/server/scripts/backup-sqlite.py
[export-doc]: docs/INCREMENTAL_ARTICLE_EXPORT.md
[download-doc]: docs/paid-sources/PRODUCT_REQUIREMENTS.md#单篇下载与部署边界
[schedule-doc]: apps/server/src/feeds/active-refresh-schedule.ts
[recovery-doc]: docs/MAIN_WECHAT_RUNTIME_EXTRACTION.md
[deployment-doc]: docs/LOCAL_RELEASE_REHEARSAL.md
[release-doc]: https://github.com/Sushi771/wewe-rss-ss/blob/33ec7c3ebc20ce55d5f81259a5dd515912b5ca65/docs/LOCAL_RELEASE_REHEARSAL.md
[product-doc]: docs/paid-sources/PRODUCT_REQUIREMENTS.md
[development-doc]: https://github.com/Sushi771/wewe-rss-ss/blob/33ec7c3ebc20ce55d5f81259a5dd515912b5ca65/DEVELOPMENT.md
[layout-doc]: docs/INCREMENTAL_ARTICLE_EXPORT.md
