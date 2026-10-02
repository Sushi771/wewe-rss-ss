# 正常 SDK 授权到文章解析的隔离验证

**正文单次真实结果与离线对比（2026-10-02）：**
经代码审核及 9 项联合离线测试后，仅一次 `GET https://weread.qq.com/web/mp/content` 返回 HTTP 200、响应体 0 字节。私有 `sdk-login-owner-06/body/result.json` 记录 `success=false, stage=parsing, requests=1, productionUnchanged=true`；没有文章身份、可信发布时间或正文成果。原始空响应与元数据已私存，全局 `body-attempt.json` 已独占写入并永久保留，不重放。旧 resolver、cover 停止和生产全部字段均未改。

通过对历史成功正文请求（`owner-weread-latest.ts`，HTTP 200 且约 3.48 MB 非空回包）与本次 owner-06 单次 fetch 探针的离线比对：

1. **端点与查询参数编码**：总控离线比对已解析 reviewId，`axios.getUri({url: '/web/mp/content', params:{reviewId}})` 与 `new URL().searchParams.set(...)` 产出的完整请求 URL 逐字节完全一致，往返精确，排除了 URL 编码差异。
2. **Cookie 构造与会话时序**：均调用 `ownerSessionCookie(webSession, ownerVid)` 产出 `wr_skey=...; wr_vid=...`（按名称排序）。历史成功使用 2026-09-30 会话；owner-06 探针使用 2026-10-01 正常会话（`expires: -1, secure: true`）。历史成功紧随当次 `/api/mp/cover` 成功后同一进程发出；owner-06 探针为单次隔离探针（跳过 cover 以防 401 停止触发），其 `reviewId` 来自移动 Eink SDK 会话。
3. **显式与隐式请求头**：显式头（`Cookie`、`Referer: https://weread.qq.com/`、`Origin: https://weread.qq.com`、`User-Agent: Mozilla/5.0`、`Accept: text/html,application/xhtml+xml,*/*`）完全对齐。但隐式传输头存在差异：Axios 走 Node https adapter 默认头与连接管理，而 Node fetch (undici) 采用不同的默认连接/头策略。
4. **传输层（Transport）更正**：此前文档与脚本注释称“复用既有正文传输”，此表述不准确，现已纠正——实为“复用请求形状、Cookie 与解析逻辑，但底层传输由 Axios GET 变更为 Node fetch (undici)”。
5. **回包处理与诊断信息**：历史成功由 Axios 读取完整 `responseType: 'text'` 非空回包（私有 `native-content-attempt.json` 记录 3,475,514 字节）；本次 fetch 探针通过 `boundedBody(response.body.getReader())` 接收到 0 字节，解析器未吞没非空 Buffer。但本次探针未保存响应头（如 `Content-Length`, `Content-Encoding`, `Transfer-Encoding`），无法证明腾讯线路上游响应体本身为空。
6. **本地环境大流验证**：总控在 127.0.0.1 纯本地验证，Node fetch + `boundedBody` 完整逐字节读取 5.4 MiB 的 gzip chunked 流，排除了当前 Node 24 运行环境存在通用的压缩流读取丢失 Bug，但无法排除针对腾讯特定端点的连接/传输/会话差异。

基于上述确凿代码级传输差异（Axios Node https adapter vs Node fetch），已准备 Axios 对齐的最小研究探针与离线测试，且保持零联网。

2026-10-02。当前目标仍是公众号级完整近期发现。真实 Web 搜索五页已得 71 条候选，但完整覆盖、可信发布时间和批量正文仍未验证。`/mp/getreviewid` 仅解析已有 URL，不是公众号列表；owner-06 本人正常 SDK 授权后实际请求一次，HTTP200、success=true，候选 `WX_3895431412_2247493594_1` 的原始 URL、稳定身份及 `MP_WXS_3895431412_` reviewId 前缀门禁均通过。私有 result stage=parsed、requests=1、productionUnchanged=true、originalVerified=false；正文与真实时间仍待核。全局 resolver-attempt.json 已存在，不能删除或重放。MCP agy-d162d4ea 首次提交失败，恢复匹配 IDE 会话后实际执行成功，登记仍 FAILED。旧 mobile `/store/search` 401/-2012 不因新认证自动解除；下一任务严守零联网，未获总控代码审核前不发新腾讯请求。

## 正常认证复用与边界

复用 MIT 开源 [weread-omni 固定 88bd2e0](https://github.com/teng-lin/weread-omni/tree/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4) 的 requestQr/pollForCode/exchange，不安装运行 CLI，不导入 TokenManager 或 credentials 存储模块。真正移动认证头是 profile.authHeaders 返回的 vid/accessToken，不是 Bearer 或 wr_skey。源文件 SHA256、固定 commit、编译器版本及编译产物哈希存入私有 cache manifest；源文件与 LICENSE 的期望哈希在准备脚本中锁定。MIT LICENSE 随缓存保留。

研究入口与原账号页分开。它沿用同 VID 的旧设备 ID，不发送旧 accessToken/refreshToken，不修改生产账号、Web 会话文件和来源配置；正常 SDK 登录是否让服务端已有 Web 凭据失效仍未知，不能保证。SDK 交换体 isAutoLogout=0 是源码事实，不是 Web 会话永久有效的证明。

只在本人点击本机页面按钮后，顺序执行一次 wxticket、一次 SDK qrconnect、正常有界确认轮询及一次 login 授权码交换。所有请求 HTTPS、禁止跳转；最多 40 次正常轮询，SDK轮询截止5分钟，普通请求超时20秒、长轮询单次超时45秒。回包大小限制：依据固定 weread-omni 源码 src/api/response-body.js 的 MAX_JSON_RESPONSE_BYTES 确定上限，二维码阶段（qr）允许最大 16 MiB（16777216 字节）的有界回包，其余阶段（ticket、poll、exchange）维持 64 KiB 紧限额。40次不等于总时长80秒；临近截止发起的在途轮询仍受单次超时限制。非 HTTP200、业务拒绝、验证码/限频立即停；过期、拒绝和取消不自动生成新二维码、续期或重放，不请求目录/原文/正文接口。本人扫码及手机官方授权不能由 Agent 代做。

本机 HTTP 只绑定 127.0.0.1 随机端口；状态 API 仅返回阶段和 QR 是否就绪，不返回 UUID、wx_code 或 token。二维码使用已有 qrcode.react/React 本地生成，无外部图片服务。Host/Origin、一次性启动 nonce 及 CSP 限制其他网页触发。该 nonce 不是产品 AuthCode，不要求本人填写。原4000的本机 no-auth 设置保留。

新凭据仅在返回 VID/设备匹配、生产逐字段快照不变后独占写入私有 mobile-session.json；这是不可覆盖写入，不声称文件集合为原子事务。账号错配不保存，失败不回滚本人操作、不删旧证据。脚本日志不输出凭据/原始错误，attempt/result/listener 与 SDK 缓存都不进 Git。

## 可复现准备与测试

运行目录必须先创建为新的空目录（safePrivateRoot 使用 realpath 核验现有目录）；不能覆盖旧运行。2026-10-02 总控首次遗漏建目录，启动 setup_stopped、上游0请求；创建新空目录后成功 idle。此为启动用法错误，不是微信认证拒绝。

需本项目已安装依赖、Node24（SQLite 只读核对）、既有 TypeScript 5.9.3、qrcode.react 3.2.0 与 React18。SDK 原源码可从上述固定提交获取；仅准备脚本列出的六个 TS 文件及 MIT LICENSE 参与编译，无 npm 安装或包生命周期脚本。

```powershell
node scripts/research/prepare-owner-sdk-cache.cjs <ABS_FIXED_SDK_SOURCE_ROOT> <ABS_PRIVATE_CACHE>
# 此处输出为准备成功/失败，不会发腾讯请求。
node --test scripts/research/owner-sdk-login-once.spec.cjs
# 设置 OWNER_SDK_CACHE 为准备好的私有缓存后，再验原 SDK 原语的纯 Mock 流程与取消。
node scripts/research/owner-sdk-login-once.cjs --plan
New-Item -ItemType Directory -Path <ABS_EMPTY_PRIVATE_RUN_DIR> -ErrorAction Stop
node scripts/research/owner-sdk-login-once.cjs --serve <ABS_PRIVATE_CACHE> <ABS_EMPTY_PRIVATE_RUN_DIR> <ABS_SOURCE_CONFIG> <ABS_OLD_RECOVERY_JSON> <ABS_PRODUCTION_DB>
```

服务启动仅提供 idle 页面，上游请求为 0；本机本人明确点击才开始扫码。空闲服务最多 15 分钟，结束后页面短暂保留结果；过期需重新审核新尝试，不能自动重启。CLI 不接收 token 参数，不要求本人发送 Cookie 或 token。

已验证：带私有缓存的登录/resolver联合离线测试19项全部通过。渲染修复后的登录套件无cache为12项通过、3项原SDK Mock明确跳过，另有4项resolver回归。包括实际QR渲染器命名空间、原 SDK 源码编译原语的纯 Mock 正常路径、取消零请求、QR 阶段 >64KiB 接受与 >16MiB 停止、其余阶段保持 64KiB 限额；模拟账号错配、拒绝、过期、DB变化、重复/越界请求和挑战页。CI 在无私有 cache 时跳过需真实缓存项，不下载 SDK、不接触腾讯。准备/测试期间生产快照与全部表哈希完全不变。

## 真实验证进展与正文探针（2026-10-02）

### 1. 真实 Resolver 首次实测成功

`owner-06` 正常 SDK 授权与单项解析探针已真实执行并确认成功：

- 私有执行目录：`private-data/list-discovery-20261002/sdk-login-owner-06/resolver/`
- 解析状态记录：`result.json` 显示 `success: true, stage: "parsed", status: 200, requests: 1, productionUnchanged: true`。
- 解析成果记录：`resolution.json` 针对自主发现候选 `WX_3895431412_2247493594_1`，成功解析出具备合规 `MP_WXS_3895431412_` 前缀的真实 `reviewId`（完整 ID 值按保护规则保留于私有目录，不写入文档与代码），`originalVerified: false`。
- 全局防重放门禁：全局私有标记 `private-data/list-discovery-20261002/resolver-attempt.json` 已永久落盘并持久保留。**严禁重跑 resolver 或重新登录；全局标记不可删除、不可覆盖**。生产数据库与各表字段哈希完全未变。

### 2. Axios 对齐的正文单次探针实现（AXIOS-ALIGNED BODY One-Shot Probe）

基于代码级差异比对与传输层事实纠偏，在 `scripts/research/probe-owner-body-once.cjs` 与 `scripts/research/probe-owner-body-once.spec.cjs` 中完成 Axios 对齐与脱敏头采集改造：

- **传输层真实对齐**：完全对齐 `owner-weread-latest.ts` 的 Axios GET 传输实现，显式配置 `proxy: false`、`maxRedirects: 0`、`timeout: 20000`、`maxContentLength: 8 * 1024 * 1024`、`responseType: 'text'`、`transformResponse: [(v) => v]` 及 `validateStatus: () => true`。彻底纠正此前使用 Node fetch (undici) 的传输差异。
- **脱敏响应头与大小记录**：回包后即时在私有 `response-metadata.json` 中保存响应状态、字节大小及脱敏诊断头（`content-type`, `content-length`, `content-encoding`, `transfer-encoding`, `connection`, `date`, `server`），严格过滤 `set-cookie` 与鉴权字段，解决此前 0 字节无法追溯线路上游头的问题。
- **全新独立防重放标记**：采用全新的独立预检标记 `body-axios-attempt.json`（存在即拒，wx 独占落盘并 fsync），**严禁清空或修改既有 `body-attempt.json`**，历史证据完整保留。
- **隔离输出目录**：隔离写入私有 `body-axios/` 目录（包含私存 `response-body.html`、`response-metadata.json` 与 `result.json`），完全不触碰、不覆盖原 `body/` 目录。
- **严格边界控制不变**：无 cover 请求（不触碰 401 风险端点）、无第三方中转、无微信原文直连、无图片抓取、生产 SQLite 零写入、不删除旧停止文件、强制环境门禁（阻断代理变量）。
- **离线测试保障**：`probe-owner-body-once.spec.cjs` 包含 6 项针对性离线回归测试（前置门禁、单次请求与 Axios 参数/脱敏头校验、HTTP 401/500/验证码容错、身份/时间/标题冲突终止、超限与生产变动拦截、127.0.0.1 纯本地 Axios chunked/gzip 3 MiB 回包读取），测试结果以本轮复核为准。
- **执行纪律**：`node scripts/research/probe-owner-body-once.cjs --plan` 确认 `requests: 0`、`productionWrites: 0`、`transport: "axios"`、`exclusiveMarker: "body-axios-attempt.json"`。**零联网，未获总控明确批准前严禁 `--execute`**。

### 3. 公开来源审计：新鲜 SDK 认证下的公众号全量列表可能与 skey / accessToken 辨析

基于新鲜 SDK 凭据与公开源码对公众号完整文章列表来源进行只读审计：

1. **凭据体系严格辨析（skey vs accessToken）**：
   - **移动 Eink SDK 凭据域 (`i.weread.qq.com`)**：`owner-06` 授权产出 `mobile.accessToken` 与 `mobile.vid`。请求头使用 `profile.authHeaders: { vid, accessToken }`。在 `owner-06` 运行中仅发起并成功完成了一次 `/mp/getreviewid` 解析（HTTP 200，1 次请求），SDK 会话本身不包含亦不产生独立的 `skey`（历史 `/shelf/sync` 成功属于此前旧移动会话实测记录，不混淆归入本次 `owner-06`）。
   - **Web 端凭据域 (`weread.qq.com`)**：Web 正常登录产出 Cookie `wr_skey` 与 `wr_vid`。它仅适用于 Web 端接口（如搜索代理 `/web/wx_search_broker_proxy` 与正文 `/web/mp/content`），不能作为移动接口的身份头。
   - **历史第三方 / WeBook skey**：2021 年公开的 WeBook 爬虫对 `GET i.weread.qq.com/book/articles` 发送自定义 `skey` 与 `vid` 请求头。本项目此前实测表明，移动 `/login` 响应中返回的 `skey` 与 `accessToken` 字符串完全相同，但携带其请求 `/book/articles` 时返回 HTTP 401 (`-2012`, `stop_http`)。因此，不能假设存在能解锁旧接口的独立“神秘 skey”，更不能混淆两套认证体系。

2. **公开列表端点核查与排查依据**：
   - **`/book/articles`**：Eink 2.1.2 源码中归入 `ArticleService`，但在固定 `weread-omni` SDK 中标记为未使用，且无成功示例。此前实测仅证明在当时所测凭据、请求参数形状与测试时点下返回 HTTP 401（-2012，`stop_http`）；不能推断为全局或永久关闭，但在缺少新结构证据时不盲目重复。
   - **`/mp/chapters`**：Eink 2.1.2 公众号章节端点，携带移动 `accessToken` 历史实测返回 HTTP 499 / `-2041`。在没有新底层依据前不盲目重试。
   - **`/web/mp/articles`**：Web 阅读器端点，历史在官方页面及 Node 端均返回 `-2041`，暂未恢复。
   - **`/web/wx_search_broker_proxy`**：目前唯一保持真实可用的发现来源（已自主返回 71 条候选），但受限于搜索索引截断与非单调时间戳，尚未达成公众号全量发现。

3. **有依据的下一阶段推进建议**：
   - **第一步（正文链路单篇闭环）**：本轮已执行一次，但 HTTP 200 空响应未取得 `contentHtml` 或真实 `publishTime`；只离线分析现有私有回包和旧成功链路，不重放该请求。
   - **第二步（全量/近期文章发现）**：主目标始终是公众号完整近期文章发现，而非单纯解析器；在达成公众号完整近期列表来源前，不搭建批量生产管道。在不猜参、不重复旧失败的前提下，优先研究：
     - Web 搜索端点参数与关键词拓宽（探索是否可稳定发现漏网近期文章）。
     - 移动端书架同步机制 (`/shelf/sync`，使用新鲜 `accessToken`) 在当前账号下是否能通过订阅关系获取账号最新章节列表。

### 二维码图片渲染根因与独立 SVG 命名空间修复

修复后总控独立验证：带固定SDK私有缓存的登录/resolver联合回归19项全通过；纯本机Mock HTTP图片使用同一个renderQrSvg、image/svg+xml和img-src self，CUA核实际自然宽高260×260并查看截图确认完整二维码。没有腾讯请求/真实凭据/手机授权，此测试页检查完关闭，不作为本人扫码页。CI无cache时3项原SDK Mock仍明确跳过。owner-05旧进程的结果为poll阶段停止、ticket/qr各1和poll17（全部wx_errcode408），无exchange/mobile/resolver，生产保护通过；新代码须启动新目录/进程后才能用于本人授权。

2026-10-02 真实 owner-05 运行中，虽然 `/status` 报告 `hasQr: true` 且 `/qr.svg` 返回 HTTP 200 `image/svg+xml`，但页面实际显示为破损图片占位图（浏览器中 `img.complete = true` 但 `naturalWidth = 0, naturalHeight = 0`）。先前仅校验 DOM 节点存在性或 `/status` 的 `hasQr` 字段，无法证明图片已被浏览器 XML 解析器正确识别并渲染。

**根因诊断**：前端 `qrcode.react` v3.2.0 的 `QRCodeSVG` 在 `renderToStaticMarkup` 下默认生成内联 `<svg>` 片段，根标签 `<svg>` 未声明 XML 命名空间属性 `xmlns="http://www.w3.org/2000/svg"`。当该 SVG 作为独立静态资源通过 `<img src="/qr.svg">` 以外部图像形式加载时，浏览器 XML 图像解析器因缺失命名空间而无法识别其为合法 SVG 矢量图，导致图像解析失败与尺寸为 0。

**精准最小修复**：

1. `QRCodeSVG` 源码将未消耗的 props 直接透传展开到根 `<svg>` 元素上。
2. 在 `scripts/research/owner-sdk-login-once.cjs` 中抽取并导出通用渲染辅助函数 `renderQrSvg(value, size = 260)`，在创建 `QRCodeSVG` 元素时显式传入 `xmlns: 'http://www.w3.org/2000/svg'`。
3. 研究服务运行中的 `onQr` 回调完全复用该经过测试的 `renderQrSvg` 函数生成 `qrSvg`，确保实际运行与测试使用同一渲染实现，且不改变 QR 载荷格式与认证流程语义；该服务不替换生产账号登录。
4. 在 `scripts/research/owner-sdk-login-once.spec.cjs` 中补充离线回归测试，基于项目既有安装的 React 与 `qrcode.react` 3.2.0，严格检验生成的 SVG 根节点具备合规的 `xmlns="http://www.w3.org/2000/svg"` 命名空间声明、指定宽高、viewBox 与路径，并验证不同载荷矩阵独立性与命名空间完整性。全部离线运行，不接触任何外部网络与生产服务。

本人澄清没有收到手机内容、需要扫码时应明确告诉。SDK无主动手机任务推送：电脑生成二维码→手机微信扫一扫→手机确认。已澄清说明并由Gemini任务agy-ea6e51b8准备新空owner-05，不覆盖已停止owner-04或自动生成。只读审核agy-d310958d已完成：qrcode对象有qrcodebase64（长度62,388）及qrcodelength，原SDK忽略图片字段而构造confirmUrl，包装器遵循其URL生成SVG；未解码图片，不能断言两码不同或等待截止的具体原因。未安装/联网/改代码，先完成本人正常扫码。

owner-04最终结果覆盖下文waiting：04:36:21Z开始、04:41:21Z停止stage=poll，productionUnchanged=true。ticket/qr各1次200（95/69,035字节），正常poll17次200/32字节，wx_errcode全部408；没有404已扫码、405已确认、授权码交换或新mobile，resolver0。原SDK5分钟截止保持；实际手机过程仍未知，不将等待截止当二维码错误或本人未操作的证明。总控已请求本人简述扫码到哪步，由Antigravity/Gemini的只读离线审核agy-d310958d核原SDK confirmUrl/CLI与真实qrcode字段；不输出任何QR值、不联网/安装/修改/重开。二维码大小修复已有真实验证，认证仍未完成，下文waiting属当时观察。

修复f5815b1已push且CI36964883974全成功。新 owner-04 由Antigravity任务agy-0d8d4f06实际准备，初始idle/零请求；总控打开后发生正常生成。真实qr回包69,035字节（超过旧64KiB），JSON对象errcode=0、非空uuid，字段名errcode/uuid/appname/qrcode；原SDK requestQr通过，本机页面确认有二维码并进入waiting/正常poll。本次有完整私有证据，才可说该回包有效；不能据此推断旧owner-03被截断响应或owner-02同因。尚待本人手机确认，没有新mobile或resolver请求；最终结果/计数以owner-04/result.json为准，后继先核文件和进程、不自动重开。短期入口PID15932/127.0.0.1:2504，原10678已过期。所有UUID/qrcode/签名/授权码/token值保持私有，不进Git或对话。

2026-10-02 本人准备并点击 owner-02 入口后，实际 ticket/qr 各一次HTTP200，但未显示二维码；无 poll/exchange、新mobile或resolver请求。旧 result.stage=ticket 为 requestQr 两步共用粗阶段，不能视为确切失败端点；当时未留原回包，无法判定业务码、字段格式或URL门禁原因，不重复请求补证。生产不变。

owner-03 真实结果与实际失败：入口随后发生一次生成流程，sdk-login-owner-03/result.json 停在 stage=qr；ticket HTTP200 接收 97 字节，qr HTTP200 结果为 body_too_large（受此前统一 65536 字节限额切断），productionUnchanged 为 true。实际触发者尚未独立核实；没有生成二维码或进入本人扫码/轮询。由于流式读取在超过 64 KiB 时即触发 response_size_gate 取消 reader，未保存 qr 原始回包，因此上游回包的具体格式、内容及有效性未知，不能将观测到的超限视为上游回包合法有效的证据，也不能倒推 owner-02 同因。

针对性限额修正：核对固定 weread-omni 源码（src/api/response-body.js MAX*JSON_RESPONSE_BYTES = 16 * 1024 \_ 1024）后，将 scripts/research/owner-sdk-login-once.cjs 中二维码（qr）阶段调整为 16 MiB 确定上限，完整保留其他所有阶段（ticket、poll、exchange）的 64 KiB 紧预算，保留长短轮询超时截止、禁止跳转、禁止重试、生产写保护以及仅限本机的私有证据落盘。

已补私有取证：完整且不超过限额（qr 16 MiB、其他 64 KiB）的响应先独占保存 response-阶段-次数.bin（包括非200/非JSON/业务拒绝），再解释。流读取或过大响应可能无法完整保存；不为留证突破限额。原始内容可含签名、UUID、授权码或新token，全部只能留Git忽略的本机私有目录，不通过HTTP暴露，不写日志。脱敏audit记录固定outcome、字节数和整数errCode/errcode；stage在requestQr失败时采用最后真实请求类别。不能把accepted_by_guard视作SDK requestQr通过。证据落盘失败也停止，不续期、不重发。本次诊断修改没有解除旧限制或提供新认证依据；没有自动重开owner-04。

单次传输已准备为 `scripts/research/probe-owner-review-once.cjs`；`--plan` 零请求，只有 `--execute <ABS_SUCCESSFUL_SDK_RUN_DIR>` 才执行。正常扫码结果须成功、生产未变、同账号/VID/旧设备且30分钟内；加载哈希核验的原 SDK profile，不导入 mobile transport/TokenManager。自主选本轮五页搜索第一项，不传验收种子。发送原始 requestUrl，不将规范化存储 URL 替代请求 URL。全局私有 resolver-attempt.json 在请求前独占写入并 fsync，任何进程重复执行都被阻止，不删除；单次 HTTPS POST、20秒超时、64KiB流读取、不跳转、不续期、不重放。原始响应先私存，再作严格身份解析；解析失败也不重发。所有生产表和原配置/Web会话/旧停止/SDK新会话/发现证据哈希再次核对。后续本地I/O异常只输出请求数未知，不虚报零请求。4项纯 Mock测试通过，涵盖真实请求形状、原URL、先落标记/重复拒绝、认证/挑战/格式/身份失败、过大回包及生产变动。

先等本人完成不同于原 Web 登录的正常 SDK 扫码并核私有结果；新会话不能删除旧401/-2041/302停止。仅对本轮真实搜索自行选出的一个候选，用固定 SDK mobile 头单次请求 /mp/getreviewid，私存回包，核 URL 对应/基数/reviewId 号前缀，再决定是否请求既有 Web 正文端点并核真实文章身份/时间。没有合法新 mobile 会话时，不发 resolver 请求。严格 URL 回显等假设以实际响应为准，离线解析器成功不是线上成功。

完整近期覆盖仍独立缺证；搜索本地排序、关键词补搜、旧目录或 SDK 登录都不能抵消该缺口。后续批量/增量与生产接入须经真实列表、正文及副本保护验证。
