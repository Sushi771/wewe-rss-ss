# 新公众号添加入口与底层验证器合同

本实现供本地开发及离线集成。没有部署、真实平台请求或 GitHub 发布。候选公众号不需要已有目标绑定；实际账号会话与目录访问条件由底层验证器独立核验。离线成功不证明所选账号现在能访问任意公众号。

用户在原“添加公众号源”入口选择正常 Web 登录账号，提交一个公众号的公开文章链接。一次点击只验证明确提交的目标；多行提交按顺序处理，最多20个，失败即停止，余下链接保留。前端不接收或要求 Cookie、票据、配对密钥、任务 ID，也不提供 HTML 上传。账号到期或官方验证才需用户正常处理，不切换账号，不自动重试。后续公众号更新使用原刷新入口。 整批处理中锁定链接、账号与再次提交；取消或离开页面只停止尚未发送的目标，已发送请求仍由服务端完成，不能承诺撤回。旧批次结束时仅更新自己的输入快照，不覆盖后来输入；取消后等待在途请求结束才能再次开始。

## 已注册的产品入口

`collection/subscription-add.ts` 导出 `SUBSCRIPTION_DISCOVERY` 和 `SubscriptionDiscoveryValidator`。`subscription-native-adapter.ts` 实际消费 `validateWereadPublisherCandidate`、`withVerifiedWereadCandidateBinding`，发布完整私有绑定后调用 `CollectionService.collectVerifiedWereadCandidate`。`TrpcModule` 已注册以下工厂，原 `feed.addFromArticle` 接受公开链接与账号选择；实例化、查看 capability 或选择账号本身均不发平台请求。

```ts
{
  provide: SUBSCRIPTION_DISCOVERY,
  inject: [PrismaService, CollectionService],
  useFactory: (prisma: PrismaService, collection: CollectionService) =>
    createNativeSubscriptionDiscovery({
      prisma, collection,
      resolveOriginal: (url, account) => resolveWereadPublisherOriginal({
        url, account, trigger: 'local-manual',
      }),
    }),
}
```

`resolveWereadPublisherOriginal({url,account,trigger})` 已作为服务端依赖接线，支持新提交的文章URL。它复用现有官方域名、固定DNS地址的公开原文传输，不携带账号Cookie，不跟随跳转、不重试，限定10MiB和UTF-8 HTML，先检查所选账号及保留停止，再持久预约本次请求。短链接必须由真实成功响应完成映射，不能根据客户端URL、上传HTML或known-hash缓存假定身份；长链接须与正文 canonical 文章身份匹配。成功结果的HTML仅供服务端使用，不可枚举；挑战、空页和拒绝保持待处理。302仅回送经现有安全策略核验的真实Location及五分钟有效期，没有安全地址时说明具体不可用原因，不改为官网首页。

底层方法为 `discover({articleUrl, accountId, trigger:'local-manual-add'}, stageFeed)`。只有服务端构造验证器，浏览器仅提交链接与选定账号，不提交“已核验”对象。

1. 底层复用公开原文静态身份、号名及来源核验；长链接中的 biz 只形成候选 bookId。未知短链、未经核验跳转或身份缺失保持候选，不写 Feed、文章或 RSS。
2. 底层独立解析所选账号的正常会话；不要求目标号已绑定，也不把旧目标的成功续期授权赋给新目标。候选及预约持久保存于订阅表外，保存真实停止和并发锁。
3. 用户添加动作授权本次有界目录验证。底层使用现有精确目录传输，禁重试、跳转、账号回退和验证码求解。HTTP 200、空目录、业务拒绝和相关链接均不能作为成功证据。
4. 真实非空目录通过现有 `parseWereadDirectory` 后，调用 `stageFeed({mpId,name,evidenceRevision})`。revision 为64位十六进制服务端证据摘要，不能拿客户端上传的 HTML/hash 代替目录验证。
5. `stageFeed` 先一致性备份，并在 SQLite 事务中新建停用 Feed。已存在同号不重建，名称冲突拒绝，不覆盖旧正文、时间、指标或其他订阅。返回 `{feedId,created,activate(),rollback()}`。
6. 底层先发布验证后的私有绑定，再 `activate()` 启用原 Provider。绑定发布失败须撤回其指针再 `rollback()`。新 Feed 未激活时失败会回滚；并发用户修改则保留停用恢复行，不删除用户数据。既有 Feed 不由失败回滚删除。底层须保存崩溃恢复记录，因为文件与 SQLite 不是同一事务。未激活的行不能路由到 Provider。
7. 绑定后直接复用本次真实目录进入原十篇正文、实际图片归档和保护保存流程，不立即重复请求首页，不回放旧缓存冒充更新。发布时间取原文；目录确认和正文图片完成分别报告。

终态 `status` 支持 `needs-verification/blocked/failed/directory-confirmed/updated/already-subscribed`。`stage` 为 `identity/session/directory/binding/bodies/images/save`。`httpStatus/businessCode` 仅返回有界数字，保留例如 HTTP401 或业务码 -2041 的区别。错误说明与其余字段白名单输出，原请求、凭据、路径和原始响应不回送界面。

`updated` 需要原保存流程回报 `update={articles:10,created,updated,bodyMissing:0,imageBlocked:0,saved:true}`；缺少这份回报降为目录确认、正文待完成。`already-subscribed` 不声称本次刷新成功。目录已确认后正文遇拒绝，返回 `accepted:true,pending:true,status:blocked`，不显示取文成功；原停止保持，不自动重试。

## 本地验证

```powershell
pnpm --filter server exec jest --runInBand subscription-add.spec.ts subscription-add-ui.spec.ts accounts.spec.ts owner-subscription-flow.spec.ts
pnpm --filter server exec tsc --project tsconfig.build.json --noEmit --incremental false
pnpm --filter web exec tsc --noEmit
```

`trpc/subscription-add.spec.ts` 使用新建 SQLite、合成公开原文与目录，以及截获的离线传输。真实执行原tRPC HTTP入口、正常会话解析、owner候选验证器、完整私有绑定发布、原十篇正文图片保存器及一致性备份；目录仅读取一次，重复添加不重取目录或正文。随后经原刷新入口读入一个合成新文，旧行逐字段保留。其他用例覆盖未识别身份、canonical不一致、HTTP401/业务挑战、空目录、停止记录、旧名冲突、文件发布/数据库激活及恢复失败、两个不同公众号的绑定隔离和并发编辑保护。正常会话、文章和图片全部为虚构fixture，没有读取真实账号或发平台请求，不能称为任意公众号已可用。早期合成adapter用于故障注入，未注册到运行时。

绑定与SQLite分属两个存储：目录核验后先一致性备份并暂存停用Feed，保存私有配置不可变快照，原子发布绑定后才激活。激活失败则在锁内核对当前配置字节并恢复旧指针；新增行的 `assertRollback` 再次确认本次绑定已撤回后才允许删除。若恢复指针失败或配置已变化，保留停用恢复行与私有快照，返回失败，不继续正文请求；持久候选、失败记录和停止不删除。新绑定使用完整底层配置及 `sourcePolicy:'native-directory-only'`；该明确策略允许新号没有旧 `originalStopFiles`，并在旧搜索/公开原文采集入口发HTTP前拒绝执行。已有真实来源停止引用保留，不制造平台拒绝文件。此屏障已由离线回归验证。

UI 测试执行实际事件处理器，验证所选账号、逐目标串行、失败保留链接、正文待完成与双击保护；没有安装扩展或真实浏览器视觉验收。工程全量 `tsc` 包含旧 `test/app.e2e-spec.ts` 的 supertest 导入类型错误，本变更使用应用构建配置检查，并未修改该旧测试。
