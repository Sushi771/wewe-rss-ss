# 小红书订阅技术说明

按 `e962a5b38fe8281ee29814915370b476ede7140e` 只读核对。原始基线为 `f609bda0334f17f6c28ff84020d31cd5c47f3417`，当前已包含后台检查点和前端跨批选择/ZIP分批实现。

## 架构与数据

`XhsSubscriptionService` 管解析确认、仅列表任务、详情下载和续跑；`XiaohongshuService` 保留博主管理、分组、缓存查询、正文和ZIP。前端继续使用原小红书页面，通用控件复用 `SubscriptionPrimitives.tsx`、`ArticleDateFilter` 和 `ManagementFolders`。

复用 `XhsCreator` / `XhsNote`、稳定平台/笔记元组ID、`ManagementGroup`、`xhsArchiveDraft`、`LocalArticleStore` / `buildCompleteArticleDownload`。迁移 `20261024000000_xhs_subscription_tasks` 追加任务表 `xhs_subscription_tasks(id,creator_id,state,document,updated_at)` 和作者/状态索引。任务document含计数、选中ID及逐项回执、列表游标/历史/已见ID、完成标记和下载目录，属于私有数据库内容，不进入Git。

所有任务持久化和业务修改沿 `incrementalWrite → sqliteWrites → Prisma transaction`；每页笔记与下一游标在同一事务提交。沿用 [备份协调](../SQLITE_BACKUP_COORDINATION.md)，不在事务内申请备份、不自动重放事务或上游请求。

## 共享接口契约

共享类型位于 `packages/shared/src/xhs-subscription.ts`，router沿用 `protectedProcedure`。

| 调用 | 输入 | 返回/职责 |
| --- | --- | --- |
| `resolveSubscription` | `{url}` | `{resolutionId,inputKind,author,existingCreatorId,expiresAt}`，只解析 |
| `subscribe` | `{resolutionId,groupId?}` | `{creatorId,created,subscribed:true}` |
| `refresh` | `{id}` | `{taskId,creatorId}`，仅列表 |
| `downloadNotes` | `{creatorId,noteIds,pickToken?}` | `{taskId,creatorId}`，选中详情与本机保存 |
| `task` | `{taskId}` | 持久任务的公开状态快照 |
| `cancelTask` | `{taskId}` | 返回任务快照，当前原子保存可能尚在收尾 |
| `resumeTask` | `{taskId,pickToken?}` | 新 `{taskId,creatorId}`，复用旧检查点 |
| `notes` | `{creatorId,search?,dateStart?,dateEnd?}` | 全部匹配元数据，无cursor/take服务端分页 |
| `export` | `{creatorId,search?,dateStart?,dateEnd?,noteIds?}` | `{filename,mimeType,base64,notes}`，完整缓存ZIP；显式ID每批1–100个 |

`inputKind='note'|'profile'`；`author={id,name,profileUrl,avatarUrl?}`；`existingCreatorId` 无值为 `null`；`expiresAt` 为Unix毫秒。解析ID及任务ID是UUID，博主ID最长128、笔记ID最长300、URL最长8192、pickToken最长128字符。日期使用共享上海自然日过滤，起止必须有序。

任务快照含 `taskId,creatorId,kind:list|download,state,total,completed,skipped,failed,remaining,code?,message,resumable?`。下载中四类计数互斥，`remaining=total-completed-skipped-failed`；续跑移除失败项回执并将其重新纳入剩余。列表 `total` 是已经枚举的唯一ID数，`completed` 是新增记录、`skipped` 是已有记录，未枚举的后续总量未知，因此 `remaining=0` 不证明列表已结束。

下载和续跑额外要求原本机同源保存上下文，并拒绝private-online及acceptance mode；其他操作继续登录保护。任务快照不返回原始document、目录或来源令牌。

## 解析与显式订阅

URL校验允许HTTPS的 `www.xiaohongshu.com/user/profile/{id}`、`/explore/{id}`、`/discovery/item/{id}`，以及 `xhslink.com/{id}` 或 `/a/{id}` 短链。拒绝凭据、显式端口、fragment、空白/控制符和反斜杠；短链不接受query。短链逐跳手动检查，最多5跳、每跳10秒，不带环境认证，拒绝循环、外域及非重定向响应。

可信adapter返回作者及输入类型，服务端核对ID、非空名称和规范主页。解析结果只存进程内Map，有效10分钟，清理过期后最多100个；重启需重新解析。确认只提交resolutionId，不接受客户端作者证据。

事务按上游作者ID或规范主页查找旧博主，校验作者冲突与小红书分组，复用原ID。显式传groupId更新分类，省略保留。旧 `add` 待接入接口仍兼容保留，新UI用解析确认流程；确认不读列表，首次确认后的列表请求由前端单独发起。

## 列表、下载和持久检查点

列表按来源游标持续枚举，不再沿旧刷新最多三页。每页最多30项，游标最长2048字符；作者、类型、稳定ID和时间校验后，每页元数据及检查点原子提交。时间可为0表示未知，不用采集时刻冒充。跨页重复去重、重复游标、空页续游标及仅重复ID却继续翻页均有停止检查。已完整笔记不被新元数据降级。

下载接受非空去重选择，按100个ID分块校验归属，没有固定100篇总选择上限。先消费原目录选择许可，再逐项详情；完整缓存可直接复用。详情须匹配作者/笔记、完整正文、预期图数、顺序及实际字节。先写完整缓存，再调用原保存器；缓存成功而本机失败仍不是保存完成。未缓存视频跳过，已完成项保留；详情/媒体/保存失败停止后续派发，回执为blocked或partial。

同博主只允许一项未释放任务，活动队列最多20项，执行lane串行。取消通过AbortSignal停止在途来源读取，并停止后续工作；已提交页与原子保存不回滚。任务退出后才可续跑，`resumable` 反映执行器释放。续跑生成新ID，保留列表游标及已完成/跳过项，失败下载重新纳入。下载须重新取得目录许可且与旧目录一致。

重启将queued/running持久任务标记为 `blocked/XHS_TASK_INTERRUPTED`，不发网络；用户显式续跑。该机制针对单一本机后端，不提供多进程调度保证。

## 搜索、页面和导出范围

`notes` 在当前博主内按标题或 `contentHtml contains` 及共享日期条件查询，返回全部匹配元数据；目前没有作者匹配或可见正文正规化，HTML标签/data URI隔离尚未对齐公众号搜索。页面本地排序、切片20条追加，不能称服务端分页。

ZIP的选中范围取当前完整缓存选择；当前筛选/本博主全部先通过notes查询，在前端冻结ID，本博主全部省略搜索和日期。之后以100篇串行请求export，逐包核对notes回执；不受UI20行限制，但没有服务端持久范围快照。每包缓存正文/视频预算25MB，超限拒绝，取消或未知回执停止后续包。ZIP仅用缓存字节，原导出器禁止网络回退。图文ZIP沿原Markdown/相对附件布局，本机保存仍沿每篇正文.md和image/布局。

## 来源与验收边界

本次核对版本有Redbook适配器、受限短链及合成profile parser验证，但TrpcModule未默认注册 `XHS_SUBSCRIPTION_SOURCE`。真实来源、DPAPI和安全媒体接线在另一窗口开发，不据候选代码宣称可实用。真实主页schema、当前账号小批文图与增量仍待用户授权；凭据、私人正文、任务数据库和本机审计均不提交。结果与剩余项见 [ACCEPTANCE](ACCEPTANCE.md)。
