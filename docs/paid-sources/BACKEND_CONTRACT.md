# 后端与接口契约

2026-10-09 · 已有接口与拟新增契约分开 · [返回总览](../PAID_MULTIPLATFORM_PLAN.md)

## 当前真实存在的接缝

| 接口/函数                                           | 当前合同                                                                                 | 复用及边界                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `feed.list` / `feed.byId`                           | 已有 tRPC；返回微信 Feed 与 `collectionRoute`                                            | 薄 facade 映射为通用作者；不把全部 Feed 行原样送到 Sites       |
| `feed.addCapability` / `feed.addFromArticle`        | 已有来源能力和公开文章 URL 添加；本轮本地增加可选 source                                 | 未传 source 保留旧默认；明确选择不回退；原 UI 已接线，尚未部署 |
| `feed.repairNativeSource`                           | 已有本机正常账号下的 native 修复，明确确认                                               | 本轮不调用、不解除停止；不是付费来源切换接口                   |
| `feed.refreshArticles({mpId?})`                     | 单微信号或全部；逐号回执数组，当前同步请求                                               | 可复用单号 service；不把它说成已有异步 job API                 |
| `feed.isRefreshAllMpArticlesRunning`                | 已有进程内布尔查询                                                                       | 不能替代持久 taskId 或崩溃恢复                                 |
| `article.list` / `article.byId`                     | 元数据分页/完整缓存正文                                                                  | 页面 DTO 不包含 token、路径和原始上游响应                      |
| `article.exportMarkdown` / `article.saveToObsidian` | 浏览器 Markdown 与本机保存分离                                                           | 小红书缓存需独立适配；Sites 不能用本机路径当下载               |
| `GET /download/feed/:id.zip`                        | 微信 ID 校验、正文/图片 ZIP                                                              | 现有只接 `MP_WXS_…`，小红书不能直接传进去                      |
| `Wechat2RssProvider`                                | `checkAccountStatus/listSubscriptions/addSubscription/refreshSubscription/fetchArticles` | 保留 private-host、手动重定向、限时限体积、秘密不外泄          |

代码入口：[`trpc.router.ts`](../../apps/server/src/trpc/trpc.router.ts)、[`trpc.service.ts`](../../apps/server/src/trpc/trpc.service.ts)、[`wechat2rss.ts`](../../apps/server/src/collection/providers/wechat2rss.ts)、[`collection.service.ts`](../../apps/server/src/collection/collection.service.ts)。

## 本轮本地已实现：原新增入口的明确来源选择

`feed.addCapability({source?})` 和 `feed.addFromArticle({articleUrl, accountId?, source?})` 的来源只接受 `native | wechat2rss`；省略来源保留旧默认，有 native discovery 时优先 native。能力查询返回当前选择及 `sources[]`，只检查注册/启用/私有配置，无上游请求；配置通过不代表列表或全文可用。已有 native 修复能力独立返回，不受新增选择影响。

明确 Wechat2RSS 仍需原启用开关和合法私有配置，随后复用原 Provider 与写库前一致性备份。新订阅绑定原 `wechat2rss`；已有 Feed 保持其全部字段和原来源，返回 `sourceBindingChanged:false`。付费受理结果的 `requestedSource` 只表示本次选择，不能冒充已有绑定；`accepted/pending` 仍表示受理待核验。来源不可用或请求失败不自动回退；公开文章链接不接受认证参数。

这是本地未部署的前后端单元；原窗口提供默认/native/Wechat2RSS 选择，明确选择才传 source。没有启用付费来源、切换旧绑定或执行平台请求。

独立复核补充：Wechat2RSS 添加复用原进程内 Set，在备份及上游受理前串行同来源添加；不同文章链接可能属于同一公众号，不能仅按链接互斥。并发请求明确 CONFLICT，成功或失败均释放锁，不自动重试；native 账号锁独立。这不是持久幂等或跨重启至多一次保证。

## 拟新增内部应用契约

下面的名字和字段是本项目的设计，不是供应商响应，也不是已注册端点。实施时先固定共享 DTO 与 contract tests，再选内部 tRPC/HTTP facade 的最终命名。供应商 API Key、原始作者游标和含认证参数的 URL 不返回浏览器。

| 拟新增操作                       | 最小输入                                    | 最小输出/约束                                                                   |
| -------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| `sources.capabilities`           | 无                                          | 平台、已配置来源、可做列表/正文/图片/分页的核验状态；配置存在不等于实测通过     |
| `authors.list`                   | 平台筛选、分页                              | 内部作者 key、平台、显示名、启用状态、来源能力、最近结果；微信映射原 Feed       |
| `authors.preview/confirm`        | 公开输入候选 / 短时服务端候选引用＋明确确认 | 预览不写成功绑定；只有真实身份核验后确认。不得提交任意名称/笔记归属冒充已核身份 |
| `updates.create`                 | 选定内部作者 key、幂等键、已确认预算引用    | taskId、受理状态；服务器解析来源与预算，不接受任意上游 URL/HTML                 |
| `updates.status`                 | taskId                                      | 逐作者阶段、窗口覆盖、计数、错误、开始/完成时间；查询不触发采集                 |
| `updates.cancel`                 | taskId                                      | 仅取消未开始项；已发请求不能撤回                                                |
| `items.list/detail`              | 内部作者 key、分页或内部内容 key            | 通用元数据、可信发表时间、正文和图像完整性、缓存版本                            |
| `exports.create/status/download` | 已归档内部内容/作者引用                     | 受保护、有界的实际 ZIP 下载；缓存缺失返回缺口，不隐式抓平台                     |

候选 `NormalizedItem`：`platform`、`authorKey`、`externalItemId`、`publicUrl`、`title`、`publishedAt`、`body`、`media[]`、`bodyStatus`、`mediaStatus`、`provenance`。这是内部目标模型，尚未保存到数据库；具体上游映射必须用实样证实。`publishedAt` 不可由抓取时点填补；`media[]` 保留顺序和本地可信字节引用，缺少真实字段时保持未核验，不猜 URL。

微信的身份规则继续用已有 canonical `biz/mid/idx`，保留旧短链 ID。小红书拟用“平台＋真实作者 ID”“平台＋真实笔记 ID”；严格格式依据实样确定，不从微信 ID 衍生。短链解析、nickname 和发布时间仅辅助显示，不能作合并键。

## 手动批次与请求语义

候选任务阶段：`queued → running → finished`，另有 `cancelled/interrupted`；作者结果分开表示完整图文、部分、待上游、阻塞、失败。保存阶段含列表/详情/图片；窗口完整性独立于批次结束。既有结果 `complete:false` 表示来源覆盖有限，不能直接把它解释为所有图文均失败。

幂等键只针对本次显式用户操作，不跨天复用。首期复用已有进程内互斥和来源回执，限制同一操作的重复提交；跨端接缝确认后再落实其最小请求语义。进程中断或上游返回不确定时保持未知，不自动重放。当前没有持久批次、预算保留或跨重启幂等记录，不能承诺崩溃后仍至多一次；这些持久恢复能力另属扩展。共享认证/余额限制暂停该来源组，单篇内容失败保留其他完成项。取消不清理已存文章，也不恢复旧停止。

列表游标按来源保存在服务端，检测重复游标/重复页；触及上限标窗口未完成。小红书置顶、排序不稳定及删除意味着“遇到第一条旧笔记就终止”不能作为默认算法。只有实证明确的终止条件才推进连续覆盖检查点；抓取时间和最后成功检查时间分开保存。

## 上游字段与适配状态

| 来源          | 已有/公开可核的接口用途                                                                                           | 当前未知与门禁                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wechat2RSS    | 现有代码读取 `/login/list`、分页 `/list`、`/addurl`、`/add/:id`、`/feed/:id.json`；官方还列 `/api/query` 日期过滤 | JSON Feed 的原文稳定身份、正文、时间和图片需当前实例验证；`/api/query` 文档样例未提供足以单独完成本项目身份映射的全部字段。未实现 query 历史适配，不凭过滤参数编造无限分页 |
| Rnote A       | 公开文档列 `user/info`、`user/posted` 的游标入参、`note/image` 的用途；认证为服务端 header                        | 本项目无 adapter；列表数组路径、作者/笔记归属、返回游标/终止、时间语义、全文与图片字段按当前 OpenAPI 和实样确认。评论游标格式不挪用到作者列表                              |
| Web＋蒲公英 B | 供应商源码候选                                                                                                    | 当前无源码/运行实例合同；不能将 A 的路径、参数或字段假定为 B。等待邮件、文档和样例                                                                                         |

公开供应商依据集中在[技术方案](TECHNICAL_DEPLOYMENT.md#供应商证据与采购门槛)，本轮只浏览公开文档，没有调用带 Key 的接口或平台内容端点。

## 存储方案与旧数据保护

微信原 `Feed/Article` 和现有迁移保持，来源切换需原身份对应一致、备份及副本演练；不能更新 `mpId` 为小红书用户 ID，也不能批量重写旧 ID。现有 `Article` 有微信语义的 `mpId` 外键，`SubscriptionProvider/assertProviderPage` 依赖微信 canonical 身份。

已追加最小独立 `XhsCreator/XhsNote` 两表及正式受保护 `xiaohongshu` 路由，保留微信身份适配；不新增媒体或任务表、不迁移旧公众号。正文内缓存已核图片字节，复用原 Markdown 与 ZIP 导出器。生产未执行迁移，内部来源未注册；A/B 字段映射仍待实样。正式待接入名单、内容查看、刷新及下载门禁与迁移保护见 [小红书正式接线](../XIAOHONGSHU_INTEGRATION.md)。所有迁移只追加，先在副本检查旧表逐字段全等和还原。

保存不按标题或列表位置合并。空值/摘要/图片失败不覆盖可信正文；上游删除、订阅取消和本地删除分离；已有有效指标保留。新正文编辑保留原可信版本，接受新版本必须有完整性和来源记录。

Sites 同步采用最小展示 DTO，不同步生产数据库、账号表、token、停止原始文件或本机目录。若采用云端正文/图片副本，访问权限、删除和容量另行明确。

## 合同测试准备

采购前测试按实际接缝准备：重复页/游标、作者不符、缺发表时间、摘要正文、图序冲突、假图/截断图、视频跳过及异步受理未完成已有相关合成覆盖，具体以对应测试为准。供应商图片过期、真实额度/扣费和跨端幂等语义仍待接口确认，不能算作已完成验证。样例明确为合成数据，禁用真实网络；需要存储的测试只使用临时 SQLite 副本，纯模型测试不写库。

已有微信测试优先复用：`providers/wechat2rss.spec.ts`、`provider-article.spec.ts`、`channel-routing.spec.ts`、`sqlite-backup.spec.ts`、`article-verified-download.spec.ts`。本轮新增 `trpc/subscription-source-selection.spec.ts`：实际 router、Provider、临时 SQLite 与一致性备份，只合成上游响应。覆盖明确选择/旧默认、配置门禁、备份失败、请求失败、旧 Feed/Article/Account 全字段保持与认证拒绝；相关旧入口/UI/修复测试复用，不重复全项目审计。

## 小红书内部离线合同（不接供应商）

新增 `collection/xiaohongshu-contract.ts`，仅处理本项目正规化候选：平台＋作者/笔记 ID 分别编码；作者归属必需一致；发表时间为整数秒，缺失或毫秒值拒绝，不用采集时点补齐。A/B 字段路径、ID 具体语法、时间转换、游标和终止实样仍未知，不包含任何上游 adapter。

分页账本去重同页/跨页笔记，拒绝重复请求游标、循环和归属冲突；重复页或旧置顶不提前结束。页预算触达是窗口停止，供应商报告结束只记 supplierReportedEnd，不证明全历史齐全。

归档候选保持段落及图序，只接已在内存的图片字节，复用原离线图片容器检查；没有下载、域名放行或保存新表。摘要、未知图片总数、缺图和无效字节不能进入待完整证据检查状态；视频单独跳过。候选始终 verified:false，不能成为可信 Provider 或已归档正文。旧完整候选不被空值/摘要覆盖，既有微信表、保存器及域名限制保持。

图片数组逐位检查，稀疏空位也拒绝；数组长度与期望数量相等不能代替每张实际字节。该缺口已有先失败再修复的合成回归。

真实首轮只验一个博主前三篇，遇非图文如实跳过；后续确有需要再明确扩样。
