# 私人跨设备阅读界面：本地准备，真实接入关闭

## 复用旧约定，不迁移本机职责

本轮复用 PR2 `edb0ecb799852a37bd26b7879a7962b10fbd98f3` 的 `scripts/sites-local-contract.mjs`、其测试及 [原合同](SITES_LOCAL_CONTRACT.md)，三个文件逐字保留。合同模块 blob 为 `66896a53ee61efd858efa5aa1abd37e19820c19e`，合同文档 blob 为 `36cb5578aa5c2983460ce4aedc36ea69ffc97f53`；生产源码 `8a3141c43b1b09e92ebd75780f26c58939557906` 中也是相同版本。

新开发分支基于 main `33ec7c3ebc20ce55d5f81259a5dd515912b5ca65`，补入这三个原样合同文件、独立 `sites/private-reader/` 及纯缓存验证适配，不合入生产分支的其他历史。本机继续负责采集、SQLite、图片缓存与归档；本轮没有服务器采购、云端内容副本、D1/R2、定时任务或持久连接。既有本地 UI 布局和性能工作文件不改。

## 本轮可验证范围

本阶段真实接入只以公众号为目标。小红书已明确暂缓，是可选能力，不是公众号接入的前置条件或阻塞，不要求补齐它的路由。页面保留旧合同的两个平台选项及合成测试；未来公众号专用通道应对小红书命令明确返回 SOURCE_UNAVAILABLE，不接入其来源。公众号支持有界订阅列表、作者文章列表、缓存正文和当前浏览器设备的单篇离线 HTML 下载。只用旧合同已有字段，不新增任意 URL/路径、tRPC 选择器或管理命令；公众号使用原游标。

浏览器只请求同源 `/api/subscriptions`，不接收本机地址、认证秘密或服务 bearer。Worker 包装层复用 `createSitesWorker`，并在转发前只允许 capability/authors/items/body/download，拒绝 refresh 和 operation status；页面没有手动刷新按钮。旧合同的进程内刷新实现未挂载、未改写、未启用。

页面分别显示身份未配置、未登录、非本人、本机不可用、读取超时、缓存缺失、当前范围为空等状态。失败不冒充空列表，不自动重试。选择切换会取消旧读请求，迟到结果不能覆盖当前页；权限或连接失败会移除旧正文、图片和列表。正文以文本节点展示，图片仅接受旧合同已验证的 data URI；不挂载缓存 HTML。下载必须由当前用户点击，生成真实 Blob 并保存在当前设备，不写 Windows Vault。

## 默认拒绝与真实接入阻塞

默认 Worker 没有任何 authorize 或 transport 适配器；即使请求携带 Sites 身份 header、服务 bearer、isOwner 字段或环境标记，也保持拒绝。假 owner 对象仅存在于合成测试，构建检查禁止将测试目录打包。生产入口不会读取这些测试桩，也没有环境变量开关可将其开启。

未来真实路线仍是：私人 Sites 同源服务端核验 visitor 身份及本人授权 → 经认证的 HTTPS 连接 → 独立认证的本机窄网关 → 原受保护 caller。Sites dispatch 的 visitor 身份不等于 owner 权限，服务访问 bearer 不等于 visitor 身份。不能单凭转发 header、loopback 来源或 JSON 布尔值放行，不能伪造 appRouter 的 isLocal/errorMsg。

目前公众号真实接入必须继续保持关闭的事项（不含小红书）：

1. 尚未创建目标私人 Site，私有 audience、可信 dispatch 来源与站点内本人身份映射未绑定。
2. 没有已批准并核实的 HTTPS 本机连接、连接身份传递及失效约定；本轮不创建隧道、凭据、监听器，不改端口/防火墙/权限。
3. 没有挂载本机网关或创建真实受保护 caller。缓存校验的代码缺口已由下述纯函数及真实 projector 合成链补齐；未来获准的本地主服务接线仍须显式注入该函数，不能将合成 caller 当成真实权限绑定。
4. 真实跨设备和本人/非本人验收尚未完成，不能把合成链路、DOM 测试或生成 Blob 宣称为手机已取得真实文章。

| 兼容性检查                                              | 生产源码 8a3141c         | main 33ec7c3                                 |
| ------------------------------------------------------- | ------------------------ | -------------------------------------------- |
| 原合同与测试                                            | 原样存在                 | 本补丁只按 PR2 原样补入                      |
| 微信 feed.list / article.list / article.byId 字段与游标 | 源码形状兼容             | 源码形状兼容，仍需未来真实 caller 隔离集成   |
| 微信 verifiedDownloadBody 缓存校验适配                  | 既有模块可供未来显式绑定 | 原基线缺组合验证；本 PR 已补纯函数，尚未挂载 |
| 小红书 list / notes / body 路由                         | 可选能力，当前暂缓       | 暂缓，不阻塞公众号，本轮不补路由             |
| Sites 身份、本机连接与路由挂载                          | 未绑定                   | 未绑定                                       |

## 已补的公众号缓存验证缺口

main 已有 `collection/image-fetch.ts::decodeInlineImage`（规范 Base64、MIME/容器、明显截断检查）及 `wechat2rss-cache-body.ts::inertDownloadBody`（支持的媒体检查、标签/属性白名单）。原来缺少的是两者前后的组合校验，不是缺少 HTML 解析器。

新增 `apps/server/src/sites-wechat-cache.ts::verifySitesWechatCachedBody` 仅抽取生产 `8a3141c` 的 `article-verified-download.ts::verifiedDownloadBody` 严格缓存策略，复用上述 main 函数；没有复制其下载、落盘、导出或来源采集逻辑。拒绝挑战/登录页、缺失/清空正文、远程或缺失图片、伪造或截断图片、待确认媒体、音视频和超限内容；净化后仍须有正文或图片。不能通过删除未缓存图片把部分正文冒充完整缓存。字节检查不等于完整图片解码，也不证明原文身份/发布时间；文章归属仍由旧合同核对缓存行 id/mpId，内容仅声称是该缓存行。

服务器纯函数保留原 35 MB 输入、5 MB 非图片正文、60 图和 20 MB 图片总量边界；旧 Sites 合同在投影后继续执行更小的 250,000 字节文本、单图 1,000,000 字节和累计 4,000,000 字节边界，超限明确拒绝，不截断或补抓。接线形式为原 `createWechatCacheProjector({ verifiedDownloadBody: verifySitesWechatCachedBody, load })`；该 projector 的实际 Cheerio 提取和上述真实纯函数已一起通过合成 caller → 本机合同 → Worker → 浏览器客户端 → Blob 回归。默认 Worker 不包含此 Node 侧代码，也没有因此获得真实数据权限。

## 下一阶段公众号真实接入的最小配置

下列是待实施清单，不是本轮已经创建或启用的配置。无需额外购买应用服务器，也不要求重新登录微信、提供公众号 Cookie 或开通小红书账号：只读已保存缓存。

| 对象            | 最小配置或账号                                                                    | 如何使用及当前状态                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sites           | 当前 ChatGPT 账号下的一个 owner-private Site、真实 project_id、平台分配的站点地址 | 不要求自有 Sites 域名；保持 private audience，原生创建/发布尚未执行                                                                                                                      |
| 本人身份        | 此 Site 内经过可信 dispatch 验证的本人稳定 user id，与 project_id 配对            | 存服务端配置；不以 email、JSON owner 布尔值或跨 Site 的旧 ID 授权。本人 ID 需经已确认 owner-private 站点的本人会话核对后固定，不能由首个任意请求自注册                                   |
| HTTPS 本机通道  | 一个稳定 HTTPS hostname 指向 Windows 上的窄网关；具体通道服务待确认               | 可复用已有通道。一个具体可选方案是 Cloudflare 账号、账号内已接入的域名及一个子域、named Tunnel；目前未查验用户是否具备这些，不预设采购或变更 DNS                                         |
| Site → 网关认证 | 仅此只读网关可用的独立高熵密钥及固定 HTTPS URL                                    | 密钥只进入 Sites runtime secret 和本地受保护配置；浏览器不接收。网关每次独立核验，只允许公众号只读命令；密钥不能当 visitor 身份                                                          |
| 本地应用权限    | 当前主服务的原有访问凭据及其真实受保护 caller 接线                                | 凭据仅留 Windows；按原认证路径构建上下文，禁止因 loopback、转发 header 或 tunnel 存在就设置 isLocal/errorMsg。只暴露既有 feed.list、article.list、article.byId 的窄能力，不暴露整个 tRPC |

本人校验落地顺序：私有 Site 平台先挡匿名访问；Worker 仅信任受平台保护的 dispatch 注入身份，对每次 API 请求将站点内 user id 与固定本人 ID 严格比较，缺失返回 UNAUTHORIZED、其他人返回 FORBIDDEN；服务 bearer 不能替代 visitor。只有本人通过后才发送固定 URL 的 HTTPS 读命令。网关再独立核验服务凭据、固定命令和限额，并使用原受保护 caller；两层任何一步缺配置或失败都不读缓存。不得将通道的身份 header 原样转成应用登录权限，也不把 Sites 服务访问令牌转发到别的域名。

main 的实际应用认证位于 `trpc/trpc.router.ts::applyMiddleware`：本地模式核对已有 `auth.code`（Authorization），private-online 模式核对 `hasPrivateSession`。接线需要保留当前模式的真实验证，不能无条件调用 `createCaller({errorMsg: null, isLocal: true})`；新服务密钥只证明调用了窄网关，不自动替代原应用认证。没有已确认的原应用身份绑定时继续拒绝。

若选择 Cloudflare，named Tunnel 将子域映射到本地地址，连接由 Windows 出站建立；不需要开放路由器入站端口，但安装/运行 connector、允许相应出站网络、保存 tunnel credential 和配置 DNS 都是新的持久访问变化。参见 [Tunnel 模型](https://developers.cloudflare.com/tunnel/) 和 [发布应用的前置条件](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)。Cloudflare Access 服务令牌可作为额外边缘门禁，配置时必须用 Service Auth 策略；它不替代网关密钥、本人身份或原应用认证。参见 [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)。本轮没有创建这些资源或凭据。

需要父线程另行落实的实际变化：创建/发布私有 Site 和写入 runtime secrets；选择并注册 HTTPS 通道、DNS/Access 策略和 connector 凭据；主服务增加受控窄路由或本地监听；部署后再按是否需要明确配置自启动。它们涉及新持久访问或网络权限，本轮均不执行。纯代码阶段可继续写固定 URL/密钥的两层适配和现有主服务接线的合成认证测试，但这轮仅完成已明确要求的缓存验证，不新建通用网关框架。

真实验收应单独覆盖本人手机读取/下载、匿名和其他账号拒绝、无 visitor 的服务令牌拒绝、主机关机/通道失效/令牌撤销、未缓存正文/缺图及超限明确拒绝。保留原缓存和数据库，无补抓、无刷新、无自动重试。

## 构建与验证

```text
node --test scripts/sites-local-contract.test.mjs sites/private-reader/test/*.test.mjs
node sites/private-reader/build.mjs
```

仅复用仓库已有 esbuild，不新增依赖。本地构建得到单文件 Worker ESM `sites/private-reader/dist/server/index.js`，内嵌同源浏览器脚本；不包含测试适配器、Node/Nest/Prisma 代码或真实文章。没有 Site identity，因此不生成假的 `.openai/hosting.json`，产物不是已注册或可直接宣布部署的 Site。

真正创建 Site 后，由父线程按 Sites 原生 Worker ESM 工作流绑定身份和 hosting manifest；不能直接把这份默认关闭构建当作生产连接配置。此轮不调用 Sites 创建/发布/secret 工具，也不连接第三方服务。

测试执行实际旧合同客户端、Worker Request/Response、本机合同与合成 caller，覆盖两层独立权限、字段脱敏、PNG 字节、断网 HTML、只读命令门禁、离线/超时/不重试、分页、迟到请求、失去权限后的清空和显式下载。DOM 测试调用实际页面渲染函数，禁止 innerHTML；没有启动预览服务、浏览器、真实 Sites 或跨设备验收，没有复制或打开生产数据库。旧合同自身的合成刷新测试保留，用于证明复用未改变合同，并不表示新增页面开放刷新。
