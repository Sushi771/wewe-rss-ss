# PC 原文链接与来源预算合同

标题导航由用户显式点击触发。链接准备只处理原文地址，不读取或渲染笔记正文，不下载媒体，不启动整号任务，不清除当前来源停止码。已有缓存或是否完成下载不决定原文入口。

## 官方 PC 路由依据

官方 PC 页面使用的 [index.a9f61821.js](https://fe-static.xhscdn.com/formula-static/xhs-pc-web/public/resource/js/index.a9f61821.js) 包含 `/explore` 路径及 note card 标题、封面的实际 href 绑定；User 路由上下文将 source 设为 `pc_user`。因此，已核同作者列表成员的真实 note token 可按该 Web User 路由合同生成 PC URL。这里的 source 是官方路由合同推导值，不能标成 API 原样返回字段，也不能把作者资料 token 当作笔记 token。

优先保留正常解析过程中实际取得、且同一作者/笔记关系已核实的完整 PC/share URL。已确认的 PC 参数还可保留 `m_source`、`note_flow_source`、`source`；拒绝外域、凭据、显式端口、控制字符、重复或未知参数及身份不一致。没有合法 note token 或身份依据时返回固定未就绪码。不能从标题、手写 ID 或错误响应 URL 推造地址。

链接准备成功只证明来源和关联成立，不证明浏览器当前一定能阅读。平台仍可能要求登录、限制访问、删除或隐藏内容；实际 PC 打开必须另行获准并独立核验，不自动重试或绕过。

## 前端调用合同

namespace 为 `trpc.xiaohongshu`：

- `sourceRequestBudget(scope)`：查询已有预算视图或返回 null。
- `configureSourceRequestBudget({scope,totalLimit,intervalMs})`：仅显式保存来源设置时使用。
- `prepareOriginalLink({noteId,budgetId?,refreshContext?})`：返回 `{state:'ready',url}` 或 `{state:'not_ready',code}`。
- `resolveSubscription({url,budgetId?})`：沿用原解析 DTO，但必须存在来源预算。

scope 为 `{purpose:'resolution'}` 或 `{purpose:'original-link',creatorId}`。预算 ID 由服务器自动选择；前端不要求用户逐篇填写，也不为每次点击创建额度。固定码表 `xhsOriginalLinkCodes` 和类型 `XhsOriginalLinkResult` 位于 shared 的 `xhs-subscription.ts`，前端应处理未配置、耗尽、冷却、身份错误、会话停止和来源拒绝，并保留通用固定提示。

## 持久预算与不重置原则

复用既有 `xhs_request_budgets`，不新增列或迁移。`xhs:source-total` 是解析、原文链接及其他正常 runtime 派发共享的累计总上限；scope 是该总额度的关联视图或进一步约束，不能相加作为新额度。一次来源总额度配置可供各 scope 使用。`totalLimit` 是累计总额，不是追加量；重复保存保留 `used` 和 `next_at`，不退款，不重启清零，不修改旧整号任务预算。

每个实际 API、媒体或短链跳转派发前预留；来源调用前的嵌套操作员/测试预算仍保留。根与已配置 scope 在同一 SQLite 事务预留，失败回滚整个预留事务；成功预留后即使后续取消或回执未知也不退款。不要把不同约束的计数相加。短的现有限速时隙可在当前显式操作中可取消地等待；较长冷却返回固定暂停码，不重试 HTTP。

生产 DI 把总额度门闸绑定在统一 runtime transport 入口。没有共享总配置时，仅原有明确预算作用域可按其既有许可派发；无任何预算的普通调用被拒绝。相同预算对象/ID 不重复预留；同目标并发准备复用在途过程。已有有效内存链接不发来源请求，也不扣额度，额度耗尽不妨碍该纯本地结果。

## 隐私和生命周期

作者/笔记访问上下文仅留私有内存；重启、断开、来源停止或原有内存期限结束后失效，不保存为永不过期 token。内存期限不是平台 token 有效期，因此 DTO 不伪造 expiresAt。链接不进入普通列表 DTO、DB、Markdown、导出或日志；准备响应使用 no-store 和 no-referrer。

前端仅在显式点击时调用 mutation，不预取，不把 URL 持久化；失败时原 tab 保持可用，来源错误仅显示固定码，不能自动打开错误响应中的 URL。

## 离线反例与发布验收

执行 `xhs-original-link-access.spec.ts` 及已有 runtime、会话、短链、订阅访问和整号回归。核对大小写/前导零、同名跨作者、错身份、注入/超长 URL、过期上下文、预算缺失/耗尽/冷却、共享总上限、外层调用预算、无漏记 profile/redirect、无重复扣费、并发复用、日志隐私及实际本机 HTTP 头。全部输入为合成资料，不读生产凭据或数据库。

最终发布仍须单独验证真实 PC 链接与目标笔记/作者一致、实际可打开；离线结构检查或模拟浏览器通过不能代替该事实。未知或受限必须保持未知，不扩大联网权限。

显式“链接失效？重新准备”可传 refreshContext:true，仅重建该笔记的正常来源上下文；不清风险或旧任务状态，仍逐次受原预算限制。普通有效链接不强制刷新，失败不会关闭应用原 tab。

## 错误批处理、预留回滚与上下文竞争

敏感 prepare/resolve/connect 使用独立 HTTP 请求，不与其他操作批处理。日志仅输出固定的方向、操作类型和结果类别；全局错误处理器不打印原始错误对象，避免旁路错误的 responseJSON 泄漏同批成功响应。

请求派发前先核查所有预算；多闸预留过程中被拒绝时，只对仍能按计数与时间戳确认归属本次的预留执行条件回滚。来源总额和用途预留共同回滚；已派发、未知预留结果或已被并发推进的记录保持保守，不退还额度。

短期上下文写入按请求开始代次排序；刷新为目标笔记设置最低代次，较早迟到响应不能覆盖较新链接。正文、目录或其他笔记的缓存不会因该操作清空。

只允许合法同笔记官方 PC 地址保留精确 `#comment-section`，不解码或放行任意 fragment；短链和作者资料链接仍不接受 fragment。
