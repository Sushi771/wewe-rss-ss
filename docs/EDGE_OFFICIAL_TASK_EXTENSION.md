# Edge 官方文章任务候选（2026-10-05）

本轮交付可审查的 MV3 扩展源码、最小一次性本机任务适配和离线回归。**未安装扩展、未开启开发者模式/持久权限/配对，未注册进 AppModule，未部署或占用4000，未发起微信平台或真实媒体请求。未知短链及公众号最新文章实站回送仍未验收，后台停止状态保持。**

独立分支 `codex/edge-official-task` 基于已提交 `770025c`，原主区所有权及未提交代码不改。唯一运行 owner 另行管理组合部署，本文不把其产物或账号数据算作扩展验收。

先前 0.1.0 候选集成复跑相关服务端 6 套／127 项测试、扩展 14 项离线测试及服务端构建通过；准确主区提交 `78ca3fddc8d233bf083072d5fcb415c1c4349db4` 的 CI `37268786106` 四项及扩展 CI `37268786117` 均成功。主应用入口和模块未注册候选路由，已运行产物未改变。0.1.1 的相关离线测试与远端 CI 分别核对，不沿用此前结果。

0.1.1 后续授权与改进：用户已确认安装与一次 MAIN 只读核验，实际手动安装仍待实施；扩展管理内部页的 CUA URL 安全拒绝已停止，没有绕过。本次改进只做离线开发，不安装、不运行新的实站 probe、不扩大权限。popup 以可选中的纯文本展示白名单布尔和有界计数；明确区分 false 与 missing/早退“未核实”，不输出原值或指纹。标题/来源匹配须两侧正规化文本均非空；DOM 与已返回正文一致仍不证明上游全篇完整性，图片显示加载不证明原始字节或完整保存。0.1.1 审查 ZIP 仍为 9 个根文件，测试不打包，0.1.0 ZIP 原样保留。

主区复跑 0.1.1 的 23 项扩展离线测试全部通过，覆盖一次 MAIN 调用、零网络和权限动作、早退未知字段、空标题/来源，以及摘要不输出原值或哈希。安装后的真实 Edge 弹窗视觉、实站组件关联及全文/图片能力仍未验收。

## 成熟模式、许可与依赖

先核 [GoogleChrome 官方 page-redder 样例](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/sample.page-redder) 的 MV3 `activeTab+scripting` 和点击注入模式；上游 [LICENSE](https://github.com/GoogleChrome/chrome-extensions-samples/blob/main/LICENSE) 为 Apache-2.0。扩展按该标准 API 模式独立实现，没有复制样例源码或新增运行依赖。Chrome 的 [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) 与 [scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting) 文档支持临时访问当前页面，以及 MAIN/ISOLATED 执行世界。

同时核 [SingleFile](https://github.com/gildas-lormeau/SingleFile) 页面及其 [AGPL-3.0 LICENSE](https://github.com/gildas-lormeau/SingleFile/blob/master/LICENSE)，没有集成其完整页面归档实现或安装外部软件。本项目已有 MIT 许可；复用当前仓库 Provider、正文解析、媒体验签、保存与导出模块，避免新采集框架。

## 最小权限清单

| 声明                               | 状态与用途                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `activeTab`                        | 用户点击扩展后临时读取当前标签页；运行代码只接受 `https://weread.qq.com`。                            |
| `scripting`                        | 顶层 MAIN 仅投影正常文章业务字段，ISOLATED 读取可访问文章 iframe；不注入全部 frame、不操作验证。      |
| optional `http://127.0.0.1/*`      | 未申请/未授权，待确认后用于本次任务通信。匹配语法不能限定端口，代码和服务器再次锁定精确 origin/port。 |
| optional `https://mmbiz.qpic.cn/*` | 未申请/未授权，已有真实图片来源证据；仅获取本次 DOM 中已正常加载的精确 CDN 图片。                     |

不声明 `cookies`、`webRequest`、`debugger`、`tabs`、`storage`、`all_urls`、持久 weread host、content_scripts、后台 worker 或 externally_connectable。popup 只调用 `permissions.contains`，没有自动申请或启用权限的代码。密钥仅在本次 popup 内存中，成功/失败均清除输入；不复制浏览器/后台 Cookie、token、ticket，不读取凭据数据库或 DevTools。

真实公众号任务路径精确限定为 `/web/mp/reader/目标`，普通书籍 `/web/reader/`、空目标和其他路径拒绝。服务端、client、MAIN、ISOLATED 和 probe 使用同一范围。

## 数据流与当前闭环

1. 未来原 WeWe 单篇下载/指定公众号刷新动作在其现有认证、Origin 和目录选择授权通过后，内部调用 `BrowserTaskBroker.issue(target)`；浏览器没有签发任务 API。目标 URL 和可选公众号 ID/名称来源于用户本次动作。
2. 用户在原官方已登录会话中正常打开目标、亲自完成官方验证码。扩展不发验证码请求、不点击/解题、不转移票据、不清除 WeWe 的后台 `-2041`。
3. popup 点击先 claim 本机任务，再绑定当前 tabId/windowId/官方 origin+path。MAIN 读取白名单业务投影，ISOLATED 读取一个 `iframe.mp_i_frame[srcdoc]`，然后再次读取业务投影并检查页面未切文/导航。
4. 扩展回送由静态白名单构造的身份/发布时间脚本、标题、公众号、净化后的正文和实际图片 data URI，**不回送原脚本或整页面状态**。所有观察均为不可信输入。
5. 本机校验配对密钥、严格 extension Origin、Host/port、loopback、JSON 类型、五分钟截止、一次 nonce 和来源 binding；完成前先消费任务，失败也不能重放。
6. 本机复用 `parseWereadDirectory`、`verifyWereadArticleBody`、`validateImageSignature`、`decodeInlineImage`、`verifiedDownloadBody` 和 Provider 合同。原文静态 ct 是保存时间来源；目录时间只用于目录，不覆盖原文时间。未知短链必须与 currentChapter 的 originalId 一致；无需已入库文章或既有正文哈希。
7. 已核 Provider 返回内部 owner，沿原本机请求调用 `saveVerifiedArticle(article,{url,pickToken},req,res)`，保留认证、Origin、目录授权、并发与旧笔记保护。扩展请求不会伪装为原本机请求，配对密钥也不代替原保存认证。

离线合成新文章（此前无 DB/cache record）已验证任务领取→HTTP 回送→Provider→原内部保存器→Markdown/实际 PNG 字节；重复保存保留用户改过的旧笔记。数据库没有生产写入，也没有模拟成功验证码。这个结果是工程闭环，不是实站取文成功。

公众号刷新尚无产品调用或遍历代码。待真实目录、逐篇关联/完整性通过后，由 owner 在原 refresh transaction 复用 Provider 去重与旧数据保护；不能用一篇正常展示替代最新十篇目录，也不能以本扩展任务修改停止状态。

## 精确官方业务投影与实站证据缺口

只读已保存官方 `19.42e251bc.js` 确认：组件 `MpReader`、根 `.wr_mp_reader`、业务模块名 `mp`；`currentChapter.reviewId` 供正常 `/web/mp/content` 请求，返回值经 `FETCH_MP_MODIFY_MP_CONTENT` 到 `mpRawData`/iframe。目录 `/web/mp/articles` 的 `reviews[].subReviews[].review` 包含 `belongBookId`、type16 和 `mpInfo.originalId/title/mp_name/time`。没有执行这些接口。

`projection.mjs` 只读取根组件的 `$options.name`、`bookInfo.bookId`、`currentChapter.reviewId` 以及 review 的 `reviewId/belongBookId/bookId/type/mpInfo.{originalId,title,mp_name,time,pic_url}`、正常 loading/error/forbidden 标志。`mpRawData` 是该组件正常显示文章的业务 HTML，仅在页面内 DOMParser 求 `js_content` 净化文本+图片数的 SHA256，原 HTML/scripts 不离开页面。**不访问 `$store`、user、token、envConfig，不遍历组件/整个 state，不调用页面动作或网络。**

owner 在已有官方页用受支持 CUA 做了限定只读核验：首次 `{supported:false,componentMatched:false}`；后续父线程授权的汇总诊断为 rootCount1、vuePropertyPresent/vueValuePresent/optionsPresent/namePresent 全 false、componentName null，无交互或联网，也没有工具安全拒绝。这只证明当前 CUA 可见上下文看不到 `__vue__`；可能是隔离世界/只读 DOM 包装，也可能是页面挂载契约变化。**不能据此断言官网没有业务状态，不能称产品 MAIN 注入通过。没有再探测或使用 reset/CDP/组件树 fallback。**

`probe.mjs` 是具体最小只读验收函数，仅返回存在性、匹配、计数、正文指纹。安装确认后的单次最小实站验收应检查：

- MAIN-world 是否能定位该唯一根组件、白名单业务字段是否符合已审计 shape，标题/公众号/biz 与当前章节关联。
- raw business body 与 iframe 正文指纹是否一致，静态 biz/mid/idx/ct 是否存在；canonical 是原页面真实字段，禁止补造。
- 图片类别/实际加载、读取 data/blob 的原始字节及精确 CDN optional permission 下正常字节获取，实际存盘可打开。
- 未知短链真实映射、列表当前窗口以及原刷新连续新文/重复去重分别验收。

现有浏览器记录指出 srcdoc 缺 canonical/reviewId/originalId。projection 可能提供 reviewId 关联，但 canonical 缺失仍会被现有正文验证器拒绝，禁止虚构 meta 绕过。正文指纹只证明 DOM 没有截短于组件已返回的业务正文，**不证明上游给了全篇或账号授权**；非空 DOM、END 字样、loaded 图片均不是充分证明。默认 `routeVerified:false`，须在正常官方路径、完整性判定与真实字节证据完成后由用户/owner 明确决定启用。当前缺口不靠继续堆缓存演示解决。

## 图片、大小与安全边界

data URI 仅 PNG/JPEG/GIF/WebP 原字节；blob 仅同官方 origin 的已有 Blob。remote 仅本次已加载图片的 `https://mmbiz.qpic.cn`，扩展 fetch 使用 `credentials:omit`、`redirect:error`、十秒超时和流式上限。没有 canvas 重编码、服务器外部图片 fetch、任意来源回调或内网 URL。未授权媒体、跨源 blob、缺图/未加载、格式或容器不符均失败，不保存部分正文。

每篇最多60处图片，单图10MB、总图片20MB、净化正文5MB、总 JSON35MB；服务端独立再验。容器检查不是完整像素解码器，真实可打开必须另验。固定公开 CDN allowlist 防止用户指定内网主机/重定向，未更改浏览器 DNS 或系统网络。字节或正文不写公共日志；服务端失败仅固定 code，无 raw exception/URL/HTML。任务内存最多4个，5分钟或取消/进程重启即撤销，无持久票据。

MAIN 世界由页面控制，业务投影不能作为认证签名。服务端仍交叉校验字段与正文、当前任务目标、canonical 和实际媒体；真实路线验收门禁不得由页面自行打开。来源 tab/window 由扩展本次 API 读到并通过 nonce 锁定，服务器无法独立证明浏览器进程的 tab ID，信任的是用户批准且配对的扩展，不是任意站点 POST。

## 安装与集成步骤（本轮未执行）

按用户已确认的安装与一次只读核验范围，用户方便时可按 [Microsoft Edge 官方本地加载说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading) 在扩展管理页开启 Developer mode，Load unpacked 选择经过核验的 0.1.1 解包目录，不需要安装浏览器或发布商店。本次开发未执行安装或实站核验，此候选仍未配置，popup 不请求 optional 权限。

配对/持久访问须再确认：用户审核实际 extension ID 和权限；owner 使用私有配置生成32字节随机本机 pairing key，锁定 `chrome-extension://实际ID` 和精确回环端口，不能提交密钥。按单次授权点击 popup 的“只读核验当前文章关联（不回送）”按钮验证 MAIN-world 的只读 probe；该按钮不需 loopback/CDN 权限。0.1.1 摘要列出组件/iframe、身份字段与业务关联、标题/来源匹配、静态身份/发布时间/canonical 存在性、DOM/raw 指纹存在与一致性，以及图片类别/显示加载计数；不显示 ID/URL/标题原值/HTML/正文/hash/认证信息。所有未返回或非法类型均保留“未核实”，无自动重试；可选中摘要由用户反馈。canonical 仅显示字段存在，不称有效；全篇完整性固定未证明，原始图片字节/完整保存本轮未验证。工具或平台拒绝立即停；不重新登录/验证码或重复失败请求。optional host 权限需受审的显式用户操作，当前候选没有此权限申请入口。

通过真实验收后，owner 可将 `BrowserTaskController` 注册到 AppModule，并以 `BrowserTaskBroker` 私有 `useFactory` 提供配置；保留 `privateAccessGuard`、独立 strict CORS、原请求授权及限流。现有 main.ts 全局 JSON10MB 比适配上限小。新增 `browserTaskBodyParser` 必须仅挂到 `/browser-task` 且在原全局parser之前，先loopback/Host/Origin/配对鉴权再缓冲：complete35,000,000字节，claim/cancel4KB，不能全应用放大。Nest 的自动解析也须排在这个门禁之后。当前 app.module.ts/main.ts 未修改。

离线HTTP边界回归使用有效合成PNG组成超过10MiB的JSON，核现有main同参数parser返回413；route-scoped parser授权后可接收，未配对的非法JSON在解析前401。此处是隔离HTTP/实际解析器测试，不是已注册进主应用的真实生产传输验收。

原 main.ts 的全局 `enableCors` 也可能提前响应 OPTIONS；未来注册须明确排除 `/browser-task` 并采用这里的严格 Origin/header preflight，不把现有宽泛 CORS 当成扩展配对。媒体字节获取完毕后还会再次检查原tab/window/path和文章投影，切文立即取消。

原工具动作只签发已授权目标，返回任务编号/截止并在本机保留保存意图及目录 grant；接收端不会主动向该页发送消息。断开/过期取消，成功结果重新走原保存授权，不能仅用旧req快照覆盖会话失效。公众号批次须完整目标全部成功后再走原Provider事务，旧笔记、旧ID/发布时间/正文和指标保持现有保护。WeWe 单击→官方页/扩展启动和最后保存的用户流程还未接线，popup task输入是候选调试入口，不能称原按钮验收。

## 开发与回归

干净环境使用当前仓库锁文件 `pnpm install --frozen-lockfile`，没有扩展运行依赖或打包步骤。运行：

```powershell
node --test extensions/wewe-official-task/*.test.mjs
pnpm --filter server exec jest browser-task --runInBand
pnpm --filter server build
```

`dom-harness.test.mjs` 运行序列化采集函数和窄投影，敏感属性 getter 设为抛错；`offline.test.mjs` 测传输/权限/切文/精确CDN/内部 URL 拒绝，HTTP test 只启动临时测试服务器。Nest 新路由不在生产 AppModule。另有默认disabled、nonce/来源跨任务、过期/重启、schema/正文截短/时间/身份/缺图/原保存旧笔记保护测试。所有公开 fixture 为合成，不提交私人文章全文或原始证据。

相关服务器回归和 server 构建通过，最终测试数量见准确 PR；扩展 DOM/传输离线回归在准确提交运行，CI 以 PR 准确 SHA 为准，不能拿主区 CI 替代。本公开说明不包含私人运行数据。
