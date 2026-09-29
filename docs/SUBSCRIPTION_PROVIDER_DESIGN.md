# 可替换公众号订阅源设计（历史设计基线，2026-09-29）

> 当前实施要求见 [订阅恢复实施任务书](SUBSCRIPTION_IMPLEMENTATION_TASK.md)，当前状态见 [精简交接](DEVELOPMENT_HANDOFF.md)。本设计中的“本轮只提交设计”“不部署”和 `/api/query` 首选、历史查询门槛等阶段结论已由新任务书覆盖；保留此文作为设计出处，不作为执行入口。

> 2026-09-29 再次转向 [可自行维护的微信读书订阅主线](PRIVATE_ONLINE_DELIVERY_TASK.md)。本文件中“停止微信读书/自建中转研究”和 Wechat2RSS 采购/接入路线均为历史判断，不再是现行限制或计划；现行实验约束和证据边界见 [自建路线研究](WEREAD_SELF_HOSTED_RESEARCH.md)。

## 决策与范围

目标产品流程保持为“添加公众号 → 后台订阅 → 手动/定时更新 → 保存文章 → 本地 RSS、Markdown、Obsidian 和图片导出”。本轮只提交设计，不接入真实账号，不购买或部署 Wechat2RSS，不修改生产数据库或运行来源探针。现有 12 个 feed、1447 篇文章、全部旧 ID/正文/图片及导出路径必须保留。

旧 WeWe 的 `weread.111965.xyz` 并非普通 HTTP 代理，其服务端及 token 生成逻辑未公开。已有同类微信读书客户端登录、设备认证和续期成功，文章列表仍为 HTTP 499 / `-2041`。**停止** weread-omni、`/mp/chapters`、`/web/mp/articles`、换 UA/客户端、重复扫码、猜测旧中转实现及电脑微信本地采集。只有将来取得原服务端源码或可验证的新协议才重新审视；本设计不包含这些请求的运行步骤。

方案 A 是在现有 NestJS 后端增加 `SubscriptionProvider` 边界和独立的 `Wechat2RssProvider`，让更新编排、身份核验、SQLite 写入与导出仍由本项目控制。方案 B 是把上游 RSS 直接当现有数据库或前端的主数据源，改动较少，但无法稳定表达 `/api/query` 的状态、文章身份、正文失败、旧 ID 保护和分页证据。**选择 A。** 它多一层转换代码，但后续换来源只需替换 Provider；第一阶段不新增数据库表、不重写前端。旧微信读书代码只作为禁用的历史实现边界，不注册为可执行 Provider，也不作为失败回退。

## 官方接口核对

以下为 2026-09-29 查阅的 [Wechat2RSS 官方 API 参考](https://wechat2rss.xlab.app/deploy/api)、[配置说明](https://wechat2rss.xlab.app/deploy/config)、[使用指南](https://wechat2rss.xlab.app/deploy/guide) 和 [Q&A](https://wechat2rss.xlab.app/deploy/qa) 所能支持的合同；真实私有实例和目标公众号尚未验证。

| 接口                          | 官方行为                                                                                                     | 本项目设计用途与边界                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /login/new?k=…`          | 创建微信账号登录流程，响应包含二维码及 cookie                                                                | 仅未来配置人员在私有服务完成一次账号授权；不作为本项目用户每次更新的依赖，不在应用日志、Git 或 UI 返回二维码/cookie。                                                  |
| `POST /login/code?k=…`        | 携带上述 cookie 提交登录验证码                                                                               | 不自动提交验证码，也不将此接口当订阅恢复证据。                                                                                                                         |
| `GET /login/list?k=…`         | 返回账号 `id/name/available/needCheck/waitTime`                                                              | 实现 `checkAccountStatus()` 的只读来源；`available=true` 只证明账号状态，不证明文章可取。                                                                              |
| `GET /login/refresh/:id?k=…`  | 刷新风控信息，标记账号已解除风控                                                                             | **不用于更新文章**，不做自动调用。`/login/del/:id` 同样不进入普通更新。                                                                                                |
| `GET /add/:id?k=…`            | 按公众号数字 ID 添加订阅，返回订阅地址；重复添加也会再次提交异步更新任务                                     | `addSubscription(accountId)` 与有界的 `refreshSubscription()` 可调用。收到 `err=""` 只算任务受理，不能标成文章已入库。不得用返回的 feed URL 当高频轮询目标。           |
| `GET /addurl?url=…&k=…`       | 由文章链接解析公众号 ID 并添加订阅                                                                           | `addSubscription(articleUrl)` 的入口；收到链接后仍须从 `/list` 或查询响应核对实际数字 ID 与本地 feed 身份。                                                            |
| `GET /list?k=…&page=…&size=…` | 列出已订阅账号的数字 `id/name/link` 与 `meta.total`                                                          | `listSubscriptions()` 的真实来源，按 `meta.total` 结束。不能只按名称模糊匹配 12 个本地 feed。                                                                          |
| `GET /feed/:id.xml`           | 上游 RSS，`:id` 默认数字公众号 ID；若开启 `RSS_ENC_FEED_ID` 则为 HMAC 后 ID                                  | 仅兼容出口和 `/api/query` 身份字段不足时的有限补充候选。HMAC feed ID 不是本地 `MP_WXS_…`，不得互换；RSS 默认条数有限。现有项目自己的 RSS 继续从 SQLite 输出。          |
| `GET /api/query?k=…&bid=…`    | 返回 JSON `{data,err}`；支持 `bid`、`before`、`after`、`content`；`before/after` 格式 `YYYYMMDD`，默认含全文 | 结构化文章首选。日期过滤用于**上游已存文章**的窗口查询；官方未承诺页码、offset、cursor、固定排序或订阅前完整历史。`err` 非空、缺字段、超出预算均作为失败，不能当空页。 |

官方 [Q&A](https://wechat2rss.xlab.app/deploy/qa) 明确上游只抓最新 20 篇，不抓更早历史；只收录群发消息，检查更新有延迟。`/api/query?before=…` 可查询上游**已经保存**的旧条目，不会凭空补回订阅前未抓取的历史。[配置说明](https://wechat2rss.xlab.app/deploy/config)中 `RSS_MAX_ITEM_COUNT` 默认 20 是上游 RSS 输出上限，`RSS_KEEP_OLD_COUNT` 默认 50 是上游留存上限；两者与本项目本地库保留 1447 篇无关。第一阶段要求“下一页**或**历史查询能力”，应通过真实 `before` 时间窗口取得更早且不同的**上游已存**文章来验收，不能把日期过滤或短页写成无限分页能力。

## Provider 合同与数据流

建议增加 `apps/server/src/collection/subscription-provider.ts`，API 为后端 TypeScript 类型，不公开微信读书或 Wechat2RSS 的原始响应：

```ts
type ProviderFeedId = string; // 本项目稳定的 MP_WXS_<数字>，不等于上游 RSS URL
type ProviderArticle = {
  feedId: ProviderFeedId;
  upstreamAccountId: string;
  upstreamArticleId?: string;
  canonicalUrl?: string; // 可证明 biz/mid/idx 的原文链接
  shortUrl?: string;
  title: string;
  publishedAt: number; // Unix 秒，来源为带时区的发布时间
  contentHtml?: string;
  coverUrl?: string;
  imageUrls?: string[];
  identity: 'verified' | 'unverified';
};
type ProviderPage = {
  articles: ProviderArticle[];
  coverage: 'recent-window' | 'stored-history-window';
  next?: { kind: 'date-window'; before: string }; // 只在上游实测支持时返回
  upstreamCount: number;
  endReason?: 'verified-end' | 'bounded-stop';
};
interface SubscriptionProvider {
  readonly id: string;
  addSubscription(input: {
    articleUrl?: string;
    accountId?: string;
  }): Promise<{ feedId: ProviderFeedId; accepted: boolean }>;
  refreshSubscription(
    feedId: ProviderFeedId,
  ): Promise<{ accepted: boolean; pending: boolean }>;
  listSubscriptions(): Promise<
    Array<{ feedId: ProviderFeedId; upstreamAccountId: string; name: string }>
  >;
  fetchArticles(
    feedId: ProviderFeedId,
    options?: { after?: string; before?: string; includeBody?: boolean },
  ): Promise<ProviderPage>;
  fetchArticleBody(
    article: ProviderArticle,
  ): Promise<{ contentHtml: string | null; imageUrls: string[] }>;
  checkAccountStatus(): Promise<{
    available: boolean;
    challenged: boolean;
    retryAfter?: string;
  }>;
}
```

`fetchArticleBody` 对 Wechat2RSS 优先使用 `/api/query` 的 `content=1`，不承诺存在单篇正文端点；如果不能唯一定位某篇正文，返回不可用状态并保留已有正文。`next` 是**可选能力**，不得根据数据库文章数或查询条数臆造。`refreshSubscription` 只表示 `/add/:id` 任务受理；后续单独 `fetchArticles`，在上游确有结果、身份和正文核验通过后才允许保存。`checkAccountStatus` 不能隐式调用 `/login/refresh/:id`。账号状态异常或上游频控时停止该号、显示受阻，不自动换账号或密集重试。

```text
现有添加 / 单号更新 / 更新全部 / 定时任务
                  ↓
      Provider 选择与更新编排
                  ↓
  Wechat2RssProvider → /list /add /api/query
       （旧 WeRead Provider 禁用）
                  ↓
      身份核验 → 统一 Article → 现有受保护写入
                  ↓
       现有 SQLite → RSS / Markdown / Obsidian / 图片
```

选择 Provider 应显式、稳定：验收前只在独立配置里把一个目标 feed 绑定到 `wechat2rss`；生产切换后可以复用现有 `Feed.collectionChannel` 保存 provider ID。旧 `desktop-wechat` 历史值只作兼容读取，不激活桌面 helper；无配置或未知 provider 一律返回 `blocked`，**不自动回退**到旧 WeRead、公开合集或 Mp2RSS。`MP_WXS_<数字>` 可无损映射为 Wechat2RSS 的数字 `bid`，但仍须 `/list` 与真实文章 `biz_id` 双重核对。新来源若无法这样映射，未来再设计单独绑定字段；第一阶段不迁移生产库。

## Wechat2RSS 字段映射与停止条件

| 上游字段/能力                                 | 现有 `Article` / `Feed`                        | 映射规则                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/list.data[].id`、`/api/query.data[].biz_id` | `Feed.id`、`Article.mpId`                      | 数字 `N` 映射 `MP_WXS_N`；必须与本地目标、`/list` 和文章逐条一致，任何不一致整批停止。                                                                                                                                                                                                            |
| `biz_name`                                    | `Feed.mpName` / 显示                           | 精确核对身份辅助；名称变化不自动改本地 feed ID，不以名称独立证明同号。                                                                                                                                                                                                                            |
| `title`                                       | `Article.title`                                | 非空且与已确认原文一致；不按标题合并旧记录。                                                                                                                                                                                                                                                      |
| `created`                                     | `Article.publishTime`                          | 严格解析带时区 ISO 字符串为 Unix 秒；不能用查询时间、采集时间或本地时区猜测。                                                                                                                                                                                                                     |
| `content`，`content=1`                        | `Article.contentHtml`                          | 实测确认为可用、清洗后的正文 HTML 时才新增/填补空值；正文缺失不覆盖旧正文或把元数据当采集完成。                                                                                                                                                                                                   |
| 原文 URL / 文章唯一 ID                        | `Article.id`、`sourceUrl`、`verifiedSourceUrl` | **官方示例未列出这两项**。真实响应须给出可核验原文 URL/唯一身份，或可在受限 RSS/JSON Feed 中一一对应，并最终证明 biz/mid/idx。继续使用现有 `WX_<biz>_<mid>_<idx>` 规范和旧短链 ID 映射；不能用标题+时间、上游数组下标或随机 UUID 生成新文章 ID。拿不到时停止导入。                                |
| 图片 URL / 正文 `<img>`                       | `picUrl`、`contentHtml`、现有附件导出          | 官方查询示例没有封面/图片字段。实测要确认图片出现在正文或可核对的字段；清洗并限制图片来源与响应体积，按现有导出流程下载到 `attachments/`。若只有需私有 token 的上游代理 URL，先设计安全的服务端解析与本地化，不把 token 写进文章 HTML/Markdown 或客户端。图片失败不能宣称验收通过，也不能删旧图。 |
| 未提供的阅读/点赞等                           | `metrics`、`readCount`、`likeCount`            | 保留旧有效值，缺失继续为 `null`，不伪造为 0。                                                                                                                                                                                                                                                     |
| `/add` 返回的订阅地址、`/feed/:id.xml`        | Provider 内的 `upstreamAccountId/feedUrl`      | 仅在私有配置与运行时使用；不覆盖本项目 `Feed.id` 或输出 RSS 地址，不把带 `k` 的 URL 存入 `lastCollectionResult`。                                                                                                                                                                                 |

上游示例只保证 `biz_id/biz_name/title/desc/created/content`，**不足以证明文章级身份或图片可导出**。因此现在不能认定 Wechat2RSS 已满足接入门槛；先拿到本人私有实例中目标号的脱敏响应结构，再决定适配器如何取原文链接和图片。不要把 `/api/query` 的示例 `content` 字符串直接当作可本地化的 HTML。

## 预计改动文件（真实接入阶段，当前未修改）

| 文件                                                                                | 预计改动                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/collection/subscription-provider.ts`、`provider-registry.ts`（新） | 定义合同、能力标志、显式选择与禁止隐式回退。                                                                                                                           |
| `apps/server/src/collection/providers/wechat2rss.ts`（新）                          | 私有实例 HTTP 客户端、`k` 鉴权、`/list`、`/add`、`/api/query`、登录状态、错误分类和响应限制；上游类型只在本模块出现。                                                  |
| `apps/server/src/collection/provider-article.ts`（新）                              | 统一 Article 映射、身份/日期/正文/图片核验、旧 ID 对齐。                                                                                                               |
| `apps/server/src/collection/collection-channel.ts`、`collection.service.ts`         | 增加 `wechat2rss` 路由，复用现有锁、备份、事务、旧值保护和重复更新逻辑；先只选一个 feed。                                                                              |
| `apps/server/src/trpc/trpc.service.ts`、`trpc.router.ts`、`trpc.module.ts`          | 现有按钮与批量入口接 Provider；`feed.add` 在验证后明确执行 `addSubscription`；禁用新路线对旧 WeRead 的隐式请求与正文导出回退。                                         |
| `apps/server/src/feeds/feeds.service.ts`                                            | 定时继续调用统一更新入口；针对新来源优先读缓存正文，不能由无效 ID 拼接原文 URL。                                                                                       |
| `apps/server/src/configuration.ts`（或现有配置模块）及 `.env.example`               | 配置私有 base URL、`RSS_TOKEN`、启用开关和实例访问边界；**只提交变量名，不提交值**。License 仅由私有上游实例自己的 `LIC_EMAIL/LIC_CODE` 配置管理，本项目不读取或转发。 |
| `apps/server/src/collection/*.spec.ts` 与隔离验收脚本（新）                         | 假上游契约、五篇/日期窗口、异步受理、身份冲突、正文/图片、重复更新和旧数据保护。                                                                                       |
| `apps/web/src/pages/feeds/index.tsx`（仅有必要时）                                  | 增加来源名称和 `pending/blocked/partial` 提示，不重写页面或改变交互主流程。                                                                                            |
| `apps/server/prisma/schema.prisma`、迁移                                            | 第一阶段**不改**；若真实返回无法把数字 bid 对应稳定 feed ID，再单独评估加性绑定迁移。                                                                                  |

生产写库前继续执行现有 `createVerifiedSqliteBackup`；失败时不写 `running`、文章或状态。保存层须先完整核验一批，再单号事务写入。以规范原文身份、既有 ID、已核验 sourceUrl 匹配，冲突多条则整批阻断；已有非空正文、图片、有效指标和可信时间不被空字段覆盖。新文章先采用现有去重和导出代码，不向前端传播上游原始结构或带 `k` 的错误文本。

## 凭据与配置隔离

Wechat2RSS 私有 base URL 和 `RSS_TOKEN` 从本机私有环境加载；只允许明确配置的实例地址，限制重定向、响应大小和超时。官方通过 URL 查询参数 `k` 鉴权，因此应用日志、异常、代理日志与测试快照均不得保存完整请求 URL；错误只输出去标识状态/业务码。`RSS_TOKEN` 不进入数据库、Git、浏览器或导出文件。`/img-proxy` 的 `k` 是**另一套** HMAC 验证参数，不能与 `RSS_TOKEN` 混淆。授权邮箱、激活码与微信账号会话由私有上游实例管理，本项目只读取必要的账号可用性摘要。

## 分阶段验收与退出

1. **当前设计检查**：官方接口、上游限制、文件边界和现有写入/导出代码核对；不请求私有实例。此阶段只证明方案可审查。
2. **以后有本人私有实例且明确启动实测时**，在隔离目录、只读模式核对 `/login/list`、`/list`，再对一个已订阅的“妈妈部落畅聊阁”请求 `/api/query?bid=…&content=1`。记录 HTTP/业务码、时间、账号 ID、原始条数和结构；凭据原文不得留存。`/add` 会改变上游状态，只有在确认尚未订阅且准备正式测试时才调用一次。账号风控则停止。
3. 得到**最近至少 5 篇真实不同文章**，逐条核对公众号身份、原文 ID/链接、正确发布时间、正文及图片。本地导出至少几篇并核验附件实际落盘。若 `/api/query` 原始条目缺身份/图片，需要用同一私有实例返回的 RSS/JSON Feed 补充时，只作一对一确定性核对；核对失败即停止，不用旧库拼凑。
4. 以 `before` 查询更早的**上游已存**条目并证明不同文章及日期窗口边界；若私有实例只含首次最新 20 篇，如实记录范围，不能宣称可回补旧史。服务端不支持可信历史查询或内容类型不足时，按用户要求停止这个候选。
5. 在独立 SQLite 副本上演练首次导入、第二次更新新增 0、已存文章不漏不丢、所有旧字段零损失，验证 RSS/Markdown/Obsidian/图片。**这些条件全部通过且生产一致性备份已核验后**，才提出生产单号接入；手动、定时、第二号及持续新文章分别追加真实验收，不能用单次同结果冒充持续更新。

本轮结论为“**设计完成，官方接口能力已核对；Wechat2RSS 私有实例、目标五篇、历史查询、文章身份、正文和图片均未实测**”。如果真实接口无法补齐文章身份/正文/图片及查询门槛，停止候选，不切回电脑微信采集，不重试已失败的微信读书直连协议。
