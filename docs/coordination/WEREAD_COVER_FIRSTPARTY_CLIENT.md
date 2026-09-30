# 微信读书公开首页的封面请求与登录状态（固定静态资源）

日期：2026-09-30。本次只读取腾讯公开首页 HTML 和其公开 CDN 静态 JS；没有请求目标号接口、文章、书架、登录或续期，也没有读取本地凭据。下述偏移是下载文本中的零基 UTF-16 `IndexOf` 偏移，哈希是响应内容按 UTF-8 编码后的 SHA-256；借此可在资源更新后仍复核本次观察。

## 固定来源和真实调用

匿名 [`https://weread.qq.com/`](https://weread.qq.com/) HTML 的 SHA-256 为 `e30554771617ff7d81cf1d39ab97c0b3dbdfa0b532cf5d6ce0c2eeca6ac21866`，引用 `https://cdn.weread.qq.com/web/wrweb-next/_nuxt/` 下的脚本。下表中的 JS 均为该首页引用或主 bundle 明确导入的腾讯静态资源。

| 资源                                                                                      | UTF-8 大小 / SHA-256                                                             | 精确证据                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`DIOuE9ph.js`](https://cdn.weread.qq.com/web/wrweb-next/_nuxt/DIOuE9ph.js)               | 180856 字节 / `90cc3c9a6934b7e8bbc6e2427fef8d53fb36260a8c47dbf54d146aa70fcb0895` | `BookCover` 组件定义偏移 23779，`lazy` 默认 `false`；偏移 25477 的 `b()` 对传入 `book.bookId` 且 `bookType/type===BOOK_TYPE_MP_ARTICLE` 发 `wrFetchClient('/api/mp/cover',{method:'GET',query:{bookId:o.book.bookId}})`；偏移 26139 的 `onMounted` 调用 `b()`。偏移 148819 的 `/web/shelf` 仅在顶部导航点击时跳转。文件头偏移 434 将主 bundle 的 `g` 导入为 `wrFetchClient`。 |
| [`BVQc4ULa.js`](https://cdn.weread.qq.com/web/wrweb-next/_nuxt/BVQc4ULa.js)               | 664821 字节 / `5b89f8913d89385a1e7a10f840d565e5fac0203f0e4b0e8cc16ea0bb7504bf54` | 尾部偏移 662965 把 `la` 导出为 `g`。`la` 定义偏移 590531：向 `$fetch` 选项显式增加 `X-SSR-Request-Id`，没有在此 wrapper 显式增加 `x-vid`、`x-skey` 或一次性 ticket。相比之下偏移 185147 的另一个 wrapper `g4` 明确增加 `x-vid/x-skey`；封面组件未使用 `g4`。                                                                                                                  |
| [`DK1lkih1-legacy.js`](https://cdn.weread.qq.com/web/wrweb-next/_nuxt/DK1lkih1-legacy.js) | 278240 字节 / `bc93202fb565e1748dd4cd0d824b6ca8d8cc6e260516758cf58bcc839eac9080` | 同一 `BookCover` 旧语法构建在偏移 122887 也调用 `/api/mp/cover`；偏移 245607 的 `/web/shelf` 是导航链接。                                                                                                                                                                                                                                                                     |

`/api/mp/cover` 是**当前公开首页这套 Nuxt 组件确实编码的请求路径**，其输入 `bookId` 来自上游传入的 `book` 对象，不是组件自行从任意公众号生成。它只尝试取得单个书籍的封面数据；静态代码没有证明跨号可读、目标号 `bookId` 会出现在当前首页卡片、服务器成功回包、`reviewId` 的当前字段结构或列表/分页能力。`lazy=true` 且组件尚无图片节点时可能提前返回，因此“组件挂载后调用”还受该分支约束。

`la` 对相对路径使用 `$fetch`；代码层显式 header 只有 `X-SSR-Request-Id`。正常浏览器对同源请求可能附 Cookie，但本次静态分析没有观察实际请求头、服务器 `Set-Cookie` 或 ticket 签发。首页 HTML 的 Nuxt state 自带一次 SSR `requestId`，每次页面可不同；不能在隔离 HTTP 探针中猜一个值，亦不能把缺失此 header 自动解释成认证失败。

## 当前首页的正常 QR 登录生命周期

同一 `BVQc4ULa.js` 在偏移 638087 用 `la('/api/auth/getLoginUid')` 取登录 UID；偏移 639192 用 `la('/api/auth/getLoginInfo',{query:{uid,otp},timeout:60000})` 轮询。处理函数在偏移 638500–638900 要求返回 `accessToken` 和 `webLoginVid`，然后写 auth store `skey=accessToken`、`vid=webLoginVid`，并通过客户端 Cookie helper 在 `.weread.qq.com` 域写 `wr_skey`、`wr_vid`；紧接着使用**另一** `g4` wrapper 调 `/api/userInfo`。状态初值在偏移 180246 为 `hasLogin=false,vid=0,skey=''`。这是一条公开客户端的正常扫码登录代码链，无须推断浏览器流量。

这里的 `accessToken` 是该 QR 登录响应字段；仅因同名，不能推定它与本人已有移动 `/login` 的 accessToken、移动刷新令牌，或旧 `i.weread.qq.com/book/articles` 自定义 `skey` 头等价。本机先前的 mobile→Web init 下发 `wr_vid/wr_skey/wr_rt/wr_pf/wr_ql` 且 Web 书架成功，但那次 Web init **不是**当前首页 QR `getLoginInfo` 响应。本次静态代码没有证明两条凭据签发链在 `/api/mp/cover` 上同权，也没有证明移动 init 必须或不必附加浏览器页面状态。客户端设置的 Cookie 过期时间不等于服务器会话有效期。

## 检索范围与不能外推的结论

扫描匿名首页直接引用的 12 个现代 JS、19 个 legacy JS，以及主 bundle 可见的 7 个额外动态 chunk 的字符串；后七个是 `CnBVFoH3.js`（267467 字节，`1cca4f21bcf8a920ac149324d9a6b1374de413af375f145c78230b3083e021c4`）、`BWkGjBhy.js`（1428，`91d482ecb7708c4a72f5578e22ebc71a3883bde0b43ab14f804946481e34d0ae`）、`CYK56l7u.js`（22209，`1943cfd74a6097c08c19a42fc8f02829a89b949e50bc864aed607f0face60ec6`）、`Dp6C8-4i.js`（172，`077eaf7022c7a14df752a73f43d1b4775497005dfeb83fb03c799858a1085edc`）、`CdKLF6oH.js`（490，`6fd72e8abd9ecc9d236c9def7f8b40c77aa658d9ca20e06bfb397956f326c394`）、`4279LnfW.js`（540，`a1a07820779939d5d0ee65240d2d518ad7cb5ee35fa74b2be4e9e002198e70eb`）、`oI9O3Sim.js`（540，`d9f7de67f7894ce49c7c2cf4c5478fb35825df221f21d8e78dcf1aff83918ffa`）。这些资源里有 `/api/mp/cover`，没有字面 `/web/mp/cover`、`/web/login/renewal` 或 `/web/login/session/init`。公开 `DIO` 里 `/web/shelf` 是导航链接，封面 `b()` 之前没有强制导航书架。

这只覆盖**当前首页 Nuxt 构建及上述可见导入**，不能据此否定旧 `/web/shelf` 应用或其他动态资源继续调用 `/web/mp/cover`、`/web/login/renewal`。对应的 [ShelfSignal 固定实现](WEB_MP_COVER_AUTH_DIFFERENTIAL.md)确实先开 `/web/shelf` 再调用 `/web/mp/cover`，但其代码没有展示导航步骤额外签发 Cookie/ticket 的前后对照，公开 canary 也没有原始头/回包。`DIOuE9ph.js.map` 在腾讯 CDN 为 `NoSuchKey`，因此本次依据是固定 minified JS 中可直接判读的调用，不是 source map。没有取得腾讯官方 `/api/mp/cover` 成功响应样本；we-mp-rss 的同路径第三方开源调用和 2026 issue 只提供候选，不是本账号的成功证明。

## 独立验证边界

已有 `/web/mp/cover` 本账号单次 HTTP 200、业务 `-2012`，其哨兵保留，不能重试；本次发现的 `/api/mp/cover` **路径与第一方调用均不同**，可以单独审查一次只读请求。若总控决定执行：仅使用已合法取得并私存的恢复凭据正常 Web init 建隔离 Cookie jar，先核 `wr_vid` 与原账号一致及无登录/验证错误，再固定 `GET /api/mp/cover?bookId=MP_WXS_3895431412` 一次；不导航页面、扫码、重试、跟随跳转或连取正文。发送前在仓库忽略的固定 `private-data` 原子落独立哨兵；HTTP 200 有界 JSON 且无验证/限制业务码时先原子私存原始响应，再判目标名称和 `reviewId`，公开输出只含脱敏结构。若返回 `-2012`、验证或限制，即停止该条件，不换 header、Cookie 或端点盲试。即使成功封面也最多证明目标当前一篇，仍需独立的原文与多篇列表证据。

### 单次探针的离线实现

[`probe-weread-api-mp-cover.cjs`](../../scripts/research/probe-weread-api-mp-cover.cjs)复用已审的移动恢复凭据、生产库只读/一致性备份核对、目标号号名、Web init 业务码与 Cookie 作用域门禁。它只接受 `private-data/mobile-refresh-*` 既有恢复目录；在固定、被 `.gitignore` 忽略的 `private-data` 根目录放新的 `/api` 专用哨兵、原始有界 JSON 和通过身份门禁时的 `reviewId`。预检扫描根目录及所有恢复目录的 `/api` 历史文件以防重复，不会覆盖 `/web` 探针文件。未知 HTTP 200 JSON 结构先私存再判读，写盘失败只留在当前进程中重试本地持久化，绝不重发网络请求；验证/限流/非 JSON 不保存潜在验证页。没有文章 GET、翻页、自动登录或页面导航。输出只有状态码、受控业务码、已知 Cookie **名称**、身份布尔和文件落盘布尔，不含 Cookie 值、token、`reviewId`、标题或 URL。

第一方 `$fetch` wrapper 显式加入页面 SSR `X-SSR-Request-Id`，而该隔离探针没有正常页面的 SSR state，故**不编造此值**；也不伪称其请求头与页面运行时完全一致。它只验证已知正常 mobile→Web init 会话对另一条 `/api` 路径的响应，失败不证明真实 QR 浏览器会话也失败。服务端如要求页面态，须另有一手证据和独立复审，不能在这个探针后变更头再试。

离线 `node --check`、`--plan`、`--self-test` 均通过；假网络覆盖至多一次 init/一次 cover、init 401、封面 `-2012`、未知结构先私存、原始 JSON 首次落盘失败仅本地重试、独立哨兵防重与输出不泄密。执行前，以现有生产库和合法恢复目录运行只读 `--preflight` 得 `preflight_ready`、`sourceAndBackupMatched=true`、`targetFeedMatched=true`、`existingApiCoverHistory=false`、`networkRequests=0`、`productionWrites=0`。

## 本账号一次在线结果与停止边界

总控随后按上述已审脚本**仅执行一次**：`/web/login/session/init` HTTP 200，隔离 Cookie jar 有 `wr_vid/wr_skey/wr_rt/wr_pf/wr_ql`，`wr_vid` 与同账号一致；目标 `/api/mp/cover` HTTP **401**。没有文章、列表、页面导航、跳转或重试请求；独立 `/api` 哨兵已在仓库忽略的固定 `private-data` 持久化，生产库写入 0。401 没有可接受的封面 JSON，因而没有本账号的 `reviewId` 或原文证据。**同一条件下不得再请求 `/api/mp/cover`**，也不得通过随意添加 SSR ID、Referer、Cookie 或 ticket 把 401 当成可碰运气的参数题。

这次结果只排除“现有合法移动刷新凭据 → `/web/login/session/init` → 五 Cookie → 无页面 SSR `X-SSR-Request-Id` 的隔离 `context.request.get('/api/mp/cover?bookId=<目标>')`”这一请求形态在此次账号、目标号和时点成功。它没有实测正常 QR 登录后的浏览器页面请求，也没有证明 401 必由缺少 SSR ID、缺少页面导航、移动与 QR token 不等价、目标跨号权限或其他某一原因导致。旧 `/web/mp/cover` 的 HTTP 200/业务 `-2012` 是另一条路径和另一层响应，不能互相替代解释。

## QR 浏览器会话的剩余证据与缺口

针对固定首页 bundle 再核：`BVQc4ULa.js` 的 `getLoginInfo → accessToken/webLoginVid → wr_skey/wr_vid → /api/userInfo` 是可审查的**正常 QR 登录客户端链**；其 `BookCover` 后续可能在有 MP book 卡片时用同源 `$fetch` 调 `/api/mp/cover`。这构成与本机 mobile→Web init 不同的认证来源和页面上下文，但源码没有显示 QR 响应在服务器上为目标封面授予什么权限，没有 `/api/mp/cover` 的成功回包，也没有证明 `X-SSR-Request-Id` 是访问控制凭据。`BookCover` wrapper 没有显式 ticket 或 `x-vid/x-skey`；不能从另一个 wrapper 的头名推给它。当前匿名首页 HTML 未含 `MP_WXS_*` 书籍对象，故静态组件存在也不等于本次匿名页面实际发过封面请求。

本次定向检查固定首页的 38 个已列 JS、其 QR 处理和 `$fetch` 包装，并搜索公开 GitHub 中 `/api/mp/cover` 同时涉及 QR Cookie/2026 真实响应的组合；没有定位到腾讯服务端 401 判据、`/api/mp/cover` 的固定成功回包，或可将本机移动 Web init `wr_skey` 明确转换为 QR `getLoginInfo.accessToken` 的一手代码。下一次若研究 QR 路线，先要本人正常扫码产生真实浏览器会话，再单独审查一次与本次实质不同、可记录页面 SSR ID/请求上下文且不抓包作为产品运行方式的最小只读验证；缺乏该条件时只继续源码研究，不自动登录、不复用本次 401 路径。扫码后的服务端有效期和无人值守续期仍无一手证据，不能把封面探针成功等同可持续订阅。
