# `/book/articles` 跨客户端认证来源复核（2026-09-30）

范围：只读审查公开源码、提交历史和本仓已脱敏的实验结论。本轮未读取本人私有凭据，未启动客户端、扫码、抓包，也未向腾讯发送请求。此文校正[先前 query 探针说明](BOOK_ARTICLES_QUERY_SHAPE_PROBE.md)中“syfun 的 skey 来自 Mac `/login`”可能被读成**实际运行已命中该分支**的表述：源码允许两条来源，仓库没有运行记录证明命中了哪条。

## 结论及已实测边界

总控已用本人合法 BOOX/EInk `/login` 顶层 `skey/vid`，按 `syfun` 的 `GET /book/articles` **query** 形状只读一次；结果 HTTP **401**、业务 **`-2012`**、无 `reviews`。该账号、该凭据样本、该形状和该时点已停止，不通过换参数、重放或继续续期来试错。这不能判定所有客户端凭据权限相同，亦不能据此否定其他独立取文路线；当前没有目标号真实新文章回包。

源码真正支持的是：`syfun` 的 `main.py` 把 `bookId/version=2/vid/skey/offset/count/synckey` 发给腾讯 [`i.weread.qq.com/book/articles`](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/main.py#L30-L61)；但其密钥取得逻辑需逐分支判读。2026-09-30 复核固定 `7319d997`：公开仓库只有 2026-06-03 的初始与重构两次提交，页面显示 0 fork、0 issue；未见已提交的原始成功响应、线上测试记录或正常续期代码。这只说明**所审公开证据不足**，不是断言当年作者没有成功运行。

## syfun 的实际凭据捕获分支

| 分支 | 源码实际读取 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| [`parse_login`](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/weread_skey.py#L44-L60) | 路径含 `/login` 的 `i.weread.qq.com` JSON 响应的**顶层** `skey`。 | 代码准备接受登录响应字段。本人 BOOX/EInk 正常 `/login` 曾实测顶层字段非空，见[本仓字段记录](MOBILE_LOGIN_SKEY_FIELD_PROBE.md)。 | 不证明 syfun 运行时真的遇到 `/login`，也不证明 Mac 字段与 BOOX 字段权限相同。 |
| [`parse_other`](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/weread_skey.py#L19-L41) | 任一 `i.weread.qq.com` 请求的 `skey` **header**，仅在关联响应的 JSON 含小写 `errcode` 键时跳过。 | 可以从客户端已有请求复制既存凭据；无需发生新登录或签发。 | 既不证明 header 凭据是新签发，也不证明该请求成功：没有 HTTP 状态检查，没有业务码等于成功的检查；非 JSON、解析失败、JSON 用 `errCode` 大写 C 或没有 `errcode` 的错误响应仍可能被接受。 |
| [`response` 调度](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/weread_skey.py#L63-L73) | 匹配 `/login` 先调用 `parse_login`，然后仍调用 `parse_other`；任一 `emit_skey` 会关闭 mitmproxy。 | 第一个取得的值决定运行脚本后续使用的 `skey`。 | 仓库没有记录首个命中分支，故不能把它归因于 `/login`。 |
| [`weread_vid.py`](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/weread_vid.py#L33-L41) | 从任一同域请求的 `vid` header 读取。 | 作者也从客户端已有请求复制 `vid`。 | 不给出新 `vid` 的正常生成、续期或权限来源。 |

[`run.sh:20-40`](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/run.sh#L20-L40)通过 `mitmdump`、`open -a "微信读书"` 和捕获日志拿到首个 `skey`。这是 syfun 的运行依赖，**不是本产品可采用的取凭据路径**。即使其 Mac 客户端存在可用 `skey`，目前仍缺：该客户端的公开、可复现、无需抓包的本人正常登录取得链，以及经核验的当前 `/book/articles` 成功回包。不能因为旧项目没写登录代码便推断凭据绝对无法获得；也不能从捕获脚本反推已经证明可持续获得。[苹果当前 Mac 商店页面](https://apps.apple.com/cn/app/%E5%BE%AE%E4%BF%A1%E8%AF%BB%E4%B9%A6/id952059546?platform=mac)标示这款腾讯 App 为 iPad/iPhone 应用；`open -a` 本身不能识别 syfun 当时的安装包、客户端版本或具体认证栈。

## 正常登录链、客户端差异与生命周期

| 来源 | 可审查的一手发送代码 | 凭据及续期证据 | 对 `/book/articles` 的结论 |
| --- | --- | --- | --- |
| 本人合法 BOOX/EInk | [本仓一次正常 `/login` 字段实测](MOBILE_LOGIN_SKEY_FIELD_PROBE.md)；腾讯返回同 `vid` 的顶层非空 `skey`、`accessToken`。 | 旧设备恢复凭据可按已审登录形状续期；本次顶层 `skey` 是候选而非端点授权证明。 | 旧 2021 自定义头形状与新 2026 query 形状各被单次 HTTP 401、`-2012` 缩限；不重试。 |
| 近期 [`teng-lin/weread-omni@88bd2e0`](https://github.com/teng-lin/weread-omni/commit/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4) 的 BOOX/EInk profile | [`qrlogin.ts:63-105`](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/auth/qrlogin.ts#L63-L105) 从腾讯 `i.weread.qq.com/wxticket` 和微信官方二维码入口准备本人扫码；[`qrlogin.ts:136-279`](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/auth/qrlogin.ts#L136-L279) 在确认后 POST `i.weread.qq.com/login`。[`token.ts:50-135`](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/auth/token.ts#L50-L135) 用同设备 `refreshToken` 再 POST `/login` 续期。 | SDK 提取并持久化 `vid/accessToken/refreshToken/deviceId`；[`profile.ts:20-32`](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/profile.ts#L20-L32) 商务请求发送 `vid/accessToken`，默认 [`device-ua.ts:12-31`](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/device-ua.ts#L12-L31) 是 `WeRead/2.1.2`、BOOX、`wr_eink`、`deviceType=3`。其解析器未提取 `skey`，不代表腾讯 `/login` 必不返回。 | SDK **没有实现** `/book/articles` 调用；它的 [MP 列表发送行](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/api/resources/public-accounts.ts#L50-L88) 是另一服务 `GET /mp/chapters`，而[传输层](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/api/mobile.ts#L321-L356)固定腾讯 `i.weread.qq.com` base URL；由 B 线独立审查。作者的 [EInk APK 端点目录](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/docs/endpoints.md#L143-L147) 只列出 `/book/articles`，不是成功证明。 |
| syfun 所称 macOS 微信读书客户端 | 上节捕获分支和 `run.sh`。 | 有从登录响应或已有请求 header **读取** `skey` 的代码，没有无抓包的 Mac 登录请求生成和续期代码；实际命中分支及 token 生命周期不明。 | 没有 Mac 凭据的当前成功回包可核；不能声称 Mac 更高权限，也不能声称与 BOOX 权限必相同。 |
| 2026 `qianh/weread-collect-agent` | [`client.py:163-190`](https://github.com/qianh/weread-collect-agent/blob/c68be20cd32645198d42f7309d1d327799e1863b/weread_collector/client.py#L163-L190) 用用户提供的 `/login` cURL 响应 `data.skey`，向文章端点送 `skey` header。 | 仓库 [README:203-216](https://github.com/qianh/weread-collect-agent/blob/c68be20cd32645198d42f7309d1d327799e1863b/README.md#L203-L216) 要求先用 Proxyman 提供请求；[测试](https://github.com/qianh/weread-collect-agent/blob/c68be20cd32645198d42f7309d1d327799e1863b/tests/test_client.py#L103-L170) 用模拟传输。 | 这是另一种代码形状，但无可核的免抓包登录链或线上成功回包，不按同端点继续猜凭据。 |
| 2026 `Cairl/WeReadIt` 的平台分支 | [`exchanger.py:50-75`](https://github.com/Cairl/WeReadIt/blob/85a160a63445320ceacf3e5833d0280f5054bff7/src/wereadit/core/exchanger.py#L50-L75) 在它的**兑换**接口按 iOS `skey` header、Android `accessToken` header 分支。 | 说明开源实现承认平台形状差异；其续期仍依赖用户提供捕获的 `/login` cURL。 | **不是** `/book/articles` 的认证代码，不能据此推出 iOS/Mac 在文章端点有权限。 |

`weread-omni` 的真实 MP 列表代码虽有分页和正文后续读取，但公开 [`live` 测试](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/test/live/read-only.test.ts#L6-L96) 默认跳过，MP 子测试还需私有环境变量；仓库未提供测试输出或目标号成功响应。它的测试首请求显式设 `offset:0`，与当前源码注释“首请求无 offset”并不一致，实际服务形状需要独立审阅。不要把 SDK 能力宣称当作本目标文章列表验收。

## 认证命名不能互换

| 名称 | 已证实的作用范围 | 与本端点关系 |
| --- | --- | --- |
| `wrk-` API Key | 腾讯官方 Gateway 鉴权；本账号一次 `/_list` 不列 `/book/articles`。 | 没有转换成 i 域 `skey` 的代码。 |
| Web Cookie / `wr_skey` | `weread.qq.com/web/*` 的浏览器会话；[OpenCLI 2026 issue #1709](https://github.com/jackwener/OpenCLI/issues/1709) 记录同源 Web `/web/book/info` 成功而 `i.weread.qq.com/book/info` 返回 `-2012`。 | 这是一手跨域失败个案，端点是 `/book/info`，不能直接当作 `/book/articles` 规则；没有 Web Cookie 转 mobile `skey` 的已审代码。 |
| 移动 `accessToken/refreshToken` | `weread-omni` 明确有本人扫码登录和续期链，业务请求采用 `vid/accessToken`。 | 不因 `/login` 同时可能返回 `skey` 就推断两值可互换；`refreshToken` 不发送给文章端点。 |
| 移动 `skey/vid` | 本人 BOOX/EInk 正常 `/login` 顶层字段和同账号身份已核。 | 本端点两种固定开源请求形状均在本人样本失败；它们只确定具体样本不被接受。 |

## 后续证据门槛

1. A 线不再请求 `/book/articles`。若要研究 Mac/iOS 认证，需找到**正常登录生成与续期的公开代码或腾讯文档**，能够在本人合法会话下无需抓包取得 `skey/vid`，并独立核对现时业务请求接受它们；仅有 header 复制脚本不够。
2. 对 Mac 与 BOOX 是否属于不同权限域，目前只可提出待核假设，不能据 `syfun` 的 README、Apple 平台名称或单个 `-2012` 直接下结论。若出现新的、一手成功响应，应先确认真实发送行、认证来源、客户端版本、响应身份和时点，再设计独立且有停止条件的实验。
3. B 线应继续审查 `weread-omni` 的 `/mp/chapters` 真实发送行与近期一手成功证据。该路径和 `/book/articles` 属不同服务/请求形状，A 的两次 `-2012` 不替它作结论；对它的旧失败记录仍要按账号、形状和时点缩限。

本报告只收窄 `/book/articles` 凭据判断，不改变项目的全号订阅目标与五篇真实目标文章的接入前验收要求。
