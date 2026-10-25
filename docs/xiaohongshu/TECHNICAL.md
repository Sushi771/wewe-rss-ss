# 小红书订阅技术说明

2026-10-25 开发补充：新增三张 XHS 投影表，不改公众号表；四数来源为 interact_info，粉丝来源为 interactions[type=fans].count，following/评论时间/精确回复对象无契约时 null。公开 main 自报 redbook 0.8.2，未声称 npm 包逐字节核验。评论 HTTP 只读 routes 与原签名/单次请求运输复用，须额外 `XHS_COMMENT_COLLECTION_ENABLED=1` 且原 live gate 和会话就绪才可执行；本轮未开启。每页评论与游标同事务，rootId 仅表达楼层，parentId 未知。notes offset>0 需回传 queryVersion，过期报 XHS_QUERY_STALE_RESTART，筛选导出也可校验同一版本。LocalArticleStore 的可信 afterSave hook 在正文保留后仍执行，XHS 附页通过内容摘要命名、原子非覆盖发布；手改冲突产新版本，失败不能报告快照成功。详见 [字段/数据流/回退矩阵](../XIAOHONGSHU_INTEGRATION.md)。

`refresh({id,maxPages?})`接受1–10页的可选上限，现有前端明确传2。上限冻结在任务document，不新增迁移；每次明确续跑从持久游标开始重新计算该次页数，达到上限且仍有后续时返回`XHS_LIST_PAGE_LIMIT_REACHED`，不派发下一页。未提供上限的旧内部调用保持兼容。

`connectionStatus.requestAttempts`只返回进程实例ID及profiles/lists/details/media/shortLinks计数，不包含URL、token、请求头或响应。计数在来源传输被调用前递增，表示已发起或结果未知的尝试，不能把超时解释为零请求；状态读取和会话恢复不重置或增加它。比较前后差值必须确认实例ID相同，重启后的计数不能与旧实例直接相减。

2026-10-24 对照公开源码 `9e1b81a8d095390bce968a137fd88d23ba5252df` 校准，原始基线为 `f609bda0334f17f6c28ff84020d31cd5c47f3417`。对应本机 r2 已上线；本节既有接口与后续改进设计分开标注。

## 架构与数据

`XhsSubscriptionService` 管解析确认、仅列表任务、详情下载和续跑；`XiaohongshuService` 保留博主管理、分组、缓存查询、正文和ZIP。前端继续使用原小红书页面，通用控件复用 `SubscriptionPrimitives.tsx`、`ArticleDateFilter` 和 `ManagementFolders`。

复用 `XhsCreator` / `XhsNote`、稳定平台/笔记元组ID、`ManagementGroup`、`xhsArchiveDraft`、`LocalArticleStore` / `buildCompleteArticleDownload`。迁移 `20261024000000_xhs_subscription_tasks` 追加任务表 `xhs_subscription_tasks(id,creator_id,state,document,updated_at)` 和作者/状态索引。任务document含计数、选中ID及逐项回执、列表游标/历史/已见ID、完成标记和下载目录，属于私有数据库内容，不进入Git。

所有任务持久化和业务修改沿 `incrementalWrite → sqliteWrites → Prisma transaction`；每页笔记与下一游标在同一事务提交。沿用 [备份协调](../SQLITE_BACKUP_COORDINATION.md)，不在事务内申请备份、不自动重放事务或上游请求。

## 共享接口契约

共享类型位于 `packages/shared/src/xhs-subscription.ts`，router沿用 `protectedProcedure`。

| 调用                                                      | 输入                                                         | 返回/职责                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `resolveSubscription`                                     | `{url}`                                                      | `{resolutionId,inputKind,author,existingCreatorId,expiresAt}`，只解析               |
| `subscribe`                                               | `{resolutionId,groupId?}`                                    | `{creatorId,created,subscribed:true}`                                               |
| `refresh`                                                 | `{id}`                                                       | `{taskId,creatorId}`，仅列表                                                        |
| `downloadNotes`                                           | `{creatorId,noteIds,pickToken?}`                             | `{taskId,creatorId}`，选中详情与本机保存                                            |
| `task`                                                    | `{taskId}`                                                   | 持久任务的公开状态快照                                                              |
| `recentTasks`                                             | `{creatorId?,limit?}`，默认10、最大20                        | `{items:XhsSubscriptionTask[]}`，返回活动或可恢复任务，排除已被后继接管及已完成任务 |
| `cancelTask`                                              | `{taskId}`                                                   | 返回任务快照，当前原子保存可能尚在收尾                                              |
| `resumeTask`                                              | `{taskId,pickToken?}`                                        | 新 `{taskId,creatorId}`，复用旧检查点                                               |
| `notes`                                                   | `{creatorId?,groupId?,search?,dateStart?,dateEnd?}`          | 全部/分组/作者匹配元数据，无cursor/take服务端分页                                   |
| `export`                                                  | `{creatorId?,groupId?,search?,dateStart?,dateEnd?,noteIds?}` | `{filename,mimeType,base64,notes}`，完整缓存ZIP；显式ID每批1–100个                  |
| `connectionStatus`                                        | 无                                                           | 连接、保存与平台验证状态，不含秘密                                                  |
| `connectSession` / `restoreSession` / `disconnectSession` | 最小会话字段及可选保存 / 无 / 无                             | 显式连接、恢复或断开，本机同源保护                                                  |

`inputKind='note'|'profile'`；`author={id,name,profileUrl,avatarUrl?}`；`existingCreatorId` 无值为 `null`；`expiresAt` 为Unix毫秒。解析ID及任务ID是UUID，博主ID最长128、笔记ID最长300、URL最长8192、pickToken最长128字符。日期使用共享上海自然日过滤，起止必须有序。

任务快照含 `taskId,creatorId,kind:list|download,state,total,completed,skipped,failed,remaining,code?,message,resumable?`。下载中四类计数互斥，`remaining=total-completed-skipped-failed`；续跑移除失败项回执并将其重新纳入剩余。列表 `total` 是已经枚举的唯一ID数，`completed` 是新增记录、`skipped` 是已有记录，未枚举的后续总量未知，因此 `remaining=0` 不证明列表已结束。

解析链接、刷新列表、下载、续跑和连接管理要求本机同源上下文，并拒绝private-online及acceptance mode；其他操作继续登录保护。连接管理还须有runtime实例。任务快照不返回原始document、目录或来源令牌。

## 解析与显式订阅

URL校验允许HTTPS的 `www.xiaohongshu.com/user/profile/{id}`、`/explore/{id}`、`/discovery/item/{id}`，以及 `xhslink.com/{id}` 或 `/a/{id}` 短链。拒绝凭据、显式端口、fragment、空白/控制符和反斜杠；短链不接受query。短链逐跳手动检查，最多5跳、每跳10秒，不带环境认证，拒绝循环、外域及非重定向响应。

可信adapter返回作者及输入类型，服务端核对ID、非空名称和规范主页。解析结果只存进程内Map，有效10分钟，清理过期后最多100个；重启需重新解析。确认只提交resolutionId，不接受客户端作者证据。

事务按上游作者ID或规范主页查找旧博主，校验作者冲突与小红书分组，复用原ID。显式传groupId更新分类，省略保留。旧 `add` 待接入接口仍兼容保留，新UI用解析确认流程；确认不读列表，首次确认后的列表请求由前端单独发起。

## 列表、下载和持久检查点

列表按来源游标持续枚举，不再沿旧刷新最多三页。请求页大小30不等于响应条目上限：已核实一次返回32，映射与入库允许最多60条有限单页响应，保留全部合法项，61条整页拒绝。游标最长2048字符；作者、类型、稳定ID和时间校验后，每页元数据及检查点原子提交。时间可为0表示未知，不用采集时刻冒充。跨页重复去重、重复游标、空页续游标及仅重复ID却继续翻页均有停止检查。已完整笔记不被新元数据降级。

下载接受非空去重选择，按100个ID分块校验归属，没有固定100篇总选择上限。先消费原目录选择许可，再逐项详情；完整缓存可直接复用。详情须匹配作者/笔记、完整正文、预期图数、顺序及实际字节。先写完整缓存，再调用原保存器；缓存成功而本机失败仍不是保存完成。未缓存视频跳过，已完成项保留；详情/媒体/保存失败停止后续派发，回执为blocked或partial。

同博主只允许一项未释放任务，活动队列最多20项，执行lane串行。取消通过AbortSignal停止在途来源读取，并停止后续工作；已提交页与原子保存不回滚。任务退出后才可续跑，`resumable` 反映执行器释放。续跑生成新ID，保留列表游标及已完成/跳过项，失败下载重新纳入。下载须重新取得目录许可且与旧目录一致。

重启将queued/running持久任务标记为 `blocked/XHS_TASK_INTERRUPTED`，不发网络；用户显式续跑。该机制针对单一本机后端，不提供多进程调度保证。

### 任务一致性改进（隔离候选，未部署）

受保护的 `recentTasks` 提供任务发现，活动任务优先，其后按更新时间和ID稳定排序；可按博主过滤。快照增加 `resumedFromTaskId` / `supersededByTaskId`。恢复创建后继与标记前驱在同一事务中完成；旧任务不能重复产生后继，也不能用迟到回执覆盖接管关系。前端页面以limit=10读取最近任务，保持后端顺序；唯一候选可采用，多候选由用户选择。重进与重读仅查询状态，继续必须显式操作。真实HTTP联调沿该前端恢复助手、实际tRPC路由与临时SQLite验证。

基线finally的终态persist抛错会跳过pending/controller释放，已用真实临时SQLite和原保存器重现。候选通过嵌套finally保证执行器释放；提交应答丢失时独立重读持久行，不能确认则保留本机回执屏障，返回 `XHS_TASK_RECEIPT_UNCERTAIN` 且 `resumable:false`，禁止重放。查询可进行本地核对，不调用来源；核对成功后可变为可恢复。私有记录可保留未知回执历史；本地核对完成且屏障已解除后，公开快照改为 `XHS_TASK_CHECKPOINT_RECONCILED`，避免前端对未知代码的安全阻挡永久锁死已核对任务。继续仍须最新 `resumable:true` 且未被后继接管。业务错误保留安全错误码。

## 原始证据与独立核对

专家从解析前和保存后的材料两端检查，不能只核对应用生成的摘要：

| 原始材料类别                                   | 要证明什么                                   | 独立检查方式                                                                   |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| 获授权留存的原响应字节、请求目标/游标关联      | 作者、条目数、分页语义；请求30而响应32的边界 | 独立枚举原结构并与落库稳定ID集合对照，不调用被测映射器                         |
| 原正文与实际Markdown字节                       | 没有删段、改序、替换字符或摘要冒充全文       | 独立提取段落，仅允许HTML/Markdown转义与空白规范化，保留标点、Unicode字符及顺序 |
| 原图片字节及有序来源清单、实际保存图片         | 图片正确、完整且次序一致                     | 独立解码器检查可打开，逐项比对内容哈希和有序引用；同图数不能代替身份与顺序     |
| SQLite事务前后副本、任务原始行、注入故障时间线 | 提交与任务状态一致、旧内容保留、不重放       | 独立SQLite查询/完整性及外键检查、非目标字段对照、记录实际请求次数              |
| 固定源码、依赖锁、构建清单、产物及恢复副本     | 运行代码来源完整且可恢复                     | 干净隔离重建，逐输入/产物核对；包若含时间戳则明确比较规则，不伪称逐字节可重现  |

正文允许的规范化只有转义和空白；不得以删标点、Unicode折叠、排序段落、忽略差异或重新摘要获得相等。独立核对不复用被测解析器及其输出作为唯一期望值；独立图片解码也不单独证明图片来自正确笔记。测试用合成原始字节与手工核实的期望，真实原始材料仅留私有证据区，本轮不读取。

## 搜索、页面和导出范围

`notes` 可查询全部、分组或作者；标题、作者名称、已有正文的可见文本共用同一过滤语义，排除HTML标签和图片data URI。正文缺失时不自动抓取，界面说明搜索覆盖范围。日期仍用共享过滤器。页面本地排序、切片20条追加，不能称服务端分页。移动分组会失效当前notes缓存并清除旧选择/正文，防止旧范围残留。

ZIP的选中范围取当前完整缓存选择；当前筛选/全部先通过notes查询，在前端冻结ID，全部范围忽略搜索、日期及分组（选中作者时仍限该作者）。跨作者范围按作者分派，再以100篇串行请求export，逐包核对notes回执；不受UI20行限制，但没有服务端持久范围快照。每包缓存正文/视频预算25MB，超限拒绝，取消或未知回执停止后续包。ZIP仅用缓存字节，原导出器禁止网络回退。图文ZIP沿原Markdown/相对附件布局，本机保存仍沿每篇正文.md和image/布局。

## 来源与验收边界

`TrpcModule` 已注册默认关闭的 `XHS_SUBSCRIPTION_SOURCE`。只有显式 `XHS_SUBSCRIPTION_LIVE_ENABLED=1`、非private-online/acceptance且显式连接后才可联网；启动不自动解密或恢复登录。平台验证、登录、签名、权限或限流错误暂停来源，须用户处理后重新连接。连接状态重读及任务终态同时刷新界面能力。

Windows凭据库为SQLite所在目录下 `.wewe-xhs-session/session.dpapi`，CurrentUser DPAPI与当前用户ACL保护，仅保存a1/web_session；子进程stdin传递，不用命令参数或日志。旧单篇测试凭据库不自动导入，正式复用需单独明确范围。显式断开中止在途请求、清进程会话/令牌上下文并删除应用保存文件，不登出日常浏览器。

原生HTTPS传输只允许edith指定的otherinfo/user_posted/feed路径，禁止重定向和隐式重试；媒体只允许已审核CDN，独立无Cookie请求，按实际流式字节及原归档预算限制。HTTP媒体候选仅对原白名单同主机同路径升级HTTPS，正常校验证书。真实规格以响应和解码为准。

默认工厂已配置严格otherinfo解析器：要求内部result成功及basic_info的有界昵称/展示号；稳定作者ID绑定已签名target_user_id及完全匹配的响应URL。red_id不作为稳定ID，若响应携带冲突user_id立即拒绝。独立授权验收已通过主页/笔记两种入口订阅、有界列表及3篇图文归档/重复保存。固定上游的v2列表路由返回404，显式改用同一上游支持的v1路由，不自动重试或切换端点；补充诊断确认v1请求30条实际返回32条；映射与入库统一接受最多60条有限单页响应，保留全部已核实条目，不静默截断。合成回归覆盖32条完整提交和61条整页拒绝。实际列表有后续，验收取得足够候选后显式停止，未宣称全史完成。结果与剩余项见 [ACCEPTANCE](ACCEPTANCE.md)。

## 周期退役覆盖比较

`backup-sqlite.py::snapshot_covers` 仅豁免普通 `feeds.sync_time`、`update_time`、`updated_at`、`last_collection_result`、`provider_refresh_attempt_time`。`has_history`、主键、生成列、其他表同名字段与schema继续严格。`indexed_reference_review` 只核已登记根的顶层元数据并绑定命名空间/身份/SHA，未知项不放行；`indexed_typed_coverage` 在SQLite内部比较所有类型值，只返回计数，REAL位级证明不足时保持阻塞。同schema保留点可作覆盖见证，不强迫新schema的pending越过结构检查。此只读计划路径不调用旧全局时间分层扫描/执行入口；永久动作仍须单独批准及原生句柄、引用、占用和生命周期复核。
