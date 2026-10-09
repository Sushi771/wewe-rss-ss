# Sites 客户端与本机窄接缝：仅本地准备

2026-10-09 · 基线 `68a692b8319e4f76bf53953f8310393e6d9fc2f6`

实现为 [`sites-local-contract.mjs`](../../scripts/sites-local-contract.mjs)，无第三方依赖，仅使用 ESM 与 Web Request/Response/fetch 接口；默认导出符合 Worker `fetch(request)` 形状。当前未注册 Site、未发布、未配置身份或连接，也未在 Nest/App 路由挂载任何接口。不是已连通网关或手机可用成品。

本轮纯合同已经足够：默认拒绝及浏览器、Worker、本机服务间的最小读操作可以离线核验。未建立任务队列、同步框架、持久连接、云端副本、D1/R2 或新的认证协议。

## 三层接缝与默认拒绝

| 层           | 已准备的入口                                                               | 当前边界                                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 浏览器       | `createSitesClient(fetchImpl)`                                             | 只 POST 同源 `/api/subscriptions`，使用同源会话，不接后端地址或秘密；不请求 loopback、不跟随重定向、不重试                                                       |
| Sites Worker | `createSitesWorker({ authorize, transport })`                              | 缺身份适配器返回 `IDENTITY_UNCONFIGURED`；匿名返回 401，非 owner 返回 403。连接未配置/电脑离线返回 `PC_UNAVAILABLE`；单次连接 5 秒截止，传递 AbortSignal，无重试 |
| 本机合同     | `createLocalSitesGateway({ authorize, caller }).execute(command, context)` | 仅进程内方法，没有监听器。须独立核本机连接的权限；使用已有授权的 appRouter caller，不创建管理员会话或伪造 `isLocal`                                              |

两个 `authorize` 都是服务端适配接缝，返回的 `{ isOwner: true }` 必须来自未来已验证的权限判断。该对象不是线上认证凭据，不能来自 JSON、浏览器 header 或“请求由 loopback 转发”的推断。测试中的 owner 判定仅为合成注入，不能启用真实访问。

已读取 Sites 技能的 Identity and Secrets 参考：托管 dispatch 提供 visitor identity；站点内用户 ID 与其他站点不同，身份不等于 workspace/owner 权限。服务访问 bearer 也不提供 visitor identity。真实托管来源、owner 对照和本机身份传递合同尚未核实，本轮不读取 `oai-authenticated-user-id` 来放行，不生成 bearer、cookie 或签名协议，不添加环境变量开关。

未来 Worker 打包必须使用 Sites 支持的 Worker ESM 工作流；本模块不是 hosting manifest 或可直接发布的源包。本机 Nest/Prisma SQLite 仍留在 Windows，Worker 不能直接运行它们或访问这台电脑的磁盘。

## 最小允许操作

| 命令         | 输入                                                                         | 复用的已有受保护路由                                      | 返回                                                                |
| ------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| `capability` | `platform: wechat / xiaohongshu`；微信可显式传 `source: native / wechat2rss` | `feed.addCapability` / `xiaohongshu.capability`           | 配置状态；微信当前选择。`canRefresh` 固定 false，不代表跨端刷新可用 |
| `authors`    | platform、limit（默认 20，最大 50）；仅微信可传 cursor                       | `feed.list` / `xiaohongshu.list`                          | 内部 ID、显示名称；微信沿用数据库游标                               |
| `items`      | platform、authorId、limit；仅微信可传 cursor                                 | `article.list({mpId})` / `xiaohongshu.notes({creatorId})` | 该作者的内部 ID、标题、原可信发表时间                               |

微信来源省略时继续由原服务决定默认；明确选择原样传递，响应来源不符拒绝，不自动回退。配置通过仅表示原本地能力检查通过；此合同不验证账号、套餐、余额或真实 upstream。

已有缓存元数据可在来源未配置时查询，不触发采购来源、正文重试或图片下载。小红书原 notes 路由按 creatorId 查库，但其输出未带 creatorId；适配复用此路由作用域。真实供应商 author/note schema 不在这里猜测。小红书原 list/notes 尚无分页合同，响应只截取指定上限并标 `truncated`；不能称全量，也不编造 cursor。小红书原服务仍会读取整个作者/笔记列表，此模块只限制传输结果，没有宣称改善本机大库查询。

只构造上述字段，不透传账号、token、外部作者 ID、profileUrl、原错误消息、HTML、图片、供应商 URL、本机目录或完整路由对象。元数据响应不证明正文/图片完整。电脑离线且尚无云端副本时不可读取本机内容；不得伪造空列表表示读取成功。

命令严格拒绝额外字段；单请求流式读取最多 4096 字节，单页最多 50 条，字符串有界。仅接受同源 Origin 与 JSON POST。拒绝注册、删除、刷新、正文重试、ZIP、任意路径/文件、设置、账号管理、shell 等操作；缓存正文、实际图片及下载仍使用原本机功能，尚未开放给 Sites。

## 离线验证与后续门槛

运行：

```powershell
node --test scripts/sites-local-contract.test.mjs
```

测试全局禁止真实 fetch，使用合成 appRouter 形状与服务端身份适配器，执行实际客户端、Worker fetch 和本机合同方法。覆盖默认拒绝、伪造身份 header、匿名/非 owner、电脑离线、源未配置、原默认/明确来源、不匹配来源拒绝、受限读操作、字段脱敏、作用域、截断、同源/大小限制、超时和不重试。未启动服务、读生产配置或迁移数据库；不等于真实 appRouter 集成、Sites 身份或跨设备验收。

合同回归共19项，另覆盖稀疏列表拒绝及超量响应保留截断标记，纳入主 CI。整合审查另以当前编译的真实 appRouter、原服务及合成 Prisma SQLite 跑通客户端→Worker→本机方法的五种查询，确认原受保护路由拒绝未授权 caller、字段投影和数据库字节不变，零出站、无监听器。该接缝证据仍不验证真实 Sites 身份、连接或供应商内容。

后续只有真实身份及连接合同核实后才绑定上述接缝：

1. 确认目标 Site 的私有 audience、dispatch header 来源及 server-side owner 权限；确认连接服务访问与 visitor 权限分别如何核验。
2. 确认本机主动连接或经授权的窄 HTTPS 网关的可用方式、凭据保管、失效与防冒充；保持主应用管理面和本机保存接口不对外暴露。
3. 在隔离测试中绑定真实受保护 caller，复验匿名、非 owner、电脑离线，以及微信旧身份/小红书 creator 作用域。随后再做手机和另一电脑的元数据验收。
4. 若需要跨端完整正文、图片和下载，另确认私人云端副本或受保护实时连接、权限和存储范围；当前没有这些能力。收费刷新所需的显式用户动作、预算和不确定请求语义也尚未确认，保持拒绝。

本轮没有发布、隧道、公网监听、来源授权、真实平台请求或生产迁移。代码及此非私人说明交由唯一 owner 整合后上传 GitHub；独立 worker 不 push。
