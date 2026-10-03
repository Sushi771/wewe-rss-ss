# 自建订阅当前断点（2026-10-03）

**当前模型与执行基线（本人明确确认）：**

- 本人确认 Antigravity 实际模型服务已恢复，当前固定使用 `Gemini 3.8 Flash (High)`（实际模型标识 `MODEL_PLACEHOLDER_M318`），不再重复检查模型可用性或地域支持前提，按规定直接执行。

**当前主线与实测断点（北京时间 2026-10-03 18:05）：**

- **官方列表调用链与防重放门禁：**依据 APK 2.1.2 `classes10.dex` 中 `MpService.syncChapters` -> `MpRemoteService.syncChapters(bookId, count=50)` 源码构建首屏参数化只读探针 `scripts/research/probe-mp-chapters-once.cjs`，9 项纯离线测试与强制基线核验通过。
- **线上单次验证执行：**经总控审查核准，在已核 `mps=1/fris=1` 的 `owner-09-reader-scope` 会话下，严格执行**恰好一次**线上验证（1 request）：`--chapters --approved-online --count 5`，请求 `https://i.weread.qq.com/mp/chapters?bookId=MP_WXS_3895431412&count=5`。
- **实测回包与分类：**上游返回 **HTTP 499**（53 字节），响应体解析为业务码 `errcode: -2041`。当次执行不可变记录的私有摘要（`summary.json`）真实保留初始 `upstream_stop: HTTP_499`（未被修改）；随后离线更新探针分类器代码，使后续离线判定统一对齐识别为 `limit_stop: ERRCODE_-2041`。
- **门禁处置与证据隔离：**命中 `-2041` 立即停止该端点路径，不重发失败请求、不盲猜参数。单次防重放标记 `mp-chapters-owner09-attempt.json` 已写入；脱敏摘要与原包仅存私有忽略目录 `sdk-login-owner-09-reader-scope/mp-chapters/`，不写入 Git。
- **当前状态：**获取 0 篇文章，0 次正文请求，0 生产 SQLite 写入；`publicationVerified: false`，`subscriptionRecovered: false`。即便满足客户端 reader scope 且 `mps=1`，上游服务端对 `/mp/chapters` 仍阻断并返回 `-2041`。
- **历史记录纠偏：**此前 9 月历史实验记录了 `/mp/chapters` 的 `-2041`；owner-07 探针记录的是 `storyfeed/getCardArticles` 空回包（0 篇），此前将 owner-07 误写为已测 chapters 属笔误，已纠正。本轮 owner-09 则是首次在该 `mps=1` 条件下对 `/mp/chapters` 发起严格单次验证。

**官方墨水屏客户端对 -2041 的验证处理机制（源码审计）：**

1. **拦截入口：**官方 2.1.2 APK `classes10.dex` 中，`ReadHttpErrorHandler.handle` 捕获到错误码 `-2041` 时调用 `handleNeedVerify`，继而调用 `LoginService.INSTANCE.verifyAccount()`。
2. **弹窗与验证码 SDK：**`classes12.dex` 中 `LoginService.verifyAccount()` 调用腾讯验证码 SDK，在安卓当前 Activity 弹出 `new TCaptchaDialog(context, appId="2044038556", listener, null)` 弹窗让用户在客户端交互完成腾讯滑动验证码。
3. **验证凭据回传：**用户在弹窗验证成功（`ret=0`）后，回调 `onVerifyCallback(JSONObject)` 提取 `ticket` 与 `randstr`，并存入 `LoginService.setCaptchaTicket` 与 `LoginService.setCaptchaRandStr`。
4. **请求头注入：**`classes13.dex` 中 `VerifyAccountInterceptor.intercept` 在后续请求中检测到两者存在时，自动在 OkHttp 请求头中注入 `wr_ticket: <ticket>` 与 `wr_randstr: <randstr>`，然后重放被阻断的请求。
5. **关键限制与断点：**服务端返回的 HTTP 499 响应体仅有 53 字节，**不包含任何挑战 URL、二维码、验证网页链接或验证提示指令**。在无交互式 Android/WebView 上下文的独立脚本/命令行环境下，无法直接从回包中获取或生成验证凭据。

**官方 -2041 人工验证适配器实现与离线/预检验证（北京时间 2026-10-03 18:55）：**

- **验证适配器实现：**根据腾讯验证码 Web SDK 官方文档（2026-09-15 规范端点 `https://turing.captcha.qcloud.com/TCaptcha.js`）与官方 APK 原生 AppID `2044038556`，构建最小化仅本地环回人工验证服务 `scripts/research/serve-owner-manual-verify.cjs`。
- **全链路严密门禁与强绑定：**
  1. 严格绑定 `owner-09-reader-scope` 会话、目标号 `MP_WXS_3895431412`、已停列表请求标记（`mp-chapters-owner09-attempt.json`）及其实际回包 SHA-256（核验其 SHA-256 与不可变记录完全一致，解析确保业务码 `errcode: -2041`）。
  2. 复用 `discovery-eink-storyfeed.cjs` 的共享安全路径检查 `assertSafePath` 与凭据校验 `validateCredentials`（强验证 `loginResult.productionUnchanged: true`）。
  3. 一次性持久化账本与防重放机制：服务启动时以 `flag: 'wx'`, `mode: 0o600` 写入启动账本 `manual-verify-start.json`，若已存在账本或产物则拒绝启动；回调处理后写入产物 `manual-verification-artifact.json`（`0o600`，`wx`），一旦写入后续回调全部返回 409 `LEDGER_ALREADY_CONSUMED`。
  4. 绝不伪造成功、严防降级/灾备票据穿透：腾讯 SDK 在配置错误/域名不匹配时可能返回 `ret: 0` 附带 `trerror_` 灾备票据与非零 `errorCode`（如 1006）。适配器在浏览器端与服务端双重严格校验：凡带有 `trerror_` 前缀或 `errorCode !== 0`，一律视作失败/拒绝，绝不生成或持久化有效票据产物，仅落盘拒绝元数据（`consumed: true`），严禁静默旁路；严格限制 payload 为非空非数组对象，非法或非整数类型的 `errorCode`/`ret` 严格返回 400 且绝不默认转为 0。
  5. 安全传输与防注入：严格校验 Origin 与 Host 必须等于本地环回基地址；限制 Content-Type 为 application/json；限制请求体不超过 16KB；严禁 ticket/randstr 中包含 `\r\n` 或控制字符；`/status` 接口绝不暴露 nonce。
  6. 极简 UI：仅展示验证目标、状态与“开始安全验证”按钮，不包含实现细节；点击前外部网络 0 请求；成功后明确提示“验证凭据已保存，公众号文章列表仍待验证（未验证文章列表或恢复订阅）”。
  7. 兼容性定位：原生 AppID 在 Web 浏览器环回环境下的兼容性明确标记为 `UNVERIFIED`，直至运行时 SDK 真实反馈；拒绝或出错时立即停止，绝不自动重试或绕过。
- **测试与真实预检通过：**
  - 14 项纯离线单元测试（包含 null/array payload 阻断、非法 errorCode/ret 类型阻断、`trerror_1006` 灾备票据拒绝回归、解析 -2041 回包校验、CSP/Origin/Host 阻断、一次性账本防重放、POST /diagnostics 脱敏路由与 clientScript VM 编译隔离，以及官方 frame JS 实证的 script-src/worker-src CSP 修正与 SDK 终止清理）全部通过。
  - 真实零网络预检 `--preflight` 验证通过：`status: preflight_ok`，正确绑定 attemptMarkerSha256、sessionBinding、chaptersRawSha256 与 `chaptersErrCode: -2041`，0 上游网络请求，0 生产写入。
  - 本地人工验证服务曾于 127.0.0.1:4355（attempt-01）与 127.0.0.1:4356（attempt-02）启动；attempt-02 私有 diagnostics 真实记录 CSP 拦截证据（`script-src-elem` 拦截 `https://turing.captcha.gtimg.com/1/tcaptcha-frame.ba387dd1.js`，`worker-src` 拦截 `isWebWorkerSupport` 的 `Blob` worker 实例化），SDK 返回 `errorCode: 1006`（`get_captcha_config_request_error`）后服务门禁安全拒绝，未发后续列表请求。

**后置受保护单次重放消费适配器实现与离线/预检验证（北京时间 2026-10-03 19:05）：**

- **闭环门禁准备：**设置本地保守 5 分钟年龄门禁，在向用户请求人工操作前准备好且审查完毕后置消费探针，严防出现人工验证成功后因等待开发调试导致有效票据超时失效。
- **复用既有安全组件：**构建轻量受控消费适配器 `scripts/research/probe-mp-chapters-verified-once.cjs`，强制核验完整 `startLedger` 与非空 `nonceHash`，复用 `probe-mp-chapters-once.cjs` 的 `runChaptersProbe`/`buildHeaders`/`profile` 及共享辅助函数。
- **严密产物鉴权与防旁路门禁：**
  1. 产物必须为真凭据：强校验 `success: true, ret: 0, errorCode: 0`，票据不包含 `trerror_` 前缀，无 CRLF/控制字符注入；强匹配 AppID `2044038556`、`owner-09-reader-scope`、目标号 `MP_WXS_3895431412` 与会话绑定；强匹配启动账本 `startLedger` 的 AppID/target/session/binding/时间与非空 `nonceHash`。
  2. 强校验原始阻断标记与 -2041 回包 SHA：产物内记录的 `attemptMarkerSha256` 与 `chaptersRawSha256` 必须与本地留存的真实阻断请求标记和 HTTP 499 响应体完全一致。
  3. 保守短生命周期校验：本地强制门禁要求产物生成时间在 5 分钟以内（`now - verifiedAt <= 300,000ms`），超时自动阻断为 `ARTIFACT_EXPIRED`。
  4. 一次性消费账本：执行前以 `wx` 模式原子写入消费账本 `manual-verification-consumed.json`；若已消费则彻底阻断后续任何请求（`CONSUME_LEDGER_ALREADY_EXISTS`）。
  5. 证据与脱敏：摘要、消费账本与尝试标记绝不记录明文 ticket 或 randstr，且已删除 randstr 前缀（仅保存 SHA-256）；原始阻断标记与回包原样保留不被修改。
  6. 源码头精准注入：严格包装固定 profile `authHeaders` 并通过原 `buildHeaders` 组合，仅且仅注入官方源码实证的 `wr_ticket` 与 `wr_randstr` 请求头，保留既有认证头与版本头。
  7. 限制至多 1 次 `count=5` 请求：无 offset/synckey，上限 2 MiB，禁止重定向，无重试，零生产 SQLite 写入。
  8. 显式核准门禁：必须附带 `--approved-online`。未提供或产物缺失时，执行端立即安全停在本地门禁（0 请求、0 写入）。
- **测试与真实预检通过：**
  - 9 项定向单元测试全数通过（涵盖 CLI 参数、Token 校验、产物来源核验、过期与灾备票据拒绝、头注入完整性、预检状态转换、Mock 真实请求、一次性防重放及 producer→consumer 端到端 Mock 回调与重放）。
  - 真实零网络预检 `--preflight` 验证通过：在人工未执行前正确报告 `artifactPending: true, requests: 0, verifiedChaptersReady: false`；无假产物生成，未污染真实目录。
  - 三套研究测试集共 32 项测试全部通过（base 9 项 + manual 14 项 + consumer 9 项）。

**当前验证状态与入口就绪：**

- 保持当前已验证的 `mps=1` 登录会话，严禁盲发网络重放或编造验证 URL。
- attempt-01 与 attempt-02 历史文件与防重放标记均完整保留；已根据官方文档与 frame JS 源码完成最小 CSP 修正（补齐 `script-src https://turing.captcha.gtimg.com` 与 `worker-src blob:;`）及客户端 `terminateSdk()` 实例与 iframe 销毁机制（附 `callbackConsumed` 防重复执行），离线验证回调后调用SDK销毁与iframe清理，真实SDK终止效果待本次人工验证，1006全部原因仍待验证；当前保持 0 篇文章、0 次正文请求、0 生产 SQLite 写入。新入口 attempt-03（4357）已就绪启动。
- 产物成功保存后，可在其本地保守 5 分钟门禁窗口内使用 `probe-mp-chapters-verified-once.cjs` 执行受控请求。

**本次正常扫码已完成（历史记录）：**本人在新的 owner-09-reader-scope 入口确认授权；会话与旧 owner-07 同账号同设备、token 已更换、capturedAt 更新，attempt/session 均记录官方阅读器范围 `snsapi_userinfo,snsapi_friend,snsapi_favorites`。授权器报告生产不变。按既有受控探针只请求一次 `/wx/scope`，HTTP 200（75 字节），真实 `mps=1/fris=1`。公众号授权缺口已解决，无需再次扫码；这还不是自动更新恢复。

**列表入口纠偏：**owner-09 单次 tags HTTP 200（489 字节）、单次旧 feed HTTP 200（56 字节），仍为 0 篇。离线复核实际标签：101 为“朋友的想法”/`weread://timeline`，102 为“今日更新”/`weread://browse`，带嵌套 `weread.qq.com/misc/tl-landing` URL；103 为“朋友赞过”/`weread://kkFriendOp`，没有嵌套 URL。旧 APK 固定取 103 后缺省成 `id=0/type=0/channel=901301` 的探针不能证明当前公众号订阅列表为空。此前派发内“所有标签均无嵌套 URL”的表述撤回。未请求 102 嵌套入口，不依据标签名称猜参数，不重复旧空 feed。

**恢复执行后的具体任务：**Antigravity 先按固定官方源码确认当前指定公众号列表（含 `/mp/chapters` 的真实请求及此前停止条件）或正确订阅入口，再判断新 `mps=1` 条件是否支持一次目标号首屏验证；只核前 5 篇真实不同文章及一篇代表正文。现有授权、原包和防重放标记全部复用，不清停止，不重复扫码，不写生产库，不扩大全库检验。正文外部原文分支的旧验证停止仍保留。新文持续发现与完整正文均未验收，以下 owner-07 授权缺口及 owner-08 等待状态为历史记录。

**订阅列表的新依据与实测：**官方 EInk 2.1.2 的 `StoryFeedService.syncSubscribedMP` 先 `GET /storyfeed/tags?type=1`，从 `items` 取 `id=103`，按官方 schema 的嵌套 `url` 提取 `id/type/channel`，再 `GET /storyfeed/getCardArticles`，首屏 `count=20`、不带游标。标签缺失时客户端不请求 feed。owner-07 正常会话下标签单次 HTTP 200（489 字节），真实 tag 103 存在，参数为 `id=0/type=0/channel=901301`；按回包参数单次 feed HTTP 200（56 字节），`articles=[]`、数字 `hasMore=0`。初次摘要因只接受 boolean 标为 `shape_stop`，随后仅离线修正数字 0/1 映射，未重发；实际仍是空列表。原包、两个全局防重放标记均保留。下一项是核官方双授权条件 `isWeChatMpGranted() && getMpBookGranted()` 的实际状态，不能把空列表当持续订阅恢复。

**代表文章详情：**按官方 `MpRemoteService.getReviewMpInfo` 的精确形状，仅带 `reviewId` 请求 `/review/single` 一次，owner-07 返回 HTTP 200（2715 字节）。稳定身份与原 resolver/候选及原文选取一致：`WX_3895431412_2247493594_1`，`type=16`，`bookId` 空、`belongBookId` 为目标号，真实 `mpInfo.inner=0`。APK BooleanCodec 将 0 转 false，该篇是外部原文分支；不尝试只适用于 `inner=true` 的 `/book/chapterread`。`mpInfo.content` 仅 33 字节，不是完整正文；其原文 URL 与旧 HTTP 302 验证停止条件一致，未重发原文。正常 native 认证头明确是 `vid/accessToken`，未发现 `skey` 映射到 Web Cookie 的依据。新增探针均无 SQLite 调用或生产写入；当前生产仍保留旧 1450 篇，持续自动更新未恢复。

**当前实际授权缺口：**按官方 `forceSyncWeChatAuth(true) → FollowService.getWechatAuthStatus(1)` 的精确形状，只用当前 owner-07 VID 发一次 `GET /wx/scope?vid=<本人VID>&refresh=1`，HTTP 200（58 字节）：`mps=0/fris=1`，即公众号授权未开启、好友授权已开启。正常登录回包没有这些 flag；不能把扫码登录成功当公众号授权完整。随后按官方 `AccountService.syncConfig()` 一次 `GET /config?synckey=0`，HTTP 200（955 字节）：`accountsets.mpBookGranted=true/showWxSubscribeBook=1`，第二门槛与入口显示配置已开启。未调用 `updateConfigs`、无生产写入；scope/config/feed 的全局标记均保留。当前已证缺口是 `mps=0`，还不能保证授权改变后列表一定有目标号文章。

**正常授权的新条件已准备：**`SubscribedMPListFragment` 真实继承的授权按钮打开官方 `QRAuthDialogFragment`，请求 `snsapi_userinfo,snsapi_friend,snsapi_favorites`；固定开源 SDK 原来请求 `snsapi_userinfo,snsapi_timeline,snsapi_friend`。精确核了官方同 AppID、`nonceStr=weread`、服务端 ticket 的 signature/timeStamp，以及 POST `/login`、`isAutoLogout=0` 和登录 anti-replay 摘要内容；并非另一条 `/wx/auth` 分支。既有授权器新增显式 `--serve-native-reader`，只把 QR 里的权限范围改成该官方范围，固定 SDK cache/签名/设备/交换流程保持，私有 session 记录本次 requestedScope。16 项离线测试含 hash-pinned 真 SDK 全 Mock 传输均通过。owner-08-reader-scope 本机入口 `http://127.0.0.1:4354` 已 idle、上游 0 请求，等待本人点击生成并查看腾讯授权提示；15 分钟无人操作关闭。不自动扫码或重开；正常授权完成后先验证同号同设备、新 token/较新 capturedAt 与该权限来源，只读一次新的 scope，只有实际 `mps=1` 才继续标签/feed 首屏。不能把 favorites 授权或扫码成功直接宣称公众号授权/订阅已恢复。

以下是此前 Web 票据与固定参数流的过程记录，以上方实际断点为准。

**本轮收敛（2026-10-03）：**第一方阅读器在 `-2041` 时由本人完成腾讯验证码，将回调 `ticket`、`randstr` 用于当次请求重试；KOReader 验证脚本的“有新 ticket 则成功”是预期分支，未附成功实测输出。本次本人第三次正常扫码走公开 Skill 脚本同序、同内存 Cookie 会话：`userInfo`、`apikeyGet`、续期均通过，续期仍无 `x-wr-ticket`，以 `FRESH_TICKET_MISSING` 停止；没有请求文章列表/正文或写生产库。持续订阅未恢复。

**下一执行入口：**官方墨水屏 2.1.2 APK 的 `classes10.dex` 明确 `MpService.syncMpList(update)` 调用 `syncArticles()`，继而 `MpRemoteService.getArticles` 发 `GET /storyfeed/getCardArticles?channel=901301&type=0&count=50`；首屏不带 `kkOffset/kkSearchId`，后续由回包提供这两个游标。`MpCardArticles` 包含 `articles/hasMore/kkOffset/kkSearchId`，文章项有 `bookId/reviewId/createTime`。`createTime` 暂不作为已核发布时间；是否覆盖目标号、是否能持续更新尚待真实回包。`/mp/list?listType=0` 实际为收藏列表，`listType=1` 为浮窗列表；此前仅凭 enum ordinal 将 0 当更新流的推断撤回，未据此发请求。`/mp/chapters` 是此前目标号已测 `-2041` 的路径，不重试。Antigravity 负责最小只读首屏探针，Codex 审查后仅一次请求，筛目标号前 5 篇，无生产写入。

**首屏实测：**Antigravity 通过 MCP 返回并修正 `scripts/research/discovery-eink-storyfeed.cjs`，4 项定向离线测试及真实配置零网络预检通过。复用固定 SDK 的 `vid/accessToken` 与 EInk versionHeaders（未静态证实该官方 Ktor 客户端的完整认证 interceptor）作一次新端点实验，HTTP 401、60 字节，私有 JSON 明确 `errCode=-2012`（登录过期），没有文章。随后本人手动完成 owner-07 正常 SDK 授权：账号/设备与 owner-06 相同、token 不同、capturedAt 更新，授权器报告生产不变。总控以这些条件、旧认证停止结果及旧标记为门禁，复用同一 Antigravity 探针并指定固定 owner-07 私有路径，仅一次 GET 返回 HTTP 200、56 字节，`articles=[]/hasMore=false`，总文章 0/目标号 0；不能算订阅恢复。`storyfeed-attempt.json`、`storyfeed-owner07-attempt.json` 及两处原包/摘要均保留，不清除或重发。探针无 SQLite 访问或生产写入。下一步仅离线核该流的关注/收藏条件与目标号覆盖依据。只通过 MCP 指导 Antigravity，不操作本人电脑界面；当前 Codex 窗口继续承接。

本人本轮已完成两次正常 direct Web 二维码确认，均为目标 owner VID。首次 `/web/login/renewal` 返回成功但未给 `x-wr-ticket`，旧一次性脚本依其票据门禁停在 `RENEWAL_TICKET_MISSING`，未发列表请求。固定公开客户端将 ticket 写成可选请求头，故以独立标记与新扫码做第二次低频实验：续期后无 ticket 仍带更新 Cookie 只请求一次 `GET /web/mp/articles?bookId=MP_WXS_3895431412&maxIdx=0&count=5`，真实返回 `errCode=-2041`、无 reviews，状态 `LIST_VERIFICATION_REQUIRED`，0 篇、0 正文、0 生产写入。维护版公开验证脚本恰好预期无 ticket 的列表返回 `-2041`；因此当前核心缺口是**如何在本人正常登录后取得有效票据**，不能靠改 `offset` 或无票据重发。两次私有运行目录和全局标记均保留；不清标记、不重放同一路径。此结果仅限本账号、本目标号和此时的 Web 流程，持续订阅仍未恢复。

公开登录脚本先访问 `/r/weread-skills`，用同一 Cookie 会话完成扫码、`userInfo`、`apikeyGet` 和续期；本项目此前的独立 Axios 请求丢掉各阶段 Set-Cookie。按固定源码同序的隔离入口 `scripts/research/probe-owner-skills-session-five.cjs` 已完成本次实测：Cookie 名称从登录后的四种变为续期后的 `wr_pf/wr_ql/wr_rt/wr_skey/wr_vid`，但响应没有 ticket；私有一次性标记和脱敏停止结果保留，不重跑同一条件。此前离线 6/6 与零网络预检通过。

目标号已补录两篇真实漏文，生产现为 1 账号、12 订阅、1450 文章，RSS 可读第二篇正文及 39 张内嵌图片；这仍是单篇补录，不是持续更新。按本人最新要求，接下来只取首屏前几篇核对订阅链路，不再重复整包和全库演练。固定公开源码的移动 `/review/single` 返回详情及原文地址，不能把 `review.content` 当完整正文；现有 owner-06 授权下已严格单次请求该端点，HTTP 401，私有防重放标记已保留，生产数据不变，不重发。另一条来源明确的条件是正常 direct Web 登录保存 `wr_rt`，随后显式 `/web/login/renewal` 取得 `x-wr-ticket`/`x-wrpa-0` 再读 `/web/mp/articles`；本轮只完成代码和离线门禁，新条件尚无目标账号成功回包。旧 mobile→Web renewal 曾返回 -2013 且无票据，不与新路径混称。

独立本机入口 `scripts/research/probe-owner-native-web-five.cjs` 已准备：本人正常扫码后，显式一次续期并只取目标号首屏 5 条；无新 ticket、认证拒绝或验证即停，原包仅存忽略目录，正文另需审过列表后显式单次请求。`--preflight` 实际加载依赖、渲染 QR 和试绑 loopback，零腾讯请求、未建运行目录或标记；定向离线测试 4/4。真实扫码、票据、列表和正文均尚未执行。

本轮只聚焦自建中转：公开固定源码确认列表的 `bookId/maxIdx/count` 与正文的 `reviewId` 请求已对齐，未增加猜测参数；直接 Web 登录轮询改为源码所用的裸 `&otp` 与 70 秒长轮询，定向离线测试 5/5。此字节及时序修正尚无本人账号线上结果，下一步仍是本人正常扫码后的一次首屏 5 条与一篇代表正文；不做全库逐文件检验。

# 离线浏览器辅助订阅更新切片（2026-10-02）

**优先级变更与执行切片：**用户明确调整最高优先级，要求“先让订阅更新跑通，证据后续再核验”，且明确本次更新优先于首轮证明 5 篇。本项目先在零腾讯请求、零 CDP/浏览器启动、零生产库写入且不清除旧停止的前提下，实现最小离线浏览器辅助更新切片；随后完成单篇图片归档与受控生产补录：

1. **证据与适配隔离：**独立创建 `browser-dom-adapter.ts`，定义专门的证据类型 `BrowserDomEvidence`（`source: 'owner-confirmed-browser-dom'`），严禁混淆为后台 HTTP 或复用 `official-public-original`。输入仅复用私有 `private-data/single-account-update-20260930/official-browser-dom.html` 及其哈希（`cdd899b8...`）与 `official-original-selection.json` 中的自主搜索候选 `WX_3895431412_2247493594_1`。
2. **严格门禁与发布时间保真：**通过现有 `articleIdentity`、`articlePublishTime` 和 `articleContentHtml` 提取文章元数据与正文。发布时间严格提取自 DOM 内 `ct`（1790749883），严禁从搜索候选索引时间（1790749882）编造；清洗后的正文 HTML 达到 13,084 字符。
3. **安全持久化与幂等验证：**在 `CollectionService` 中扩展离线演练接口 `replayBrowserDomUpdate`，通过现有 `saveVerifiedSearchPage` 保护逻辑，仅在带标记且隔离的 SQLite COPY 副本演练。隔离 CLI `scripts/research/replay-browser-dom-update.cjs` 首轮成功写入 1 篇目标文章（`created: 1, updated: 0`），次轮重复演练严格幂等（`created: 0, updated: 0`）；演练前后 `feeds`、`accounts` 及旧 1448 篇 `articles` 全字段哈希完全一致；生产数据库哈希字节级无变更；全局网络守卫拦截 0 次异常外联。
4. **测试与边界限制：**`browser-dom-adapter.spec.ts` 42 项回归通过，包含清洗后丢失图片来源时拒绝宣称图片完整的回归。本切片明确不宣称公众号连续/完整订阅恢复；正文原有 39 次远程图片引用，图片已单独私存并在 SQLite 副本及生产单篇内嵌。

# 公众号级列表发现主线（2026-10-02）

**第一篇历史补录、候选扫描独立接通：**已核原文缓存文章 `WX_3895431412_2247493551_1` 经一致性备份、SQLite 副本演练（首跑新增 1、重启新增 0、旧行逐列不变、RSS/Markdown/Obsidian/ZIP 与已缓存图片验证通过）后显式写入生产。当时生产为 1 账号、12 订阅、1449 文章，目标号 196 篇；该新行真实原文 `ct=1790649961`、正文可用且无图片，旧订阅/文章全字段不变，`quick_check=ok`，未推进该号同步成功时间或启用新来源。私有前后备份和演练报告均不进 Git。此为真实历史漏文补录，不等于持续订阅恢复。

受保护的 `feed.searchCandidates` 和独立 `feed.scanCandidates` 已实现，原订阅页新增待核候选折叠区与扫描按钮；搜索索引时间不冒充发表时间，候选不写文章/RSS。45 项定向测试与前后端构建通过，源码尚待受控部署。用本人既有正常 Web 会话作 **一次** 至多两页扫描时，首请求返回 `auth_expired`；搜索停止记录已持久化，生产库不变，原 71 条/5 页历史候选快照及其独立展示副本字节保持一致。不得自动续期、清停止或重发；后续新实时候选需要本人按正常流程重新登录并核验状态。

Antigravity/Gemini 3.8 Flash (High) 的浏览器 DOM 独立适配先在 SQLite 副本把 `WX_3895431412_2247493594_1` 新增 1 次、重跑新增 0，真实页面 `ct=1790749883`、正文约 13 KiB。正文原有 39 次远程图片引用（36 个唯一 URL）。一次性图片归档器已完成代码与离线校验：固定 DOM 哈希及身份、顺序低频、首个失败即停、私有缓存、只输出脱敏摘要；标准 17 项离线测试通过，真实 39/36 只读验收通过。随后仅运行一次受控归档，36 个不同图片资源均通过格式及哈希校验，私有 manifest 和一次性标记已持久化。单篇图片完整和公众号列表完整分别标记；此前 backend 原文 HTTP302 停止记录仍有效。

图片清单加载器已按原始正文的 39 处引用和 36 个资源逐项核清单、字节 SHA、格式与内嵌结果；真实 SQLite 副本首轮新增 1 篇、次轮 0 变更，全部旧行、源库逻辑内容及同步时间不变，网络请求 0。单篇生产导入 CLI 通过合成回归和 GitHub CI 后，于 19:19 使用指定近期演练、全部业务表核对和一致性备份正式补录目标文章：`created=1, updated=0`，生产现为 1 账号、12 订阅、1450 文章，目标号 197 篇；旧 1449 行逐项不变，账号、订阅、迁移表摘要不变，`quick_check=ok`、外键 0，未推进同步成功时间。该篇正文约 10.4 MB，包含 39 个内嵌图片、0 个远程 qpic 引用；本机完整正文 RSS 返回该篇和 39 张图片。此切片只补录一篇，无法证明持续发现新文。

以下较早阶段的“最新”仅记录当时断点，以本页顶部的生产状态为准。

**首项搜索候选与旧原文停止记录已排重：**五页搜索的首项 `WX_3895431412_2247493594_1` 与 2026-09-30 `single-account-update` 私有账本是同一篇，原始 URL 的 `__biz/mid/idx/sn/chksm` 全相同；旧选取仅将 `http` 升为 `https`。当时本人正常官方浏览器页面观察核实了该篇身份和页面发表时间，但独立后台对相同文章签名 URL 的唯一 GET 返回 HTTP 302、验证跳转，并已持久标记停止后续原文请求。这些证据不能算后台取文成功，也不能拿浏览器已见的单篇替代五篇与全号新文验收。本轮取消重复的原文探针准备，未发该 URL、未清停止；后续只接受实质不同且可核的来源证据。

**最新真实断点：**Antigravity/Gemini 3.8 Flash (High) 准备的 Axios 对齐独占正文探针已在代码审核、10 项离线回归及 GitHub CI 成功后运行，**恰好一次** `GET /web/mp/content` 返回 HTTP 200、`Content-Length: 0`、保存正文 0 字节；私有 `sdk-login-owner-06/body-axios/result.json` 为 `success=false, stage=parsing, requests=1, productionUnchanged=true`。新 `body-axios-attempt.json` 和旧 `body-attempt.json`、resolver 标记均存在且保留；无正文、可信发布时间或新文章，不得再次运行任一探针。生产 SQLite `quick_check=ok`，1 账号/12 订阅/1448 文章逐表全字段哈希仍与基线一致。相同空回包出现在 Axios 与 fetch 两种传输下，不能再将其简单归因于 fetch 读流；具体服务端原因未知。`/mp/list` 目前只是固定 APK 接口清单中的未使用 SDK 路由，尚无调用参数或回包证据，不据此猜参实测。下一步仅离线核移动 resolver 与 Web 正文 `reviewId` 的适配依据，同时继续找可验证的全号近期列表路径。

**最新实测覆盖下文待执行状态：**Antigravity 在匹配 IDE 会话 `d4249827-e5ab-405e-8c05-f7de1beff13d`（生成仅 M318、无模型错误）实现 BODY-ONLY 单次探针；总控审核后，解析器与正文探针联合 9 项离线测试通过，真实配置只读门禁和生产基线核对通过。第一次 CLI 因本地环境门禁停止，尚无 `body-attempt.json`、无联网。清理进程环境中的代理变量后，**恰好一次** `GET /web/mp/content` 返回 HTTP 200，但响应体 **0 字节**；私有 `sdk-login-owner-06/body/result.json` 为 `success=false, stage=parsing, requests=1, productionUnchanged=true`，没有 `article.json`、可信发布时间或正文。完整原始回包（空文件）与元数据已私存；全局 `body-attempt.json` 已存在，不能删除或重发。旧 resolver 标记、旧停止及生产 1 账号/12 订阅/1448 文章全字段均保留。MCP 作业 `agy-873d74ca` 登记 FAILED（会话结束），实际 IDE 轨迹已 IDLE；以实际私有结果为准。此结果既不是认证成功取文，也不证明端点永久无内容。继续仅离线比对旧成功正文传输/公开源码，并寻找可核实的公众号完整近期列表来源；五篇真实身份/发布时间、连续多篇、分页增量及订阅验收仍缺。

**当前真实断点：SDK 与单项 URL 解析均已成功。**本人完成 owner-06 正常 SDK 授权后，Antigravity 在恢复的 e1e3e027-0037-41f1-9cdb-8573c8431a0a 会话中执行既有单次 resolver。总控核私有 `sdk-login-owner-06/resolver/result.json`：success=true、stage=parsed、HTTP200、requests=1、productionUnchanged=true；自主搜索候选 `WX_3895431412_2247493594_1` 的原始 URL 已通过返回 URL、稳定身份和 `MP_WXS_3895431412_` reviewId 前缀校验。不是 cover、种子或 Mock；originalVerified=false，正文与可信发布时间仍未验证。全局 resolver-attempt.json 已存在，永久保留，不能重跑。MCP 作业 agy-d162d4ea 仍登记 FAILED；真实恢复轨迹及私有结果证明已执行，不能伪报该登记变为 completed。以下“结果待核”“尚无 mobile”均为历史状态。

下一实际任务 `agy-873d74ca` 已派给 Antigravity/Gemini 3.8 Flash (High)：先实现并离线测试最小正文单次研究探针，复用既有正文传输、Web Cookie 和身份/时间解析，读取上述实际 resolution；总控审核后才允许执行正文请求。不得运行 cover、重做登录/resolver、清旧停止、抓图片或写生产。同时只读核完整公众号列表的新源码依据，严格区分 skey 与 accessToken；完整近期覆盖、连续多篇、分页增量、五篇真实发布时间及 12 订阅实测仍缺证。主体仍为列表发现，不因单项解析宣布闭源中转已替代。

**解析子任务实际执行状态：**agy-d162d4ea首次SendUserCascadeMessage返回HTTP400，匹配IDE会话e1e3e027-0037-41f1-9cdb-8573c8431a0a当时IDLE/0步/无生成模型/无模型错误，marker不存在，不能称探针已执行或地区错误复发。总控用同一已创建会话的短英文任务恢复，提交已接受，实际轨迹RUNNING、生成仅M318、无错误；MCP作业登记仍FAILED不会随恢复更新，后续以该匹配实际轨迹及私有marker/result核对，不能伪报check_agent_job完成。任务约束仍单次、无重试/续期/其他端点/生产写入。首次400具体原因未知，不修改MCP包或自动换模型。

**最新认证成功，开始真实解析：**显示修复源码`3d84ea5a989f5a010c4c8a6b546a3cfebd3dd433`已push且[CI36967953673](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36967953673)全成功。Antigravity任务agy-3850c939准备新owner-06（127.0.0.1:5290/PID50872），本人已明确回复SDK登录完成。私有result success=true、productionUnchanged=true；实际ticket/qr各1、poll2、exchange1，全部HTTP200（97/70,302/32与64/574字节），新mobile capturedAt=2026-10-02T05:16:40.546Z、source=owner-confirmed-eink-sdk-login，账号/VID/旧设备匹配门禁通过。总控再次独立比对所有生产字段，完全等于Web登录后基线（1账号/12订阅/1448文章）；新凭据与原始证据不进Git或对话。总控没有在真实新QR清空前测其自然尺寸，不能补称已做该测量；真实授权成功与先前纯Mock浏览器260×260核验分别成立。

正常mobile条件现已具备，全局resolver marker在派发前不存在。已让Antigravity/Gemini High执行真实单项任务agy-d162d4ea：现有`probe-owner-review-once.cjs --execute <ABS_OWNER06_RUN_DIR>`仅一次，无重试/续期/其他端点/生产写入，自动选择本轮71候选中的首项原始requestUrl，不传验收种子。真实结果及响应身份/结构仍待核；任务受理不是resolver成功。下一步审核真实回包，必要时只离线适配已有回包，确认reviewId后沿既有正文链路核身份/发布时间，再继续完整近期覆盖/分页增量，而非重新开发登录。

**SVG修复已实际通过：**Antigravity任务agy-985194a2已完成代码，抽取`renderQrSvg`并显式xmlns，真实研究服务onQr复用同一函数，授权URL/门禁不变。总控已审核diff，带固定SDK缓存登录/resolver联合19项回归全通过（CI无cache时3项SDK Mock跳过）。使用该实际函数的纯本机Mock HTTP页、相同SVG MIME及img-src self限制，通过CUA核浏览器img complete=true、naturalWidth/Height=260×260，并亲自检查截图中的完整黑白二维码；没有发腾讯请求。该阶段验证了独立SVG渲染，未宣称真实手机扫码授权完成。本人旧9346/owner-05仍运行旧代码，该次最终poll停止：ticket/qr各1、poll17，全408，无exchange/mobile/resolver，生产全部字段仍等于Web登录后基线。下一步先提交push修复，再由Agent启动新空owner-06，明确交本人生成/扫一扫；实际授权后的页面和尺寸再核，不能使用旧进程验证新源码。

**二维码显示核验纠错（当前最高执行点）：**本人提供owner-05截图，img是破图占位；总控之前依据hasQr=true和DOM图片节点称“二维码显示成功”，检查不完整，该表述撤回。真实QR接口69,035字节/errcode0和SDK requestQr通过仍成立，但不能代表浏览器渲染。实际浏览器img complete=true、naturalWidth/naturalHeight均0；本机/qr.svg返回200、image/svg+xml、3,971字节、根svg缺少SVG xmlns。现有qrcode.react3.2内联SVG渲染器转独立图片时未补XML命名空间，这是当前明确渲染故障。尚不能把手机没有提示归因于本人；owner-04的显示成功同样未经图像尺寸验证，不作为渲染验收。

Antigravity/Gemini High实际修复任务agy-985194a2已派发并收到上述证据，要求最小命名空间修复、真实渲染器离线回归、只更新OWNER_SDK_RESOLVER_VALIDATION，总控审核及纯本机Mock图片浏览器naturalWidth>0/可见二维码确认后同步文档/Git。不改变QR授权URL语义、不请求腾讯或重启生产；修好前不再要求本人扫码。owner-05最终poll/是否停止以私有result核对，不覆盖目录、不自动重放；SDK mobile与resolver仍缺。先解决可见二维码，再继续公众号完整近期发现主线。

**本人操作说明与当前派发：**本人反馈“手机没有接收到任何东西，需要扫码可以告诉我”。正常SDK不会向手机自动推送任务，需要电脑入口点击生成，再用同一微信“扫一扫”扫描电脑二维码并在手机确认。总控此前“手机端反馈”的表述不够直接，已澄清；不把owner-04等待截止归因于二维码协议错误。本人现已准备，Antigravity/Gemini High新入口任务agy-ea6e51b8正在准备新的空owner-05目录；不覆盖owner-04，不自动点击或请求腾讯。入口是否ready须核listener、HTML及idle零请求，打开后直接明确本人扫码步骤，避免等待研究/文档使本人误以为手机会自动收到内容。

只读审核agy-d310958d已完成：真实qrcode是对象，含qrcodebase64（长度62,388）和qrcodelength；原SDK requestQr仅取uuid并返回正常源码构造的confirmUrl，包装器按该confirmUrl生成SVG。未执行原生二维码离线解码，内容等价性未证明，也没有确定扫码失败原因；不称“无解码库”或“原二维码错误”。总控核系统Python cv2/pyzbar缺失，PIL/numpy可用，此核对不代表所有环境都无解码能力。未安装或请求网络，未修改SDK/二维码语义。当前优先本人实际正常扫码，再推进主线。最新文档阶段cd9a370已push且[CI 36966055078](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36966055078)全成功，源码阶段f5815b1不变。

**最新终态覆盖下文waiting：**owner-04于2026-10-02 04:36:21Z开始，04:41:21Z写入失败result，stage=poll、productionUnchanged=true。实际ticket/qr各1次HTTP200（95/69,035字节），正常poll17次HTTP200，每项仅32字节且业务状态均wx_errcode=408；未出现404已扫码/405已确认，没有exchange、新mobile或resolver。与原SDK5分钟截止一致；不能断言本人未扫码或二维码内容错误，手机端过程尚待本人反馈。二维码生成/真实大小门禁修复已验证，正常移动认证仍未完成；入口已停止，不自动重启或覆盖owner-04。原始证据、完整计数留私有目录，旧生产全字段保护通过。

总控已问本人实际手机扫码到哪一步，同时派Antigravity/Gemini High只读离线审核agy-d310958d，对照原SDK/CLI正常confirmUrl用法与真实qrcode字段，不输出二维码内容、UUID或URL值，不请求腾讯、不安装库、不改代码。收到本人过程及具体源码证据后再定新正常验证；没有mobile之前不发resolver、不清旧停止。下文waiting为结果写入前的观察，已过期，不代表现在仍能扫码。

**最新真实扫码断点：**修复提交 `f5815b16e3398f472e4c57a2cecde022fa920ef6` 已成功push，远端main与本地精确一致，[CI 36964883974](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36964883974) 全成功。Antigravity/Gemini High 的 agy-0d8d4f06 已完成新 owner-04 入口准备，PID15932、127.0.0.1:2504；总控核HTML200、idle/hasQr=false、attempt未创建后打开本人页面。随后实际生成回包：ticket95字节、qr69,035字节；私有qr响应为JSON对象，errcode=0、非空uuid，字段名errcode/uuid/appname/qrcode。原SDK requestQr已通过，页面实际有二维码、state=waiting并开始正常有界poll；无须公开任何字段值。此证据只说明本次正常QR数据超过旧64KiB且修复有效，不能证明owner-03同一响应内容或owner-02原因。当前未保存新mobile，待本人手机确认；resolver仍0请求。最终成功/停止与完整请求计数须读本机私有owner-04/result.json，不能把waiting当登录成功。

入口是短期研究服务而非生产登录替换，空闲15分钟/轮询5分钟及结束后短暂关闭规则保持。旧10678页已经过期，不继续使用；新入口是否仍活跃须查owner-04/listener.json及进程，不复用已停止目录、不自动生成新码。正常授权成功且账号/设备/生产保护通过后，下一任务由Antigravity实际执行已审的单次 `probe-owner-review-once.cjs --execute <ABS_OWNER04_RUN_DIR>`，仅现有自主发现候选的原始URL，不猜参数、不续期、不重放；总控审核真实响应并同步GitHub，再推进正文/真实时间与完整近期覆盖。

**本轮代码审核与验证：**Antigravity 已实际修改 `owner-sdk-login-once.cjs`，只将 qr 阶段改为固定 SDK 的16MiB上限，其他阶段仍65,536字节；新增大回包通过/越界停止、ticket/poll/exchange旧上限保持、私有证据及原SDK纯Mock回归。总控读取实际diff并独立运行登录/resolver联合测试，18项全通过、无跳过（带私有哈希核验SDK缓存）；无缓存CI会明确跳过3项原SDK Mock。所有生产字段仍与本人Web登录后的基线一致。本次没有新腾讯请求或生产接入；真实二维码内容和扫码成功仍待本人正常验证。以下运行段记录修复任务的过程，不能覆盖本段代码已落地的事实。文档同阶段提交推送，精确新SHA与CI以Git/GitHub核对。

**当前执行入口（覆盖下文历史状态）：**实际开发仓库始终是 `C:\Users\ss\.gemini\antigravity\playground\sparse-comet\wewe-rss-ss`，GitHub 为 Sushi771/wewe-rss-ss；当前 Codex 对话最初用于 MCP 连接检查，仍处在项目外临时目录，不能把对话目录误认作代码目录。本人已授权上下文不足时在已登记的 wewe-rss-ss 项目创建后继主任务；先同步文档、commit/push及远端核对，再交接最新断点和活动 Agent，由旧窗口停止写入，避免双主执行者。

Gemini 3.8 Flash (High) 最小实测已恢复且真实生成仅 M318。首个恢复任务 agy-8f8900f5 在发现本机后端时失败（No available backend，具体原因未知）；重新核连接后 agy-785653ad 实际完成既有 owner-03 入口准备，轨迹仅 M318。随后 owner-03 发生一次生成流程，ticket HTTP200/97字节通过门禁，qr HTTP200 但超过包装器 65,536 字节上限，停止阶段准确为 qr；无完整 qr 原回包，内容/业务格式未知，不能断言正常二维码数据或推定 owner-02 同因。没有 poll/exchange、新 mobile 或 resolver；累计 owner-02/03 各 ticket、qr 一次。所有生产字段仍等于本人 Web 登录后基线（1账号/12订阅/1448文章）。

本人明确要求 Antigravity 修复并继续重建。实际修复任务 agy-92d4c82c 使用 M318，范围仅二维码阶段的源码有据上限与离线回归，不启动认证或请求腾讯。固定 weread-omni 88bd2e0 的 `src/auth/qrlogin.js` 使用 `src/api/response-body.js` 的 16 MiB 有界 JSON 上限；包装器当前统一64KiB造成已观测的提前中断。总控已纠正任务内错误缓存路径及过度历史读取，要求立即落代码或报告具体阻塞；任务运行不等于修复完成。其他阶段保持64KiB、超时/禁止跳转/不自动重试、私有取证及生产保护不变。审核通过后同阶段测试、更新文档、commit/push，再由 Agent 准备新空运行目录让本人扫码，不重用已停止 owner-03。正常SDK只是 resolver 的前置条件，完整近期发现/可信时间/持续增量仍未验收。

最近已推送文档阶段 `be5ae4a318e794448613dc5bacfc2a4b40cd09f6`，[CI 36962444894](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36962444894) 全成功；最新精确提交以 `git log -1` 及 GitHub main 为准。

**最新恢复条件：**本人切换地区后要求实测Gemini3.8High。MCP作业agy-d32960f2在12.84秒完成并返回GEMINI_READY；读取匹配本次输入的实际IDE轨迹，生成模型仅MODEL_PLACEHOLDER_M318、无错误、状态IDLE，确认并非其他模型代答。此前地区错误是旧请求观测，不再代表当前最小调用仍失败；这次成功不证明所有研究工具/长任务或微信SDK认证可用。已据原主线要求恢复指定 `Gemini 3.8 Flash (High)` 派发agy-8f8900f5，由Antigravity实际准备既有正常SDK本人入口（owner-03），不重写包装器，不点生成、不请求腾讯、不写生产。入口及后续实际状态需check_agent_job核实，尚不能称扫码完成。下文Opus额度等待为恢复前历史阶段。

**最新执行状态（覆盖下文pending）：**988c4a23055afbd51654f3710ee004f85c056f21已推送，[CI 36960099588](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36960099588)全成功。Opus授权后，首个MCP任务agy-b8cce8ba仍首次提交HTTP400；总控在同一IDE会话恢复请求，实际模型元数据全为M26/Opus，完成SDK/四文档/失败记录读取。短英文无上下文MCP诊断agy-b168e665成功11.1秒返回READY；新实际入口任务agy-d16c4dc0也进入RUNNING，说明并非连接永久失效。旧首次HTTP400的具体原因仍未证明，不能直接称为启动竞态或大上下文故障。

随后两条实际任务均遇 `RESOURCE_EXHAUSTED (429): Individual quota reached`；2026-10-02约11:33 +08提示4小时30分后恢复（约16:04，只是当次上游提示）。Agent在整理报告/准备入口前停止，没有完整最终诊断、代码修改或owner-03入口；不能将读取源码和READY当SDK/订阅成果。总控已CancelCascadeInvocation并确认两会话CASCADE_RUN_STATUS_IDLE，不让引擎继续自动重试。SDK新mobile与全局resolver marker仍不存在，实际新腾讯请求0；原owner-02累计ticket/qr各1仍为本轮全部SDK请求。当前已问本人是否授权Sonnet4.6或等Opus恢复，未收到授权前仍用本人指定Opus，不自动换模型或创建等待轮询任务。下一会话须先确认此选择，再派短任务由Agent实际推进SDK手工验证及完整近期主线。

**最新模型授权覆盖旧规则：**本人明确“我刚设置了opus4.6先用，antigravity可以直接使用这个模型”。当前任务改用 `Claude Opus 4.6 (Thinking)`，不再受下文历史固定Gemini约束，也不自动切回；总控已派发agy-b8cce8ba，让Antigravity实际核SDK二维码生成/准备正常本人扫码，随后沿weread-omni推进列表/解析/正文主线。任务是否执行、权限等待及结果以check_agent_job和真实轨迹核对，pending不称成果。总控保留审核、验证、文档与commit/push责任。

当前指挥约束再次确认：用户要求 Antigravity 承担实际开发/研究和正常 SDK 扫码验证，总控负责派发、审核、数据保护、必要测试、文档及GitHub同步，不继续以本地包装器开发替代子Agent工作。最新代码 `f1a0c35e948126357fe88b31111d00b9eb41e3c9` 已推送、[CI 36958435082](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36958435082) 全部成功、工作树干净。SDK仍未生成可用二维码，resolver0请求，完整近期发现未完成。

Antigravity实际执行阻塞已进一步核实：新主线任务agy-43122752（指定Gemini 3.8 Flash High，四份入口上下文）也在SendUserCascadeMessage HTTP400失败；读取旧失败会话轨迹发现指定MODEL_PLACEHOLDER_M318返回 `FAILED_PRECONDITION (code 400): User location is not supported for the API use.`。该会话的恢复请求可被接受，但后续实际生成元数据为MODEL_PLACEHOLDER_M26/claude-opus-4-6-thinking，不符合用户固定模型要求；总控已CancelCascadeInvocation并确认CASCADE_RUN_STATUS_IDLE，没有将其结果作为指定模型成果。不能推断MCP连接断开、认证token问题、永久限制或确定是自动回退；具体模型切换机制尚未确认。已向本人说明并请求选择恢复指定模型在IDE正常使用，或明确授权其他可用模型；默认仍固定Gemini，不自动改变网络/账号/模型设置，不反复派发相同失败。没有活动开发子任务。

运行核对：历史PID27668已不存在，原4000无监听且账号页不可达，停止原因未查明，不归因于SDK请求。已用现有受控启动器完整核13,283个冻结文件、确认无桌面采集助手，SQLite一致性备份与schema核对后恢复同一 `2026-09-30T18-00-04-775Z-0919cff9984b`，新PID26284，仅127.0.0.1:4000。受控审计为本机忽略的controlled-restart-1790910770699-26864；恢复后所有生产字段仍与本人Web登录后的基线完全相同，账号1/订阅12/文章1448。新研究代码没有部署为生产订阅功能。本文档补记的最新精确提交用git log -1/GitHub核对。

最新接续起点为已推送 `429e9f3a28ec24cd0de482440f66d7b3008e58d3`，其 [CI 36914671344](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36914671344) 全部成功。本人明确回复可 SDK 扫码后，开新隔离 owner-02 入口；本人点击生成后实际 wxticket/qrconnect 各一次 HTTP200，但 requestQr 未完成，无二维码、无轮询、无 login 交换、无新 mobile、resolver 仍0请求。旧日志 stage=ticket 是覆盖两步的粗阶段，不能据此说只请求了 ticket；业务回包当时未保存，具体拒绝/格式/URL校验原因未知，不能补发来补证。本轮未自动生成第二码、续期或重试旧目录。

已修正诊断：每次受限回包先独占保存到本机私有 response-阶段-次数.bin，再解析；脱敏审计仅记录 HTTP/字节/固定校验阶段/整数业务码，不输出 UUID、授权码、token 或业务原文。requestQr 失败按最后真实请求区分 ticket/qr，保存失败也停止，页面隐藏无效二维码占位框。15项纯离线 SDK/单次resolver回归通过（含固定原SDK Mock），不是线上认证成功。生产所有表字段与扫码前/既有基线相同，账号1、订阅12、文章1448保持；原停止文件未改。SDK缓存和凭据保持私有。

本轮 Antigravity 两次固定 Gemini 3.8 Flash (High) 派发 agy-4e9aba4b / agy-64f38892 均在 SendUserCascadeMessage HTTP400失败，不是正在开发；list_available_models 仍成功，IDE连接及模型标签可见，但任务执行不可据此称正常。总控完成修正、测试与同步，不将失败任务输出当审核结果。下一步需要取得具体SDK业务响应或其他新的合法认证依据，再判断是否允许一次新的正常尝试；本轮仅补诊断，不解除已有停止、不因诊断增强自动重发相同请求。完整近期覆盖仍独立缺证。阶段最新精确SHA及CI用当前Git/GitHub核对。

公开来源审计已推送e968016，首次CI 36913798292在Format check失败，其他代码检查/测试因此未运行；不能称该次CI成功。已修正研究表格格式，本地完整 `pnpm fmt.check` 最终通过；首次本地检查另提示WEREAD研究文档，格式化后该文件无Git差异。此修复的实际内容差异只有文档排版与失败记录，不改采集代码或生产。修复提交及最新CI以GitHub/当前HEAD核对，其他外部阻塞保持。

最新审计：main=19b5eb0起点干净，远端一致，[该提交CI 36911718057](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36911718057)全部成功。再次只读核生产所有字段不变，SDK attempt/mobile-session/resolver marker仍不存在，SDK入口监听已关闭、原4000 PID27668正常。四个既有上游及一次近期GitHub查询的10个匹配仓库已有限复核；新exporter提交只改README，两个新getmsg实现没有新合法认证条件，其中当前公开RSS样本为空，不重试旧停止。详细固定版本、源码证据和Agent纠偏见 [COMPLETE_SOURCE_RESEARCH.md最新段](COMPLETE_SOURCE_RESEARCH.md)。

阻塞已连续存在于三个目标回合（首轮c08f59d、正常授权/探针19b5eb0阶段、此次只读审计）：尚无合法新mobile会话，亦无可验证目标完整近期来源。所需工程前置已提交，不再无依据扩大包装器；没有活动Antigravity任务或活着的SDK进程可以当作正在开发。本人回复实际可扫码后才开新隔离入口并验一次resolver；取得映射仍不等于列表完整。没有合法新条件时不重发腾讯请求、不清停止、不自动生成码。此阶段只同步新的公开研究结论，无生产/产品功能改变，目标未完成。

本轮已完成并同步的最新代码阶段：`be4b8c2e9f17ef9e8f3deb8dcb0ac24041b22331`（单次resolver探针），远端main与本地一致，[CI 36911098491](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36911098491) 全部成功；13项离线测试通过。生产账号1/订阅12/文章1448全字段哈希仍与本人Web扫码后基线一致。2026-10-02 03:03 +08核对：SDK手工入口已按15分钟空闲上限关闭，本人未点生成按钮，attempt/mobile-session均不存在，上游SDK登录与resolver请求均0；不是认证失败或二维码过期，不自动重开/生成码。下一步需本人回复可扫码，再用新的空私有目录开启同一正常SDK入口；正常授权后总控执行已提交的单次探针。没有其他子Agent在后台开发中，不能让本人误以为仍有任务正在跑。完整近期发现和批量正文仍未完成，禁止清旧停止或虚报恢复。此同步补记的最新HEAD用git log -1与GitHub核对，上一代码精确SHA如上。

最新执行点：正常SDK授权准备阶段 `fc718876317c1da5d922a81a5ee7ee07e7b24aef` 已提交推送，远端一致、[CI 36909655152](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36909655152) 成功。本机手工入口已打开、本人按钮前 idle/上游0请求，127.0.0.1独占监听；原4000 PID27668及全部生产表不变。本人正常 SDK 扫码尚未完成，resolver仍0请求。单次 resolver 探针和4项离线测试已准备，待新正常会话后总控执行；不重复旧目录/刷新，不解除旧停止，完整近期来源仍缺证。端口和存活状态以私有 listener.json/实际状态为准，不自动重启过期入口。后续精确HEAD仍以Git/远端核对。

当前接续：已准备复用固定 MIT SDK 的隔离正常扫码入口及私有缓存（不改原生产登录），9 项离线测试通过、上游请求0、生产全部字段不变。独立无工具审查 agy-d516f0dc 已完成并审核；独占文件写入不称为原子事务，长轮询有45秒单请求上限，不能将40次轮询说成总共80秒。原可运行 helper 未找到，故只复用公开 QR 原语，不安装 CLI/TokenManager。旧 mobile VID 与新 Web 来源一致，设备 ID 沿用；须本人正常 SDK 授权后才允许对新搜索候选作一次未实测 resolver 验证，不能混用 Web Cookie、重复旧目录或自动续期。新说明见 [OWNER_SDK_RESOLVER_VALIDATION.md](OWNER_SDK_RESOLVER_VALIDATION.md)。本阶段代码、CI及开发/产品文档一同提交推送，精确最新 commit 用 git log -1 与远端 main 核对。完整近期覆盖和正文链路批量验证均未完成。

上一代码阶段：`9c8c1ef52695164fdc93c290bd094619c30a6d02`，push 后远端 main 与本地一致，[CI 36903374288](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36903374288) 成功；服务端构建、28 套 291 项全量测试及 lint 通过，上一交接补记 c08f59d 已推送。本轮5e78d49e/262be155/d516f0dc均已完成并审核，固定 Gemini 3.8 Flash (High)。生产账号扫码后的全部表字段哈希保持一致。总目标仍在执行，未完成验收。

当前用户要求持续完成闭源中转替代，最高优先级为连续多篇发现、批量增量和分页；这覆盖下文恢复会话的“仅读取历史”范围。登录、正文、图片和保存链路保留。每个有效阶段须更新开发及产品文档、测试、commit、push 并核实 GitHub。

本轮入口、检查证据及子 Agent 审核见 [列表发现推进记录](ACCOUNT_DISCOVERY_PROGRESS_20261002.md)。起点为 `d6eb25f`（恢复会话成果已推送）；当前 HEAD 用 `git log -1 --oneline` 核对，不能要求文档包含自身提交的 SHA。

2026-10-02 只读生产 SQLite 核对：1 个账号、12 个订阅、1448 篇文章，quick_check=ok。新的关键阻塞：现有最新篇状态记录在 `2026-09-30T21:35:01.268Z` 的 cover 请求得到 HTTP 401 并持久停止；这发生在历史正文成功之后。当前不能把历史正常扫码或单篇成功当作仍有效的在线会话。原始状态和旧拒绝证据保留，不清停、不重试目录/正文。搜索状态没有会话停止项，但相同会话的认证拒绝应先处理，不能换端点验证登录。

Antigravity 调查、公开研究、分页建议及代码审核已收取并经总控审核（统一 `Gemini 3.8 Flash (High)`）。本轮已实现 1–5 页受控搜索、重复页终止、明确终止原因、跨页标题冲突和私有 `searchMaxPages` 配置；既有更新默认仍为 2 页。构建及 27 套 267 项回归通过，改动文件 ESLint 通过。搜索始终 `search-results / complete=false`，不能把工程分页能力当作全号完整列表或真实增量验收。阶段起点/已推送文档提交 `a82fbcb`；本阶段最新提交以 `git log -1 --oneline` 及 GitHub 为准。

用户明确要求本机去掉 AuthCode：仅本地忽略配置关闭站点门禁，4000 仅监听 127.0.0.1，对外保护代码不变。原冻结版本 `2026-09-30T18-00-04-775Z-0919cff9984b` 受控恢复/重启通过，当前 PID27668；原账号页已不再跳 AuthCode，并已打开正常扫码窗口。新分页源码尚未部署；本人已回复完成扫码，后台核对新正常会话时间为 2026-10-01T17:19:06.029Z；旧 1448 篇文章、12 个订阅全字段哈希一致，账号仍 1 个，数据库 quick_check=ok。原配置备份、启动/重启审计和数据库快照在 `private-data/list-discovery-20261002/`。下文 PID、运行时间均为历史记录。

当前真正阻塞仍为全号近期完整来源和搜索长链接到可用腾讯正文身份的可靠衔接。旧 cover 401、目录 -2041、原文 302 停止保留；正常重新扫码不等于解除所有旧路径。先核对新正常会话条件，再做最小真实只读搜索验证；不得以旧缓存、手工短链或固定合集补齐冒充自主发现。详情及未采纳的 Agent 建议见推进记录。

本阶段最新代码提交 `8d402e9` 已 push，并核远端完整 SHA 一致，[CI 36899306257](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36899306257) 成功。新扫码后的真实只读 5 页已返回 71 条目标号候选（11/15/15/15/15），自主包含两篇漏文回归样本；不是缓存重放或手工种子。末页仍可续页，预算截断；候选时间非单调且仅为索引时间，无可用 reviewId，仍不足以全号完整/正文入库验收。5 次后冷却，不立即重复搜索；数据库全字段及旧 cover 停止文件字节保持不变。下一轮 `agy-a95d76f7` 正核公开源码的账户限定/近期排序及正文身份映射，总控继续独占真实请求。

实测记录已推送为 `c892ce0`。`agy-a95d76f7` 后查明停在 IDE GitHub 读取权限等待，已取消 MCP 作业并改为总控提供公开源码的无工具 `agy-263ca2df`，43 秒完成并审核；没有自动批准未知工具。后续须核查运行中作业的真实等待状态，避免静默挂起。公开项目的续页字段与本项目不同，其 15 条上限不能套用；筛选元数据不证明可生效，当前不猜参。下一轮无工具核 CyrusNee/weread resolver 的移动认证及返回身份匹配：resolver 本身未实测，旧移动认证 401 未解除，Web 新扫码不能代替移动凭据。最新作业 ID 及审核状态见推进记录。

resolver 审核已完成：公开 mobile `/mp/getreviewid` 的认证和 synckey 首屏没有解除旧失败的新条件，不能混用 Web Cookie 或运行 SDK 自动续期/重放。当前新增纯离线响应身份门禁，无网络/生产绑定；最终服务端构建、28 套 291 项全量回归、新文件 ESLint 通过，无工具独立审查未提出具体缺陷。下一步先复核可复用的原正常移动登录入口；只有取得合法新移动认证及真实单项响应后才核对应正文，不为旧目录重复失败让本人再次扫码。完整近期覆盖仍同时阻塞，不能只修正文映射后宣布全部替代。

本阶段 parser 代码、测试和开发文档同一提交同步；精确最新 SHA 以 `git log -1 --oneline` 与 GitHub main 核对，文档不内嵌自身提交 SHA。上一已推送文档阶段 `05a0d04`，上一分页实装 `8d402e9`，实测记录 `c892ce0`。工作树应无重要遗漏；私有会话、证据、配置备份与本地 no-auth 设置按设计不进 Git，不能随源码泄露。

## 历史原入口修复（2026-10-01）

2026-10-02 已读取找回的开发会话并整理[恢复进度与 GitHub 同步核对](RECOVERED_DEVELOPMENT_PROGRESS_20261002.md)。本轮只记录和同步历史成果，未继续开发、部署或在线采集；下文数据与运行状态均为最后开发会话的实测记录。

账号管理已接回原4000；新正常扫码会话已取得真实腾讯读书正文。公众号级发现仍不足，不能标记全部修复完成。

- `/dash/accounts` 及导航恢复，私人站点登录保护保留；本人在恢复后的页面完成新正常扫码，账号及同 VID 搜索会话已私存。删除/重新添加账号操作前有一致性备份，不擅自回滚本人操作。
- 登录不再指向 Wechat2RSS。凭据只由后台保存，相关 API 不回传 token；备份在写入前执行，旧客户端对象保留；同一登录并发确认去重，同 VID 私有搜索绑定更新，旧会话/状态/原文停止保留。
- 当前4000运行冻结发布产物、数据库仍为 `apps/server/data/wewe-rss.db`。部署前没有4000监听；已受控恢复回环服务。最后运行版本和PID以 `.local-releases/active.json` 及 `private-data/account-fix-20261001/deployment-final-result.json` 为准，旧版本保留回滚。4120未启用、未改缓存试用逻辑。
- 生产库副本逐行保护核对：1447篇旧文章、账号及其他订阅不变，仅新增1篇。演练的Axios请求替换未生效，实际发出两次正常腾讯请求，私有证据已纠正为真实联网副本演练，不能称离线；正文图片使用测试图片，仅验证保存分支。生产结果以原页面及最终数据核对为准，原导出、目录和布局保留。
- 新正常认证差异有真实结果：已有本人正常Web会话 `/api/mp/cover` 单次 HTTP200 返回真实 `reviewId`。该会话与此前失败的 mobile→Web init 401 不是同一条件。仅再请求一次对应 `/web/mp/content`，HTTP200，诊断未识别 `js_content`；完整响应未留存，不能进一步断言具体认证/验证/格式原因，未为补证重发，路径已停。
- 新正常扫码形成不同认证条件：对应 `/web/mp/content` 一次HTTP200，text/plain内真实原文HTML核实目标号名、稳定ID `WX_3895431412_2247493556_1`、真实发布时间和正文。完整响应先私存；原公众号302及旧诊断停止保留。相同新会话 `/web/mp/articles?bookId=...&offset=0` 一次HTTP200、业务 `-2041` 后停止，不重试、不追加ticket、不轮换账号/IP。
- `owner-weread-latest` 仅读腾讯 `/api/mp/cover` 当前提供的一篇及对应 `/web/mp/content`，不调用受限目录或已停止的公众号原文路径。每次至多两次取文请求、15分钟冷却、跨进程锁、私存响应、持久停止，核实身份和时间后复用旧保存事务；手动和定时同一流程。页面明确说明仅为读书提供的一篇，不代表微信最新文章齐全；最终部署及写入以4000运行和私有数据保护结果为准。
- 验证：服务端27套240项通过，新手动/定时路由增加后相关18项通过；前端类型检查、冻结产物服务端/前端构建、改动服务端ESLint通过。测试模拟成功只证明代码，正文真实可用的依据为私存腾讯响应。源码同步与CI按最终提交核对。

最终实测：4000已受控运行 `2026-09-30T18-00-04-775Z-0919cff9984b`，PID33152；运行源码与提交一致。原按钮在02:18:50真实直连腾讯更新，新增《市重率不相上下，华育世外中考成绩大PK！》及正文、真实内联图片，原阅读弹窗已显示正文。目标号195篇/36正文；全库1448篇，1447篇旧文章及其他账号/订阅逐字段不变，SQLite integrity ok。代码提交 `698d675` 远端一致，CI成功；手动/定时共用流程，原定时设置保留。

详细来源和边界见 `SINGLE_ACCOUNT_SEARCH_RUNTIME.md`。尚未修好的是公众号级最新文章发现：搜索可能漏文，读书目录本账号本次仍受限，cover仅提供一篇。不能把单篇取文、旧缓存、构建或Mock称为完整恢复；不重复已停请求，不另做五篇/导出验收。
