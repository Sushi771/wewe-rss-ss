# Windows 本机版本化产物与隔离部署演练（2026-09-28）

## 最新检查点：helper 固定入包，共享暂停状态，旧启动器已停用

本轮产物 `.local-releases/2026-09-28T03-54-01-837Z-284b827baab6` 将 `collect.ps1` 纳入版本清单并校验哈希，
服务端可从产物根目录找到该 helper。`.paused` 不进包；运行时启动要求显式指定产物外的绝对 `.paused` 路径，
交给 helper 作为跨版本共享状态。原源码布局仍使用原有暂停文件。当前 `USER_PAUSED` 未清除，未操作微信 UI 或剪贴板。

`启动WeWe-RSS.bat` 和 `scripts/prepare-local.cjs` 已改为失败退出，防止旧入口强制结束任意 4000 端口进程、
裸复制在线 SQLite 或直接对旧 schema 执行迁移。**它们当前不能用于重启服务**；正式启动器与可运行的旧版回滚应用
尚未完成。此时运行的生产 PID 58000 必须保留；不要把本轮产物直接用于生产切换，`runtime.cjs start` 仍只接受演练。

新产物的隔离证据在 `output/playwright/local-release-audit/2026-09-28T03-54-01-837Z-284b827baab6-1790567899967/`，
`summary.json passed=true`。12 号 / 1430 篇副本迁移后旧列全等、新列 null，重复迁移无变化，
两号列表/RSS、缓存正文、Markdown/Obsidian 均通过；网络和子进程 guard 计数为 0。产物文件数 12652，
helper 的 SHA-256 已进入清单，包内没有 `.paused`。4 项 Node 产物测试、40 项 PowerShell 离线测试通过；
旧启动准备脚本按预期返回错误。生产 PID/启动时间与暂停文件哈希未变。提交钩子的 Prettier 与服务端 lint 通过。

下一单元先固定已知提交 `9755d166e398f77baf52317f63ef36024037881d` 的旧 schema 可运行应用，
在新备份副本验证旧/新应用实际切换及失败回滚；再编写仅核验自身进程身份的受控启动器，
创建并核验**新的**生产一致性备份和保护基线后才可迁移、切换。任何失败不得自动用旧备份覆盖可能已新增数据的库。
真实采集最新 20 篇、第二号重复更新及持续更新仍未验收。

本单元处理“TypeScript 编译通过但实际 runtime 仍可能加载旧 Prisma 或未迁移库”的问题。
它不恢复微信自动化，不发起采集，不替代最新 20 篇与持续更新的真实验收。
当前生产进程与数据库保留原状；正式切换尚未接入。

## 已实现的入口

在项目根目录执行：

```powershell
node scripts/local-release/build.cjs
node scripts/local-release/rehearse.cjs --release .local-releases/<构建输出的版本> --source apps/server/data/wewe-rss.db
```

第二条读取源库并通过 SQLite 在线 backup API 创建新的完整备份，核验 integrity_check 与 SHA-256。
所有迁移、服务启动和导出都在新的 `output/playwright/local-release-audit/` 子目录内完成，生产库不写入。
产物、备份和审计均被 Git 忽略。不要将它们推送到 GitHub。

- 构建不安装依赖，不改运行中的 Client/DLL，不覆盖 `apps/server/dist`、`apps/server/client` 或已有版本。
  生成独立的 Prisma Client，复制匹配引擎并核对 SHA-256；服务端别名转换为编译产物内相对路径。
  固定本机 Node 及已安装依赖闭包，依赖链接只能留在产物目录内。
- `release.json` 记录源码输入、依赖版本、Client/CLI 版本、Node/引擎及全部文件哈希。
  运行时核验清单，移除父进程的引擎覆盖和 Node 注入配置，拒绝从产物外加载模块。
  这是完整性检测，不是第三方签名或新的包管理器；不能跨机器移动含绝对 junction 的产物。
- `runtime.cjs probe` 先只读检查数据库存在、完整性、外键、迁移校验和与新字段，再执行实际 Prisma raw 查询和 ORM 查询。
  旧 schema 拒绝启动；不会隐式 migrate，也不会因数据库路径拼错而创建空库。
- 演练使用产物内 Prisma CLI 执行三份真实迁移，再执行一次确认幂等。
  `feeds/articles` 所有原列（含 created/updated 时间戳、正文、来源、图片及含 null 的指标）逐字段比较；
  四个新增字段必须为 null。没有从旧文章凑采集数量或校正日期。
- 演练启动只绑定回环地址，拒绝 4000 端口，要求专用副本标记、导出目录与网络审计路径。
  `DISABLE_SCHEDULED_UPDATES=1` 既禁用 Cron 注册又在任务入口提前返回。
  子进程 guard 阻断 TCP/TLS/DNS/UDP、fetch 和子进程；只允许本机监听所需的数字回环地址解析，不改全局网络设置。
- 冒烟验证真实 HTTP 的 dashboard/静态 JS、两号列表和摘要 RSS、旧缓存正文、Markdown 与无外链图片正文的 Obsidian 文件。
  这些是已存数据的读取/导出回归，不是新文章发现。图片下载不在这次无网络冒烟范围，既有隔离图片测试单独报告。
  只结束本脚本创建的服务子进程，不查杀端口占用者。
- 数据库回滚演练把已核验备份恢复到新的 `rollback.db`，核对旧 schema/旧字段；保留迁移后的副本，不覆盖源库。
  这尚不等于旧应用版本的进程切换回滚演练。

## 现成方案参考与本机适配

已核对本机 pnpm 10.32.0 与 [pnpm 官方 10.x deploy 文档](https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/cli/deploy.md)：
工作区部署可输出独立依赖，未启用 injected dependencies 时使用 legacy 模式。
项目原有 `scripts/build-portable.js` 已采用该路线，但包含重新安装/生成和全量构建流程。
本轮为不触碰正在使用的依赖与 DLL，仅封装现有依赖的独立本机快照；常规分发应回归 pnpm 标准部署，避免扩展成通用打包器。

Prisma 的 [生成器](https://docs.prisma.io/docs/orm/v6/prisma-schema/overview/generators) 和
[引擎部署说明](https://docs.prisma.io/docs/orm/v6/more/internals/engines) 支持将生成物与对应引擎一起部署。
本机 CLI 为 5.22.0、Client 为 5.10.1；当前采用已安装的 5.10.1 generator 和现存匹配引擎，
通过实际 raw/ORM 请求验证协议兼容，不能只看生成命令成功。没有在本轮升级或覆盖生产依赖。

按用户新增原则再次核对 GitHub：

- [Access_wechat_article](https://github.com/yeximm/Access_wechat_article/commit/412b4a6d2f5005f01f70b20ad1c8530849eaafd3)
  仍为 `412b4a6d`（2026-08-23）。
- [we-mp-rss](https://github.com/rachelos/we-mp-rss/commit/126993c81a00466e9a6bbab041eef34ab27abe9c)
  仍为 `126993c8`（2026-09-24）。

两个当前提交与上一轮调查相同。本轮只读复核，没有复制新的第三方代码、安装外部采集器或重放上游请求；
这些仓库存在不代表本机目标号已可采集。具体复用与排除依据见三份 `COMPLETE_*` 文档。

## 验证记录

服务端 16 套 / 213 项通过；新增定时关闭用例确认在任何数据库/采集访问之前返回。
本轮 Node 4 项验证产物篡改/新增文件、链接逃逸、环境覆盖清理和网络/子进程阻断；
Python 6 项验证 schema 门、迁移记录漂移、旧字段及 null 保护、新列不可回填、缺失数据库不创建。
前后端 lint、类型检查与实际构建通过。

最终产物：`.local-releases/2026-09-28T03-19-37-216Z-34447f46cfea`。
最终证据：`output/playwright/local-release-audit/2026-09-28T03-19-37-216Z-34447f46cfea-1790566083203/summary.json`，`passed=true`。
三份迁移及重复迁移通过，12 号 / 1430 篇所有旧列保持一致，新列 null；服务端实际 Client 5.10.1/SQLite 3.41.2 查询通过。
页面/静态资源、两个目标号列表与 RSS、缓存正文、Markdown 和 Obsidian 文件导出通过；guard 的网络与子进程计数均为 0。
恢复到新库后的旧 schema 与旧字段一致，测试子进程已停止，源库与暂停状态未改。
这次没有真实文章更新、图片下载或旧应用进程切换，生产部署仍未完成。

首次演练暴露 Python Windows stderr 编码导致预期失败断言不匹配，已显式使用 UTF-8；
另发现 Node 监听数字回环地址也调用 DNS lookup，guard 已加入无网络的字面地址返回并增加监听用例。
最后修复 runner 的 mutation 为前端相同的 tRPC batch 格式，避免 Express 对根 JSON 字符串返回 400；
它没有改变产物内应用/runtime，最终演练使用当前工作树 runner，清单源码输入哈希仍对应构建时快照。
提交检查发现 `verify-desktop-evidence.ts` 位于旧 lint 的 TypeScript 项目之外；新增独立 `tsconfig.eslint.json` 覆盖 scripts，
并将 scripts 加入后端 lint 范围。只调整开发检查配置，不将脚本加入生产编译，也未重新生成本次已验证的应用产物。
以上失败保留为本机记录，不改写成一次成功。

## 正式部署前剩余的具体工作

1. 固定 helper 与共享暂停路径已在新产物及副本演练通过；runtime 仍仅允许演练模式，不能直接上线。
2. 原 `dist` 已被前轮编译改变，不能假定停掉 PID 58000 后原命令还能恢复旧版本。
   固定可连接旧 schema 的回滚应用（可从已知 Git 提交导出，不 reset checkout），并在副本上验证旧应用启动。
3. 替换旧启动器的“杀掉任意 4000 端口进程”和裸复制备份步骤。核对被管理进程身份，迁移前新建一致性备份和保护基线；
   准备完成后再执行受控切换与回滚演练，失败保留迁移后库，不自动覆盖可能新增的数据。
4. 延续 [AGENTS.md](../AGENTS.md)：后续窗口 `gpt-6-sol` / `xhigh`，优先 GitHub 成熟方案，每轮源码/注释/文档同步 GitHub。
   微信 UI/剪贴板暂停和首次恢复仅 60 秒单篇无写库的边界保持。
