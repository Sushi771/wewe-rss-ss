# 公众号订阅恢复：当前精简交接（2026-09-29）

## 当前工作区与数据

- 仓库 `C:/Users/ss/.gemini/antigravity/playground/sparse-comet/wewe-rss-ss`，分支 `main`。设计基线 `2429a7401716a25f07cca9a3ecff806a20019a12`；已推送实施/交接提交 `f6ec5177323e91c8d3141e2e2b4131c0579ffdb7`、`61c3372594755338945fba1243bd8c23b566894e`、`e5cd3e107d1cca41b08ee820588cb4b7ddbd24da`。`e5cd3e1` 的 GitHub CI [36459939874](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36459939874) 已核对 success。接手以 `git rev-parse HEAD`、远端和新 CI 实测为准。
- 本轮从干净的 `61c3372` 继续。生产 SQLite **只读**核对 `quick_check=ok`、12 个订阅、1447 篇文章；没有生产迁移、写库或服务重启。用 SQLite 在线备份建立临时副本，应用本轮 `provider_refresh_attempt_time` 加性迁移后，`feeds` 和 `articles` 的原有列逐行摘要、数量与完整性检查均保持不变；临时副本已清理。正式上线仍须重新核验一致性备份与实际路径，并先在副本跑完整导入流程。
- 本机 `apps/server/.env`、`.env.local` 没有 Wechat2RSS 配置；Docker CLI、合法私有实例、本人授权和扫码条件仍缺。当前窗口运行模型/思考深度没有可查询的已应用设置，记为**未核实**。

## 已实现与已验证

- `f6ec517` 已加入显式 Wechat2RSS Provider、默认关闭开关、链接添加和手动/批量/定时入口；JSON Feed 仅为候选输入，真实字段仍待验。旧来源不会隐式执行。正文和图片清洗、SQLite 受保护导入、原有 RSS/Markdown/Obsidian 导出保留。
- 本轮新增 `feeds.provider_refresh_attempt_time`：手动 `/add` 在请求前原子占用每号 15 分钟冷却，失败及进程重启后仍生效；定时任务仍只读上游缓存。已有 `syncTime` 只在取得并写入可核验的非空缓存页后推进，不能代表上游异步任务完成。缓存为空且处于冷却期显示 pending，不将任务受理称作文章归档。
- 隔离 SQLite 回归覆盖重启后抑制重复 `/add`、冷却到期可重试、失败不推进成功时间，以及经过 JSON Feed 候选解析的正文和图片写入 Obsidian 本地附件；导出会从图片 URL 路径或 `wx_fmt` 保留受支持的扩展名。它们是**模拟上游**测试，不能证明目标号实际可取。此前独立副本模拟导入 1447→1448、重复新增/更新 0、旧值不变，只证明保护路径。
- 只读联调脚本现在从 `apps/server/.env.local` 读取私有实例 URL/token；执行脚本不要求启用应用采集开关。无实例时仅验证配置存在性，不发请求、不输出 token。真实目标号及接口字段仍未验证。
- 本轮检查：Prisma generate/validate、服务端全量测试 **16 套 / 139 项通过**、服务端构建、服务端 ESLint、`pnpm fmt.check`、`git diff --check` 均通过；导出扩展名修正后相关回归 7 项再次通过。新提交/CI 以本轮最终核对为准。

## 下一具体工作单元

1. 先核对本轮 GitHub 提交、远端 `main` 与 CI。若私有实例仍缺，不重复旧微信读书探针；只处理发现的实际代码/部署缺陷。部署新构建前必须先在副本验证新增加性迁移，再核验生产一致性备份并运行 `prisma migrate deploy`，不能直接用新二进制读取旧 schema。
2. 实例可用后先构建服务端，再从仓库根目录运行 `node scripts/acceptance-wechat2rss.cjs --execute MP_WXS_<目标数字ID>`；脚本自动读取 Git 忽略的 `apps/server/.env.local`，不要求设置 `WECHAT2RSS_ENABLED=1`。先核验“妈妈部落畅聊阁”至少五篇不同真实文章的稳定身份、原文 URL、时区时间、正文和图片可下载性。JSON Feed 不足时比较同一实例的 RSS 和 `/api/query`，只凭真实字段选择输入。
3. 再以真实输出在 SQLite 副本验收导入、旧 ID/正文/图片/指标保护、重复更新、重启、图片离线展示和按号导出。通过后才逐号受控生产接入，并验证第二号、全部原订阅、定时触发和自然新文增量。
4. 完整历史、非群发文章及长期停机窗口缺口独立记录，不把近期缓存读取视为全史恢复。没有自然新文时增量保持待验。

## 外部动作

用户需自行取得符合个人学习研究用途的 Wechat2RSS 私有实例授权，在 Git 忽略的 `apps/server/.env.local` 填写 `WECHAT2RSS_BASE_URL`、`WECHAT2RSS_TOKEN` 并完成本人扫码；`apps/server/.env` 已被 Git 跟踪，**不要把凭据写入该文件**。若本机部署，还需 Docker 环境。凭据不要发到聊天或提交 Git。购买、租服务器、扫码不由代理代做。只有这些条件缺失时，不创建空转后继任务。
