# 正常 SDK 授权到文章解析的隔离验证

2026-10-02。当前目标仍是公众号级完整近期发现。真实 Web 搜索五页已得 71 条候选，但完整覆盖、可信发布时间和批量正文仍未验证。`/mp/getreviewid` 仅解析已有 URL，不是公众号列表；它在本项目实际请求数仍为 0，旧 mobile `/store/search` 401/-2012 不能由新 Web Cookie 解除。

## 正常认证复用与边界

复用 MIT 开源 [weread-omni 固定 88bd2e0](https://github.com/teng-lin/weread-omni/tree/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4) 的 requestQr/pollForCode/exchange，不安装运行 CLI，不导入 TokenManager 或 credentials 存储模块。真正移动认证头是 profile.authHeaders 返回的 vid/accessToken，不是 Bearer 或 wr_skey。源文件 SHA256、固定 commit、编译器版本及编译产物哈希存入私有 cache manifest；源文件与 LICENSE 的期望哈希在准备脚本中锁定。MIT LICENSE 随缓存保留。

研究入口与原账号页分开。它沿用同 VID 的旧设备 ID，不发送旧 accessToken/refreshToken，不修改生产账号、Web 会话文件和来源配置；正常 SDK 登录是否让服务端已有 Web 凭据失效仍未知，不能保证。SDK 交换体 isAutoLogout=0 是源码事实，不是 Web 会话永久有效的证明。

只在本人点击本机页面按钮后，顺序执行一次 wxticket、一次 SDK qrconnect、正常有界确认轮询及一次 login 授权码交换。所有请求 HTTPS、禁止跳转；最多 40 次正常轮询，SDK轮询截止5分钟，普通请求超时20秒、长轮询单次超时45秒、64 KiB 回包。40次不等于总时长80秒；临近截止发起的在途轮询仍受单次超时限制。非 HTTP200、业务拒绝、验证码/限频立即停；过期、拒绝和取消不自动生成新二维码、续期或重放，不请求目录/原文/正文接口。本人扫码及手机官方授权不能由 Agent 代做。

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

已验证：9 项离线测试通过，包括原 SDK 源码编译原语的纯 Mock 正常路径及取消零请求；模拟账号错配、拒绝、过期、DB变化、重复/越界请求、回包上限和挑战页。CI 在无私有 cache 时只运行 7 项包装器测试，2 项原 SDK 集成 Mock 明确跳过，不下载 SDK、不接触腾讯。一次复合门禁测试原先因重用已拒绝计数器而断言错误；改为独立正常前序后测试 refresh 禁止，门禁未放宽。准备/测试期间生产全部表哈希不变。

## 下一次真实验证

2026-10-02 本人准备并点击 owner-02 入口后，实际 ticket/qr 各一次HTTP200，但未显示二维码；无 poll/exchange、新mobile或resolver请求。旧 result.stage=ticket 为 requestQr 两步共用粗阶段，不能视为确切失败端点；当时未留原回包，无法判定业务码、字段格式或URL门禁原因，不重复请求补证。生产不变。

已补私有取证：完整且不超过64KiB的响应先独占保存 response-阶段-次数.bin（包括非200/非JSON/业务拒绝），再解释。流读取或过大响应可能无法完整保存；不为留证突破限额。原始内容可含签名、UUID、授权码或新token，全部只能留Git忽略的本机私有目录，不通过HTTP暴露，不写日志。脱敏audit记录固定outcome、字节数和整数errCode/errcode；stage在requestQr失败时采用最后真实请求类别。不能把accepted_by_guard视作SDK requestQr通过。证据落盘失败也停止，不续期、不重发；15项离线回归通过，CI无cache时2项原SDK测试仍明确跳过。本次诊断修改没有解除旧限制或提供新认证依据；没有自动重开owner-03。

单次传输已准备为 `scripts/research/probe-owner-review-once.cjs`；`--plan` 零请求，只有 `--execute <ABS_SUCCESSFUL_SDK_RUN_DIR>` 才执行。正常扫码结果须成功、生产未变、同账号/VID/旧设备且30分钟内；加载哈希核验的原 SDK profile，不导入 mobile transport/TokenManager。自主选本轮五页搜索第一项，不传验收种子。发送原始 requestUrl，不将规范化存储 URL 替代请求 URL。全局私有 resolver-attempt.json 在请求前独占写入并 fsync，任何进程重复执行都被阻止，不删除；单次 HTTPS POST、20秒超时、64KiB流读取、不跳转、不续期、不重放。原始响应先私存，再作严格身份解析；解析失败也不重发。所有生产表和原配置/Web会话/旧停止/SDK新会话/发现证据哈希再次核对。后续本地I/O异常只输出请求数未知，不虚报零请求。4项纯 Mock测试通过，涵盖真实请求形状、原URL、先落标记/重复拒绝、认证/挑战/格式/身份失败、过大回包及生产变动。

先等本人完成不同于原 Web 登录的正常 SDK 扫码并核私有结果；新会话不能删除旧401/-2041/302停止。仅对本轮真实搜索自行选出的一个候选，用固定 SDK mobile 头单次请求 /mp/getreviewid，私存回包，核 URL 对应/基数/reviewId 号前缀，再决定是否请求既有 Web 正文端点并核真实文章身份/时间。没有合法新 mobile 会话时，不发 resolver 请求。严格 URL 回显等假设以实际响应为准，离线解析器成功不是线上成功。

完整近期覆盖仍独立缺证；搜索本地排序、关键词补搜、旧目录或 SDK 登录都不能抵消该缺口。后续批量/增量与生产接入须经真实列表、正文及副本保护验证。
