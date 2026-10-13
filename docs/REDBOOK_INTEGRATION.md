# Redbook 离线接入候选（2026-10-13）

独立分支 `codex/redbook-offline-integration` 基于 `edb0ecb`。本候选登记独立 `RedbookSource`，默认 `configured:false`，不创建凭据或状态文件，不发平台请求，不运行 CLI、不读浏览器 Cookie、不启动浏览器、不切账号/IP/代理、不部署生产。环境变量不能开启此来源，也不复用 Rnote 的 `X-API-Key` 合同。

## 审计与兼容

受审源码 [lucasygu/redbook v0.8.2](https://github.com/lucasygu/redbook/tree/801a09847699a2bae5560eeefd901e3afdde469b)，MIT，准确 SHA `801a09847699a2bae5560eeefd901e3afdde469b`。仅保留本地 XYS 签名及 `getUserNotes`/`getNoteById` 两条只读请求形状。许可证在 `apps/server/src/collection/redbook-vendor/REDBOOK-LICENSE.txt`，裁剪说明与离线签名对照在同目录 README。

原包 Node>=22/ESM 不直接导入 Nest CommonJS：裁剪代码用既有 crypto/Buffer/URL/BigInt 编译为 CommonJS，不引入整包依赖。保留的 API 在 Node20.16 可用；本机 Node24 离线执行不等于已在 Node20/22 或平台实测。原 postinstall 会改 Claude skill/依赖，未执行。没有安装包或安装脚本。

GET406 换签重试、v2→v1 列表回退及详情 HTML 回退已移除。固定 `edith.xiaohongshu.com`，一次响应或传输异常即停止；错误只保留固定分类，不记录 Cookie、token、签名 URL 或上游响应。客户端默认无 transport；未来受审 transport 必须落实零重试、禁止重定向、15秒/8MiB 限额。媒体独立传输，仅给 accept，无 Cookie、credentials omit、禁止重定向，逐张字节校验，10MB/图、20MB/篇。请求 jpg/webp；AVIF 明确拒绝，不改后缀伪装。

## 有限增量扫描与保存

每博主每个手动窗口最多三批，每批请求30，理论最多90，不保证实得。完成后下一次手动刷新从头检查最近窗口，不接着翻入更深历史，不启用定时请求。重复游标/环、超30列表、重复 noteId、归属冲突均受检查；已有完整缓存在详情请求前跳过。后续新增与窗口内缺失缓存可取得，既有完整缓存不覆盖；缓存正文/全部已获取图片通过原字节合同及 SQLite 备份事务后写入。

显式 private directory 的 `FileRedbookStateStore` 记录作者、请求批数、游标、noteId 和阶段，不保存账号 Cookie、笔记 token、正文/媒体。请求前先记账，页缓存事务成功后才提交安全检查点。重启遇 requesting/awaiting-commit 或剩余锁即暂停；不自动重放不确定结果。保存 ready 检查点可在下一次手动刷新内续接，仍受原三批总量限制。上游/认证/验证码/签名/权限/限流或内容异常保持暂停，无浏览器恢复入口。只有内部操作者方法可恢复尚未发出请求的 operator 检查点；不能清除限制或不确定请求停止。

页面扫描时有“暂停扫描”，当前已提交请求安全结束后停止后续详情/分页，批量后续博主停止。暂停请求不等于撤回已发出的 HTTP。SQLite 成功但检查点未成功的异常保留缓存与暂停状态；重新授权前先核对，不默默回滚归档。

图文稳定 `platform/author/noteId` 导出身份已接原保存器，跨日期/标题/分组变化先跳过完整同目录内容；缺图按可信映射补齐，手写正文保留，旧不可信映射不猜测或覆盖。见 [XHS导出身份](XHS_EXPORT_IDENTITY.md)。视频保持已有独立缓存保存链路，本候选只映射图文。

## 真实合同仍未证明

上游 CLI 只支持外层 notes/cursor/has_more、items[].note_card 的代码证据。候选严格选定 `image_list[].url_default`、两个精确主机 `sns-webpic-qc.xhscdn.com`/`sns-webpic.xhscdn.com`；这些字段/主机及 desc 的全文语义、image_list 的原图完整性没有真实响应证明。拒绝猜字段或自动替换图片变体。`has_more=true` 缺游标失败且保持暂停，不能当结束。`note_card.time` 明确按整数毫秒处理，范围2013-01-01至当前+5分钟，再转秒；不使用抓取时间、ID推测或字符串修复。

`contractReviewed` 仅为内部经过审核的装配条件；本轮测试注入 true 只表示合成测试接缝，不能成为真实证据。未来启用须明确安全凭据交接、受审作者绑定、脱敏实样合同及受限 transport；现模块不提供 env/UI 捷径、不创建持久凭据。笔记图数/顺序/实际字节/hash 验证不等于证明上游交付全部历史或原图，也不是像素解码验收。

## 离线验证与用户后续小范围验收

本轮测试只用合成 Cookie/响应、真实合成 PNG、临时文件夹与 SQLite，不调用平台。覆盖本地签名与受审版本 GET/POST 五个 headers 的固定随机源对照、失败首停/无换签回退、分页/时间/身份/schema边界、媒体URL/格式/字节/预算、持久暂停/安全检查点及原导出映射。

复现：`pnpm --filter server exec jest redbook xiaohongshu article-incremental-export article-source-layout --runInBand`；类型 `pnpm --filter server exec tsc --noEmit`；lint 使用 `eslint`（不带 --fix）；完整测试 `pnpm --filter server test -- --runInBand`。构建前须确认磁盘空间，`pnpm build:server`、`pnpm build:web` 不等于生产上线。

用户测试尚未开放：本候选仍关闭真实来源，不能让用户直接点刷新便称为接入成功。独立审查和空间恢复后先交付可追溯构建，再由父线程安全交接与批准明确首轮范围：一位确认博主、前三篇；随后重复同范围新增0，同目录第二次保存跳过，删一张合成/验收图片后补齐且手写正文保持，断网检查 Markdown 全图。遇任何限制首次暂停，不自动重试或扩大到三批。只有这些真实检查完成后才能报告真实接入成功并提醒用户测试。

PR保持 draft/open；本候选不合并PR2，写回集成分支需父线程明确交接。原主工作区 `prisma.service.ts` 和 `DEVELOPMENT_HANDOFF.md` 未提交修改保留，公众号部署线程和运行服务未操作。

## 本轮交付记录

本地首个候选提交 `701d664`。客户端28项、响应/媒体38项、导出身份8项离线通过；扫描器12项（含最后详情/最后提交期间暂停持久化）通过；共享保存/导出4套44项另通过。新合成client→mapper→source→SQLite端到端测试通过。类型检查、changed-file服务端lint与web lint已通过；现有批次UI合同4项通过。组合SQLite测试曾因5秒超时、ZIP子进程依赖工作目录及旧保存布局断言失败，已分别修补，最终整套15/15通过；保存路径和完整本地回执先跳过的旧断言按新身份合同更新，不把失败轮次计为通过。服务端/前端 noEmit 类型、相关lint以及diff whitespace检查最终通过。

本机大副本/构建已按磁盘核查指令暂停，未完成全量测试/最终构建。task-8源码、审计源码和测试缓存统计13.8MiB，四个既有依赖junction不计入实际文件体积；未复制用户数据库/媒体/node_modules。GitHub推送被自动审批拒绝，原因为本执行环境不接受委派文本作为外传发布授权；尚无远端分支、draft PR或CI成功证据，不能宣称已同步。需明确批准发布到既定 `Sushi771/wewe-rss-ss` 后继续，不能绕过审批改用连接器传文件。最终实际SHA、远端CI、独立审查与父线程写入交接需分别回填。

接稳定来源身份后，新图文保存为可信发表日/分组/博主目录下的标题Markdown及共享image池；视频保持原每篇目录。旧版“每篇正文.md”的图文说明为历史布局，新完整回执仍按稳定身份先检查，不能据标题猜旧关联。
