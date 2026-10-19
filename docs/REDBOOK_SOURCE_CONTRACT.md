# 小红书图文来源公共基础（离线准备）

开发基线：`08736455c356f00e62699ad51440d0703dcea226`。用户提供的生产来源
`6b7afe8fb7ef84f22684601cd088487c3de3904f` 仅作版本边界记录；本轮没有操作或验收生产。

## 审查结论与本轮范围

汇总树已有 `XhsSource.read`、`XhsNormalizedCandidate`、`xhsArchiveDraft`、
`appendXhsPage` 和 XHS 事务归档服务，但没有注册 Redbook。另一个本机分支
`codex/redbook-offline-integration` 的 `0799e6027739a8a8ca7c74ffe21b70e2781b3272`
含 Redbook 客户端、图文映射、扫描检查点及默认关闭的运行模块。它是审查参考，
没有整体合入本轮，也不构成当前汇总树或真实平台可用性的证据。

旧分支已具备稳定 noteId、作者校验、最多三页、单来源串行、游标防循环、
请求前检查点和中断暂停。风险是旧响应字段、CDN、签名与会话假设不能当成已验证事实；
旧分支的独立文件存储/运行模块也不能直接替代当前公众号任务机制。

本轮只增加 `redbook-source-contract.ts`、合成测试与独立 CI；现有契约仅导出原有
身份函数 `xhsIdentity`。没有修改调度器、服务注册、前端、生产 schema、运行配置或采集路径。
没有真实请求、登录、凭据读取、端口、数据库复制或备份。

## 最小统一接口及数据

`XhsPageSource.readPage(XhsPageRequest)` 是内部逐页 seam，输入来源标识、外部作者 ID
与请求游标，输出同一来源/作者、下一游标和现有 `XhsNormalizedCandidate[]`。
本轮唯一来源标识为 `redbook`，仅支持图文。它没有替换现有整窗 `XhsSource.read`，
也没有把来源结果标为 `evidenceVerified`。默认导出的 `disabledRedbookSource` 总是拒绝读取，
没有客户端、环境开关或 Nest 注册可启用它。

| 数据   | 契约                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------- |
| 作者键 | 原有 JSON 元组 `["xiaohongshu","author",externalAuthorId]`                                                |
| 笔记键 | 原有 JSON 元组 `["xiaohongshu","note",noteId]`；不含适配器、URL、临时图片地址或 token                     |
| 分页   | `null` 为首次请求；响应 `nextCursor:null` 才表示来源报告结束；三页用尽且仍有游标只代表窗口结束            |
| 检查点 | `version/source/authorId/phase/reason/ledger`；严格校验，不接受额外字段                                   |
| ledger | 复用 `XhsPageLedger`；请求游标最多 3 个，唯一笔记最多 90 个，每页最多 30 条                               |
| 图片   | 复用 `xhsArchiveDraft` 与 `decodeInlineImage` 的实际字节/顺序/数量/容器校验；仍不代表完整解码或来源真实性 |

检查点只保存来源、身份和分页元数据。游标是有界的不透明分页值，不能放入详情 token、
会话或签名图片 URL；真实响应尚未核实，不宣称任何真实供应方游标适合持久化。
拥有任务的代码还须把检查点的作者绑定到任务的既定作者；不能用检查点本身改写任务归属。

## 后续接入必须复用的顺序

1. 由现有任务持有者取得单来源串行所有权；本轮不添加锁、队列、定时器或磁盘存储。
2. 载入并解析检查点。安全的 `ready` 可以继续；`requesting` 恢复为 `paused/interrupted`。
3. `beginRedbookPage` 生成 `requesting`，先由原有任务持久化，再调用来源。
4. `prepareRedbookPageCommit` 校验身份、游标、图文与图片，计算去重键和候选下一检查点。
5. 交给既有 XHS 缓存/事务所有者完成写入及核验回执，然后才保存下一检查点。
   此函数只准备数据，不提供提交证明，也不保存检查点。
6. 请求失败、限流、登录失效、图片过期或提交结果不明时保存固定暂停原因。
   没有自动过期、自动清除、自动重放或恢复登录。提交后、检查点保存前中断也保持未知，
   需要核对缓存证据后再决定恢复。

`Wechat2RssSubscriptionBatches` / `Wechat2RssSubscriptionTasks` 已提供任务接受、
持久回执、恢复与有界继续语义；其 URL、feed ID 和实例绑定是公众号专用的，
不能把 XHS 假装成公众号塞入它们。本轮运行原有恢复测试作为回归，未更改这些类。
后续需要把 XHS 接入公共任务持有者时，须先向父窗口报告公用调度的具体改动范围，
沿用原有存储、锁和重试，不另造通用框架，也不照搬公众号并发 5。

缓存复用当前 `xhsArchiveDraft` / `retainXhsArchiveDraft` 的校验与完整候选保留规则，
以及 `XiaohongshuService.refresh` 的 `incrementalWrite` 和原有 SQLite 事务路径。
完整图文保持原有稳定 ID、作者、正文和图片；过期地址不改变身份。
图片获取失败不能把旧完整缓存降级为空值或摘要。

当前生产服务拒绝不完整图文，不具备“已归档图文缺图后逐槽补齐”的新运行功能。
本轮图片过期测试验证的是：暂停保留旧候选、经另行审核取得完整字节后，现有候选保留函数
可以从不完整候选升级为完整候选；没有自动重试 CDN，也没有据此宣称生产图片补全已上线。

## 验证与边界

合成所有者仅在测试内用 Map 和 JSON 往返模拟检查点，不是运行时组件。
覆盖同页/跨页重复、安全检查点恢复、派发前/缓存提交后中断、429 类限流、
登录失效、图片过期候选补全、错误去敏、三页窗口、循环游标、作者/来源错绑及损坏图片。
限流与登录失效使用固定语义错误，不猜测真实平台状态码或错误码。

```text
pnpm --filter server exec jest --runInBand --no-cache src/collection/redbook-source-contract.spec.ts src/collection/xiaohongshu-contract.spec.ts
pnpm --filter server exec jest --runInBand src/collection/manual-refresh-batches.spec.ts src/collection/wechat2rss-subscription-tasks.spec.ts
pnpm --filter server exec tsc --noEmit --incremental false
```

新增测试不创建文件、DB、备份、服务器或真实请求，数据有界于三页小 PNG。
原有任务测试仅使用其自建临时合成目录，并在结束时关闭任务、清理目录。
CI 使用现有锁文件和依赖，没有新增包。

本地验证：Node `v24.11.1`，复用现有依赖；来源/归档两套测试 27 项通过，
原有任务恢复两套测试 23 项通过，server 全量 `tsc --noEmit --incremental false` 通过。
这些结果属于合成契约与既有回归，没有真实平台或生产路径验收。

尚待另轮授权/证据：真实响应脱敏样本审核、外部作者身份核实、真实分页与过期图片语义、
共享任务持有者接入评审、真实环境验收。本轮只交付开发分支草稿 PR，不合并或部署。
