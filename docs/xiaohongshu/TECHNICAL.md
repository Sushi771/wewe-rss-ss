# 小红书订阅技术说明

来源互动指标使用笔记详情 interact_info，粉丝来自 interactions 中的 fans 项。仅接受精确非负整数；缺失、缩写和 following 不明时保留未知。当前整号任务不调用主评论或回复，历史评论表及接口保留供兼容，不应将历史能力描述为本轮采集或展示目标。

`refresh({id,maxPages?})`接受1–10页的可选上限，现有前端明确传2。上限冻结在任务document，不新增迁移；每次明确续跑从持久游标开始重新计算该次页数，达到上限且仍有后续时返回`XHS_LIST_PAGE_LIMIT_REACHED`，不派发下一页。未提供上限的旧内部调用保持兼容。

此处是请求页数限制，并非累计30条或60条上限。来源请求30条只是期望页大小；每个响应最多接受60条，完整保留合法返回，不擅自截断。两页可能合计62条；已有32条完整入库及61条整页拒绝反例，不能据页数合同推导固定累计条数。

下载回执的完成收敛要求 `failed=remaining=0`、完成与跳过之和等于总数，且冻结的每个选中ID均有 completed/skipped 记录；不能仅据计数判定成功。最后检查点失败后只重写本地终态，绝不重做来源/文件动作；最终写入仍不确定则保持屏障。已持久化但旧码为UNCERTAIN的完整回执，结算后只在公开视图收敛为completed；下载没有未完成项时，UI和resume接口都禁止空续跑。列表remaining=0但有游标的续跑语义不变。

图文 `prepareLocalDownload` 只从严格校验的缓存身份三元组构造 `https://www.xiaohongshu.com/explore/<noteId>`，以单个Markdown链接写入正文来源块。该准备器不再让保存器的源元数据重复添加同一URL；标题仍由原模板生成一次。不请求原文，不重写既有文件。

`connectionStatus.requestAttempts`只返回进程实例ID及profiles/lists/details/media/shortLinks计数，不包含URL、token、请求头或响应。计数在来源传输被调用前递增，表示已发起或结果未知的尝试，不能把超时解释为零请求；状态读取和会话恢复不重置或增加它。比较前后差值必须确认实例ID相同，重启后的计数不能与旧实例直接相减。

2026-10-24 对照源码 `9e1b81a8d095390bce968a137fd88d23ba5252df` 校准，原始基线为 `f609bda0334f17f6c28ff84020d31cd5c47f3417`。既有接口与后续改进设计分开标注；本机安装版本与运行状态仅留私有发布记录。

## 架构与数据

`XhsSubscriptionService` 管解析确认、仅列表任务、详情下载和续跑；`XiaohongshuService` 保留博主管理、分组、缓存查询、正文和ZIP。前端继续使用原小红书页面，通用控件复用 `SubscriptionPrimitives.tsx`、`ArticleDateFilter` 和 `ManagementFolders`。

复用 `XhsCreator` / `XhsNote`、稳定平台/笔记元组ID、`ManagementGroup`、`xhsArchiveDraft`、`LocalArticleStore` / `buildCompleteArticleDownload`。迁移 `20261024000000_xhs_subscription_tasks` 追加任务表 `xhs_subscription_tasks(id,creator_id,state,document,updated_at)` 和作者/状态索引。任务document含计数、选中ID及逐项回执、列表游标/历史/已见ID、完成标记和下载目录，属于私有数据库内容，不进入Git。

所有任务持久化和业务修改沿 `incrementalWrite → sqliteWrites → Prisma transaction`；每页笔记与下一游标在同一事务提交。沿用 [备份协调](../SQLITE_BACKUP_COORDINATION.md)，不在事务内申请备份、不自动重放事务或上游请求。

## 共享接口契约

共享类型位于 `packages/shared/src/xhs-subscription.ts`，router沿用 `protectedProcedure`。

| 调用                                                      | 输入                                                                                                                | 返回/职责                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `resolveSubscription`                                     | `{url}`                                                                                                             | `{resolutionId,inputKind,author,existingCreatorId,expiresAt}`，只解析               |
| `subscribe`                                               | `{resolutionId,groupId?}`                                                                                           | `{creatorId,created,subscribed:true}`                                               |
| `refresh`                                                 | `{id,maxPages?}`                                                                                                    | `{taskId,creatorId}`，仅列表                                                        |
| `downloadNotes`                                           | `{creatorId,noteIds,pickToken?}`                                                                                    | `{taskId,creatorId}`，选中详情与本机保存                                            |
| `task`                                                    | `{taskId}`                                                                                                          | 持久任务的公开状态快照                                                              |
| `recentTasks`                                             | `{creatorId?,limit?}`，默认10、最大20                                                                               | `{items:XhsSubscriptionTask[]}`，返回活动或可恢复任务，排除已被后继接管及已完成任务 |
| `cancelTask`                                              | `{taskId}`                                                                                                          | 返回任务快照，当前原子保存可能尚在收尾                                              |
| `resumeTask`                                              | `{taskId,pickToken?}`                                                                                               | 新 `{taskId,creatorId}`，复用旧检查点                                               |
| `notes`                                                   | `{creatorId?,groupId?,search?,dateStart?,dateEnd?,metric?,min?,max?,metricDirection?,offset?,limit?,queryVersion?}` | `{items,total,queryVersion}`，全保存范围先过滤再分页；过期明确重读                  |
| `export`                                                  | `{creatorId?,groupId?,search?,dateStart?,dateEnd?,metric?,min?,max?,metricDirection?,queryVersion?,noteIds?}`       | `{filename,mimeType,base64,notes}`，完整缓存ZIP；显式ID每批1–100个                  |
| `connectionStatus`                                        | 无                                                                                                                  | 连接、保存与平台验证状态，不含秘密                                                  |
| `connectSession` / `restoreSession` / `disconnectSession` | 最小会话字段及可选保存 / 无 / 无                                                                                    | 显式连接、恢复或断开，本机同源保护                                                  |

`inputKind='note'|'profile'`；`author={id,name,profileUrl,avatarUrl?}`；`existingCreatorId` 无值为 `null`；`expiresAt` 为Unix毫秒。解析ID及任务ID是UUID，博主ID最长128、笔记ID最长300、URL最长8192、pickToken最长128字符。日期使用共享上海自然日过滤，起止必须有序。

任务快照含 `taskId,creatorId,kind:list|download,state,total,completed,skipped,failed,remaining,code?,message,resumable?`。下载中四类计数互斥，`remaining=total-completed-skipped-failed`；续跑移除失败项回执并将其重新纳入剩余。列表 `total` 是已经枚举的唯一ID数，`completed` 是新增记录、`skipped` 是已有记录，未枚举的后续总量未知，因此 `remaining=0` 不证明列表已结束。

解析链接、刷新列表、下载、续跑和连接管理要求本机同源上下文，并拒绝private-online及acceptance mode；其他操作继续登录保护。连接管理还须有runtime实例。任务快照不返回原始document、目录或来源令牌。

## 解析与显式订阅

URL校验允许HTTPS的 `www.xiaohongshu.com/user/profile/{id}`、`/explore/{id}`、`/discovery/item/{id}`，以及 `xhslink.com/{id}` 或 `/a/{id}` 短链。拒绝凭据、显式端口、fragment、空白/控制符和反斜杠；短链不接受query。短链逐跳手动检查，最多5跳、每跳10秒，不带环境认证，拒绝循环、外域及非重定向响应。

可信adapter返回作者及输入类型，服务端核对ID、非空名称和规范主页。解析结果只存进程内Map，有效10分钟，清理过期后最多100个；重启需重新解析。确认只提交resolutionId，不接受客户端作者证据。

事务按上游作者ID或规范主页查找旧博主，校验作者冲突与小红书分组，复用原ID。显式传groupId更新分类，省略保留。旧 `add` 待接入接口仍兼容保留，新UI用解析确认流程；确认不读列表，首次确认后的列表请求由前端单独发起。

## 列表、下载和持久检查点

列表按来源游标持续枚举，不沿旧刷新页数窗口停止。请求页大小不等于响应条目上限；映射与入库接受最多60条有限单页响应，超限整页拒绝。游标最长2048字符；作者、类型、稳定ID和时间校验后，每页元数据及检查点原子提交。时间可为0表示未知，不用采集时刻冒充。跨页重复去重、重复游标、空页续游标及仅重复ID却继续翻页均有停止检查。已完整笔记不被新元数据降级。

下载接受非空去重选择，按100个ID分块校验归属，没有固定100篇总选择上限。先消费原目录选择许可，再逐项详情；完整缓存可直接复用。详情须匹配作者/笔记、完整正文、预期图数、顺序及实际字节。先写完整缓存，再调用原保存器；缓存成功而本机失败仍不是保存完成。未缓存视频跳过，已完成项保留；详情/媒体/保存失败停止后续派发，回执为blocked或partial。

同博主只允许一项未释放任务，活动队列最多20项，执行lane串行。取消通过AbortSignal停止在途来源读取，并停止后续工作；已提交页与原子保存不回滚。任务退出后才可续跑，`resumable` 反映执行器释放。续跑生成新ID，保留列表游标及已完成/跳过项，失败下载重新纳入。下载须重新取得目录许可且与旧目录一致。

列表/下载任务重启将queued/running持久任务标记为 `blocked/XHS_TASK_INTERRUPTED`，不发网络；用户显式续跑。该机制针对单一本机后端，不提供多进程调度保证。

### 任务一致性改进（隔离候选，未部署）

受保护的 `recentTasks` 提供任务发现，活动任务优先，其后按更新时间和ID稳定排序；可按博主过滤。快照增加 `resumedFromTaskId` / `supersededByTaskId`。恢复创建后继与标记前驱在同一事务中完成；旧任务不能重复产生后继，也不能用迟到回执覆盖接管关系。前端页面以limit=10读取最近任务，保持后端顺序；唯一候选可采用，多候选由用户选择。重进与重读仅查询状态，继续必须显式操作。真实HTTP联调沿该前端恢复助手、实际tRPC路由与临时SQLite验证。

基线finally的终态persist抛错会跳过pending/controller释放，已用真实临时SQLite和原保存器重现。候选通过嵌套finally保证执行器释放；提交应答丢失时独立重读持久行，不能确认则保留本机回执屏障，返回 `XHS_TASK_RECEIPT_UNCERTAIN` 且 `resumable:false`，禁止重放。查询可进行本地核对，不调用来源；核对成功后可变为可恢复。私有记录可保留未知回执历史；本地核对完成且屏障已解除后，公开快照改为 `XHS_TASK_CHECKPOINT_RECONCILED`，避免前端对未知代码的安全阻挡永久锁死已核对任务。继续仍须最新 `resumable:true` 且未被后继接管。业务错误保留安全错误码。

## 原始证据与独立核对

专家从解析前和保存后的材料两端检查，不能只核对应用生成的摘要：

| 原始材料类别                                   | 要证明什么                                   | 独立检查方式                                                                   |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| 获授权留存的原响应字节及请求、游标关联 | 作者、条目集合和分页语义 | 独立枚举原结构并与落库稳定 ID 集合对照，不调用被测映射器 |
| 原正文与实际Markdown字节                       | 没有删段、改序、替换字符或摘要冒充全文       | 独立提取段落，仅允许HTML/Markdown转义与空白规范化，保留标点、Unicode字符及顺序 |
| 原图片字节及有序来源清单、实际保存图片         | 图片正确、完整且次序一致                     | 独立解码器检查可打开，逐项比对内容哈希和有序引用；同图数不能代替身份与顺序     |
| SQLite事务前后副本、任务原始行、注入故障时间线 | 提交与任务状态一致、旧内容保留、不重放       | 独立SQLite查询/完整性及外键检查、非目标字段对照、记录实际请求次数              |
| 固定源码、依赖锁、构建清单、产物及恢复副本     | 运行代码来源完整且可恢复                     | 干净隔离重建，逐输入/产物核对；包若含时间戳则明确比较规则，不伪称逐字节可重现  |

正文允许的规范化只有转义和空白；不得以删标点、Unicode折叠、排序段落、忽略差异或重新摘要获得相等。独立核对不复用被测解析器及其输出作为唯一期望值；独立图片解码也不单独证明图片来自正确笔记。测试用合成原始字节与手工核实的期望，真实原始材料仅留私有证据区，本轮不读取。

## 搜索、页面和导出范围

`notes` 可查询全部、分组或作者；标题、作者名称、已有正文的可见文本共用同一过滤语义，排除 HTML 标签和图片 data URI。正文缺失时不自动抓取。指标排序应在完整已发现的筛选集合上执行后再分页，不将已加载页面冒充完整范围；未知值保持未知。筛选、服务端时间排序或分组变化须使旧选择及查询范围失效；本地指标排序不改变筛选集合，保留选择。

ZIP的选中范围取当前完整缓存选择；当前筛选/全部先通过notes查询，在前端冻结ID，全部范围忽略搜索、日期及分组（选中作者时仍限该作者）。跨作者范围按作者分派，再以100篇串行请求export，逐包核对notes回执；不受UI20行限制，但没有服务端持久范围快照。每包缓存正文/视频预算25MB，超限拒绝，取消或未知回执停止后续包。ZIP仅用缓存字节，原导出器禁止网络回退。图文ZIP沿原Markdown/相对附件布局，本机保存仍沿每篇正文.md和image/布局。

## 来源与验收边界

`TrpcModule` 已注册默认关闭的 `XHS_SUBSCRIPTION_SOURCE`。只有显式启用、非 private-online/acceptance、显式连接且持久风险和预算门闸允许时才可联网；启动不自动解密或恢复登录。来源拒绝后保留固定风险状态，恢复、断开或重新连接不会清除；没有可核验解除证据时保持停止。

Windows凭据库为SQLite所在目录下 `.wewe-xhs-session/session.dpapi`，CurrentUser DPAPI与当前用户ACL保护，仅保存a1/web_session；子进程stdin传递，不用命令参数或日志。旧单篇测试凭据库不自动导入，正式复用需单独明确范围。显式断开中止在途请求、清进程会话/令牌上下文并删除应用保存文件，不登出日常浏览器。

原生HTTPS传输只允许edith指定的otherinfo/user_posted/feed路径，禁止重定向和隐式重试；媒体只允许已审核CDN，独立无Cookie请求，按实际流式字节及原归档预算限制。HTTP媒体候选仅对原白名单同主机同路径升级HTTPS，正常校验证书。真实规格以响应和解码为准。

默认工厂配置严格otherinfo解析器：要求内部result成功及basic_info的有界昵称/展示号；稳定作者ID绑定已签名target_user_id及完全匹配的响应URL。red_id不作为稳定ID，响应携带冲突user_id立即拒绝。列表显式使用既有上游支持的v1路由，不自动重试或切换端点。请求30不保证只返回30；映射与入库最多接受60条有限单页响应，保留全部合法条目，不静默截断。合成回归覆盖32条完整提交和61条整页拒绝。真实验收对象、实际请求和归档结果仅留获授权的私有记录；有后续游标时不宣称全史完成。验收合同见 [ACCEPTANCE](ACCEPTANCE.md)。

## 周期退役覆盖比较

`backup-sqlite.py::snapshot_covers` 仅豁免普通 `feeds.sync_time`、`update_time`、`updated_at`、`last_collection_result`、`provider_refresh_attempt_time`。`has_history`、主键、生成列、其他表同名字段与schema继续严格。`indexed_reference_review` 只核已登记根的顶层元数据并绑定命名空间/身份/SHA，未知项不放行；`indexed_typed_coverage` 在SQLite内部比较所有类型值，只返回计数，REAL位级证明不足时保持阻塞。同schema保留点可作覆盖见证，不强迫新schema的pending越过结构检查。此只读计划路径不调用旧全局时间分层扫描/执行入口；永久动作仍须单独批准及原生句柄、引用、占用和生命周期复核。

## 统一候选：目录保存、接口与最小发布

博主指标刷新必须先将同一响应交给既有注入 profileParser(raw, expectedAuthorId)，复用其内层 result 与显式 user_id 校验；解析失败或作者身份不符时不进入写事务，原完整快照和采集时间保留。不能仅凭 interactions 粉丝数写入指定博主。

日常主流程是直接保存到本地/Obsidian 目录：每篇正文.md、image/ 与已核验完整视频的 video/，无需压缩或解压。工具栏主按钮沿用直接保存；“更多”保留已选完整归档的直接保存及兼容 ZIP 入口。ZIP 是可选传输格式，其测试不能替代目录落盘验收。

`prepareLocalDownload` 与视频模板共用严格稳定身份 canonical helper；返回 sourceUrl=null，正文只保留一次原文链接，避免保存器再插一次。控制器 exportSource 包装透传 afterSave；afterSave 即使正文已存在也运行。快照以 note 身份及内容哈希命名，原子硬链接发布；相同内容复用，用户修改旧附页则保留并创建/复用冲突版本。发布失败明确失败。直接保存回执独立报告 snapshotsSaved / snapshotSavedCount，不能用 body skipped 冒充新评论已更新。

`notes` 在全保存范围过滤后给 total/queryVersion；跨页保持同版本，筛选或服务端时间排序变化使旧选择失效。本地指标排序对全部筛选结果排序后分页，保留已选笔记并回到第一页。指标保留来源采集时间，缺失、缩写或非精确值为 null。当前任务不隐式采集评论正文或回复。

发布由统一负责人核准后执行：1）固定最终 SHA 和依赖锁，校验离线 CI；2）先停止唯一写者，按既有增量写入/备份政策确认恢复点，不为前端修改复制整库；3）应用候选所需的增量迁移，检查外键与原公众号行摘要；4）切换同 SHA server dist、client 和 schema，保持来源开关关闭；5）启动并读回运行 SHA，再按单独获准范围做目录验收。实际执行状态仅留私有发布记录。

回滚使用事先验证、与现场记录匹配的上一个程序和前端包；保留新增 XHS 表和文件，禁止 down/drop 或删除新附页。合成库兼容不等于旧进程在生产环境已验收；恢复时核对实际版本、迁移记录与风险状态，不重跑已应用迁移。

最小真实验收优先复用已获授权的既有归档，避免为重验重复采集：核对正文、媒体顺序与字节、原文链接及可读性，重复保存时保护手改文件。指标字段的真实来源验证须遵守单独批准的请求范围和上限；当前不采集评论正文或回复。合成结果不替代真实来源与 Obsidian 验收，未知故障和历史回执不得推测改写。

## 整号任务、原子预算与分段附页

增量迁移 20261025120000_xhs_request_budget 新增两张小表，不改写既有文章/评论。毫秒时间列采用 BIGINT，避免SQLite/Prisma的32位整数解码。XhsSqliteBudgetStore 以单条条件 UPDATE ... RETURNING 在派发前预留，used不退款；未收到回执也占额度。AsyncLocalStorage 将预算传播至列表、详情、主评、回复、媒体、短链及上下文刷新实际transport；运行时既有计数仍保留。

XhsWholeCreatorService 使用既有增量写入协调器和单执行队列，持久记录列表、正文/媒体归档、逐篇指标及本地保存回执。当前整号任务不派发主评论或回复分页：完成条件只检查当前范围内的归档、指标与本地保存。历史评论和窗口保持不变，指标覆盖标为 metrics-only，不冒称评论完整。旧暂停任务明确继续时沿既有游标和预算保留已确认指标，不重新请求已完成阶段；重启不自动派发。

API：wholeCreatorJobs、startWholeCreator、resumeWholeCreator、cancelWholeCreator、extendWholeCreatorBudget 均沿现有保护路由，写操作要求现有本地访问边界。查询为本地只读。全局live/comment gates仍生效，不增加凭据入口。

历史已存评论的大数据导出能力保留：既有实现分页读取、分段与防覆盖发布，不因暂停新采集而删除旧数据。这是本地已有数据的历史能力，并不表示当前任务采集或展示评论正文，也不证明平台评论完整。

## 独立审查修正

显式继续使用受限状态CAS，将cancelled/paused等消费为queued并检查影响行数；普通检查点仍禁止迟到写入覆盖cancelled，并检查零行更新。并发继续只能调度一次。取消后继续的真实数据库与执行链反例保留。

目录阶段只认原生保存器成功返回、且随逐篇任务检查点落盘的正文/媒体与附页回执；DB status=complete或视频skipped不是目录证据。旧下载任务completed而仍有待补时，按原目录授权边界创建新的待补选择并实际保存，不重放已确认保存项。反例通过原生LocalArticleStore发布正文和附页并验证真实文件。

原post-COMMIT lost-ack回归在持久completed可见后显式等待执行lane，再断言pending为空；保留lost=true、saves=1、持久completed及pending=0全部断言，不以sleep消除竞态，也不提前释放持久化屏障。

## 原文跳转与Obsidian下载合同

产品边界：WeWe RSS负责订阅、筛选、指标和下载；当前暂停采集或展示评论正文及回复，仅保留来源返回的评论总数字段。公众号和小红书正文阅读器均已移除，标题打开或显式准备原始链接；正文和媒体仍可下载到 Obsidian 本地阅读，既有用户文件与历史评论数据不删除。

设计前检查：按稳定笔记身份分别核对目录、正文、媒体、指标与本地保存回执，不能以目录结束代替归档完成。评论总数来自笔记详情来源字段，缺失或非精确值保持未知，不借评论分页猜测；历史评论数据独立保存且不宣称完整。

| 需求 | 最小实现位置 | 独立验收与证据 |
| --- | --- | --- |
| 标题准备并打开原文 | 列表标题、prepareOriginalLink及既有canonical helper | 缓存/未缓存/视频均校验同身份官方HTTPS地址；显式准备或重新准备可在持久总预算与风险门闸内恢复来源上下文，缓存命中为零请求，普通浏览/状态查询不发来源请求。浏览器临时签名URL仅在点击响应与内存中使用；Markdown canonical不含访问token。无旧正文API调用或自动重试；合成链接断言不替代真实PC打开验收 |
| 互动指标展示 | 本地已存笔记指标查询、列表列 | 按作者及笔记身份关联；点赞、收藏、分享和评论总数缺失与 0 区分，不展示评论正文或回复 |
| 未知关注默认隐藏 | 博主资料与XhsMetricLine | null隐藏、真实0显示，不新增推测字段或来源请求 |
| 分开下载各阶段 | WholeCreatorService 状态投影、原下载器/保存器 | 目录、正文、媒体、指标和本地保存分别报告；历史评论窗口保留并独立标示，不冒称本轮采集完成 |
| Obsidian本地阅读 | 原 Markdown/媒体导出及既有保存器 | 检查实际正文、相对图片/视频引用、稳定身份、时间和部分状态；历史附页若存在，保留并单独验证 |
| 文件保护与停止 | 原非覆盖发布器、runtime预算与错误码 | 手写正文/附页保护，同版复用，部分失败准确回执；验证拦截后不新增来源请求，缓存下载不作网络回退 |

删除边界：公众号和小红书的平台内正文入口、正文弹窗、ArticleReader及其专用组件、状态、hooks、调用路径均已移除；小红书阅读专用后端API及Sites阅读分支也已删除，不保留无调用的阅读兼容壳。共享article.byId仍被受保护的Sites下载路径用于缓存投影，因此保留；正文/媒体完整性校验、缓存与正文生成、指标评论接口、持久检查点及非覆盖保存均保留。不删除DB或已下载文件，公众号继续打开合法原链接。

技术/API/schema 文档说明必要投影及保护路由。持久来源风险采用增量迁移保存固定非敏感状态；迁移仅能识别任务内已持久化的来源拒绝码，无此记录的既有历史仍需独立核查，不能以空标记证明风险解除。写入失败和未决操作不自动解除。真实正文/媒体采集与原文点击是两回事，用户浏览器打开小红书不授权后台恢复采集。

## PC原文链接准备：最小实现与审查边界

prepareOriginalLink只做已批准的原文跳转准备，不能复活平台正文阅读器。链接须以安全来源noteUrl或同作者、同note、有效上下文为证据；使用字符串身份，保留前导0。来源有显式source应保留；只有作者上下文且无显式source才按固定官方合同取pc_user，不猜token。

所有冷恢复和普通resolveSubscription共享既有持久预算与会话停止规则，缓存命中不得发请求，禁止每次click新建额度、清stopCode、自动重连或重试。短期签名URL/token只留必要内存作用域，成功和异常路径都不得进入logger、任务行或其他持久存储。冻结时必须给出完整调用链和日志投影边界；仅mock prepare返回正确URL不足以证明安全与可用。

前端prepared链接按作者/笔记/操作代次绑定；去重、切换和关闭必须使旧结果失效。通过实际构建的导航拦截记录核对目标而非仅查helper字符串。最终真实PC可读性是独立有界验收，不扩大当前采集许可。


### 派发许可、取消与未知提交

共享额度的计数预留不等于已经派发。最终入口先在短 SQLite 写事务中取得写锁，并通过同一事务重新核对任务是否已取消，再在现有预算表中提交 `xhs:dispatch-pending:` 前缀的内部屏障。第二个短事务再次取得写锁并核对任务状态，随后才同步启动 transport、持久记录实际派发时间并删除该请求自己的屏障。网络响应在事务外等待。

先于最终写锁取得而已提交的取消必须阻止派发；明确未派发时只撤销本次预留。出站后的时钟事务若实际回滚，已提交的屏障继续阻止其他 runtime 和重启后的新请求；已花额度不退款，未知请求不重发。提交成功但确认丢失时，以已持久化的时钟和额度为准，同样不自动重发。

该屏障没有自动到期清理。重连、重启、保存预算或扩额不会消除未完成的派发记账。持续出现请求暂停时，应先核查数据库提交错误与可验证回执；不得通过删除屏障、重置账本或重试未知请求来恢复。此状态不代表来源要求验证码。


## Limited single-note recovery

`recoverSingleNote` is a protected local-only explicit operation requiring a supplied official note URL, an independently known author ID and confirmation. It accepts only a historical-review stop, never a new authentication, verification or signature block. A durable, note/author-bound single-round claim expires after ten minutes and cannot be reissued, resumed or replayed after a crash. The shared source ledger and dispatch clock remain in force. This deliberately narrow flow permits only one detail dispatch; it performs no list, comment, reply, redirect or media requests.

The returned note and author must match both authorized identities. Body text, four metric values and the subscription are committed together with the local recovery receipt. Unknown metrics remain null. Existing content is retained and a disabled subscription is not enabled. No background task or download is queued. Historical risk stays blocked after success; a new refusal is recorded without discarding the previous history.

Images are not fetched in this flow. The receipt lists pending media ordinals, validated CDN source paths with all query parameters omitted, and one-way source fingerprints. Query omission is explicit; these paths must not be treated as verified replayable image URLs or fetched automatically. The note remains listed/partial rather than claiming complete media. Existing full archive/export gates continue to require complete media. Signed original URLs are returned only to the explicit caller with no-store/no-referrer headers, excluded from logging and normal list DTOs. This flow does not prove that a user can open the resulting PC link; actual platform acceptance remains a separate bounded verification.


订阅输入可接受单个官方作者或笔记链接、受限短链，或包含一个此类链接的分享文案；短链展开仍受既有来源预算与重定向检查约束。官方 PC 分享参数 `xhsshare=pc_web` 与原始来源字段保留，重复参数、非官方主机及不受支持的参数仍拒绝。单篇受限恢复不展开短链；历史未知回执不会因输入变化而重置或自动重试。


#### 批量订阅接口契约

命名空间 `xiaohongshu`：`startSubscriptionBatch({clientRequestId, text, groupId?})` 返回批次；`subscriptionBatch({batchId})` 查询；`resumeSubscriptionBatch({batchId, text})` 显式补充上下文并恢复；`cancelSubscriptionBatch({batchId})` 请求取消。所有调用遵循现有本机鉴权。`clientRequestId` 是客户端为同一提交生成的 UUID，重复提交复用原批次，不重复派发。`text` 包含一条或多条官方 URL 或分享文案，最多 100 条有效链接，原始字符总长有界；链接身份去重，非官方和不合法输入按项给固定错误码。

批次返回 `{batchId, state, items}`，状态为 `queued | running | paused | cancelled | completed`；项为 `{index, fingerprint, kind, state, code?, authorId?, creatorId?, duplicateOf?}`，项状态为 `queued | needs_context | resolving | unknown | subscribed | duplicate | failed`。返回值、持久回执和日志不含原始 URL、token 或响应原文。原始上下文仅保存在本进程内；重启后未派发的项进入 `needs_context`，重新粘贴后按无查询参数的官方链接身份匹配；已成功项不再派发。已派发但结果不确定的项为 `unknown`，不自动重试。

按输入顺序逐项处理，复用原来源总预算、派发屏障和风险门闸；来源风险、预算耗尽或不可确定的派发结果暂停批次。作者身份验证后按作者去重，订阅写入和该项成功回执在同一数据库事务内提交。取消在最终派发边界生效；已经派发的项按实际回执或未知状态收口。已有单篇恢复未知记录原样保留；若短链目标尚无法核对该记录，在未解决前不派发该短链。此接口不创建历史归档或评论任务。


受限单篇恢复允许用户明确确认对原未知回执追加一次尝试。追加记录与原笔记及作者绑定，原回执保留；共享来源预算仍按累计使用量限制，拒绝或未知结果停止且不自动重放。追加不代表历史风险已解除，不下载额外媒体或采集评论正文。
