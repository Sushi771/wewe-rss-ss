# Sites 小量只读连接：本地模拟结果与待批准实施清单

基线：PR69 `ee0bc40b1d0f523ba66c302c1f8ba7fc80ec03fb`。
本阶段只增加 HTTPS 合成回归及本文，不修改现有 UI、性能、采集、数据库、原合同、默认 Worker 或正文验证器。没有创建 Site、账号、真实令牌、隧道、DNS、服务、自启动或防火墙规则，也没有上传真实文章。Windows 继续负责采集和本地存储；不默认采购 VPS。

## 已验证的边界

`sites/private-reader/test/https-contract.test.mjs` 用两个 `127.0.0.1` 随机端口模拟 Site 服务端与本地窄网关。证书由 OpenSSL 在测试临时目录生成，只信任该次 CA，不安装证书、不关闭 TLS 校验，读取后立即逐文件清除。机器密钥仅在进程内随机生成。测试结束关闭监听和连接，不保留后台进程。

链路复用原 `createReaderRequest` → `createPrivateReaderWorker` → `createLocalSitesGateway` → 既有合成 caller。原 `wechat-cache.test.mjs` 继续覆盖真实缓存验证函数 + Cheerio + 原合同 + Worker + 客户端 + Blob；本轮不重写或复制正文验证逻辑。

| 场景              | 可重复断言                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 本人访问          | 列表、正文和浏览器 HTML Blob 下载成功；仅调用 feed.list、article.list、article.byId                                                    |
| 未登录/非本人     | 返回 401/403；伪造 owner、Sites 服务 bearer、身份 header 均不能改变可信桩；网关收到 0 次请求                                           |
| 机器认证缺失/错误 | 401，caller 0 次；Site 已通过本人判断也不能绕过                                                                                        |
| 原应用权限未通过  | 403，caller 0 次；机器密钥不能代替应用权限                                                                                             |
| 上游超时          | 原合同保持 PC_UNAVAILABLE/offline；不是空列表，不能宣称请求成功                                                                        |
| 浏览器超时        | REQUEST_TIMEOUT/timeout，清除正文，只尝试一次                                                                                          |
| 断线/重连         | 停止网关后显示 offline；重启同一测试端口后必须明确重新读取，成功恢复，无自动重试                                                       |
| 路由与输入        | 仅 POST /private/read；拒绝任意 tRPC、查询串、GET、刷新、操作状态、URL/路径参数；仅公众号只读动作                                      |
| 前端和日志        | 浏览器请求只有同源合同及 Content-Type，无机器密钥/网关 URL/私人字段；日志严格只有 hop/code，不记录正文、ID、请求响应体、凭据或原始异常 |
| TLS               | 无该次 CA 的客户端必须拒绝自签证书；所有网络目标必须是 127.0.0.1                                                                       |

这些是模拟可信身份和模拟应用权限。没有验证真实 Sites dispatch、真实受保护 caller、真实 ngrok、手机浏览器或跨设备；测试日志断言也不证明第三方平台日志已关闭。默认 Worker 仍拒绝访问，没有启用配置的环境变量或入口。

## 最小真实连接顺序（尚未执行）

每一项先由父线程给出具体目标及批准，再实施；不要求此时创建真实 Site。

| 顺序 | 要做的最小变化                                                                                               | 账号/权限是否必须                                                                                                                                                                    | 数据流与验收/停止条件                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 在当前 ChatGPT 账号创建一个 owner-private Site，保持私有 audience；绑定 PR69 的 Worker 源码及真实 project_id | 必须有 Sites 创建/部署权限；无需另建 ChatGPT 账号。实际创建和部署待批准                                                                                                              | 初次可先发布默认关闭版本，无文章。核对真实 project_id、部署 SHA 和 audience；不启用公共访问                                                               |
| 2    | 只在该 Site 可信 dispatch 后读取稳定 user ID，核对本人会话后固定 owner ID                                    | 必须有该 Site 本人会话；不能用第一次任意访客注册为 owner，也不能凭 email/header 自报                                                                                                 | 每次 API 都核对 ID 与 project_id；缺失 401，非本人 403，且访问 Windows 0 次。服务 bearer 不是访客身份                                                     |
| 3    | 获批后通过 Sites runtime 配置保存 `READER_GATEWAY_URL` 与 `READER_MACHINE_SECRET`                            | 必须具有该 Site 配置权限。当前官方支持 `sites_update_environment_variables`，敏感值设 `is_secret: true`；也可在目标 Site 的 More actions → Settings 配置，不写进源码/manifest/浏览器 | 更新返回环境 revision；须部署已保存版本才能应用该 revision。配置能力已核实，实际 secret 保存及运行时读取尚未验收，不用前端配置或源码常量替代              |
| 4    | 在隔离开发配置中把已有私有 reader 适配挂到 Windows 窄网关；仅 loopback 监听一个批准端口                      | 必须批准挂载/监听，以及使用现有应用认证的具体模式；不要求新公众号 Cookie、扫码或小红书账号                                                                                           | 独立机器认证通过后，再走当前应用 auth.code 或 private session 的真实验证结果创建受保护 caller；不制造 isLocal/errorMsg，不暴露整个 tRPC/数据库            |
| 5    | 用户选择并批准稳定 HTTPS 通道；候选为 ngrok 账号固定 dev domain，手动启动 agent 指向上述唯一网关             | 使用 ngrok 必须有其账号、agent authtoken、出站网络权限；若没有账号须用户决定创建。固定平台域名无需自有域名/DNS、Cloudflare 或 VPS                                                    | Sites 服务端 → ngrok HTTPS edge → 出站 agent → Windows loopback。批准后才安装/登录/保存 token/开通 endpoint；本阶段没有执行。禁止映射生产 UI 或数据库端口 |
| 6    | 用有界合成文章跑真实 Site→通道→隔离网关验收，再单独批准最小真实文章试读                                      | 必须批准 Site 发布、持久访问和真实数据外发的目标与范围                                                                                                                               | 先验本人/非本人、无机器密钥、应用认证失败、关机/掉线、手动重连、TLS/重定向拒绝、配额耗尽；通过后才允许例如 1 篇已缓存文章。记录真实准确 SHA 与结果        |

首次真实接线应在服务端固定 HTTPS URL、拒绝重定向，保留原合同字段/响应限额和 5 秒上游界限，不提供用户可控地址或自动回退。不暴露刷新、状态、采集、批量导出、文件系统路径或数据库。预检 capability 可以保留，但不能触发采集。

### 2026-10-19 官方配置与身份入口复核（仅文档更正）

本轮重新发现的官方工具已包含 `sites_update_environment_variables` 与 `sites_get_environment_variables`，因此此前“当前工具没有 secret setter”的判断已过时。更新工具只改变列出的键，支持 `set_values` 中的 `is_secret: true`，敏感值不以明文回读；返回 `revision`，之后须部署已保存版本才能应用新环境 revision。该能力不等于已经配置或部署，具体项目返回的配置 instructions 仍须实施时核对。[官方配置说明](https://learn.chatgpt.com/docs/sites/managing-a-site#configure-runtime-environment-values)给出的用户入口是 [ChatGPT Sites](https://chatgpt.com/sites) → 目标 Site → More actions → Settings；秘密不得粘贴进聊天、附件或站点内容。

可信身份来自 Sites 托管 dispatch，而不是浏览器自报字段。[官方登录说明](https://learn.chatgpt.com/docs/sites/data-and-connections#add-sign-in-with-chatgpt)确认平台登录/退出路径与服务端身份转发；当前官方 Sites 身份技能及 starter 进一步给出 `oai-authenticated-user-id`，ID 仅在同一 Site 内稳定、跨 Site 不同。Vinext 的服务端 `getChatGPTUser()` 读取该 ID 与 email；本项目 Worker ESM 接线须在真实托管入口后使用同一身份合同，不能把本地模拟 header 当平台证明。邮箱、显示名、`get_site` 的账号访问 ID 和 Sites 服务 bearer 都不替代站内用户 ID。

待获单独批准的最小验证应先创建私有 Site、部署不连接 Windows 的身份/配置诊断版本；仅用无敏感意义的测试 secret 验证服务端读取与前端不泄露，待本人登录确认该 Site 的 ID 后再固定绑定。不能自动把首位访客登记为 owner。[官方访问说明](https://learn.chatgpt.com/docs/sites/publishing-and-sharing#choose-who-can-visit)指出新 Site 在工作区也可能允许管理员访问，因此私有 audience 之外仍须应用内本人 ID 检查。通过这些验证后才考虑真实机器密钥、Windows caller 与通道，无需提前注册 ngrok。

本次只修正文档判断。最小私有身份诊断验证已获单独批准，但此文档修正不代表诊断已创建或部署；真实机器密钥、Windows caller、外部通道及文章传输仍未获批准。现有阅读器运行代码与默认关闭状态保持不变。

## ngrok 候选的成本和隐私边界

2026-10-19 核对官方文档：[Free Plan Limits](https://ngrok.com/docs/pricing-limits/free-plan-limits)、[Domains](https://ngrok.com/docs/gateway/domains)。免费账号自带固定自动分配 dev domain，不能自由选名称；免费月出站流量 1 GB、HTTP 请求 20,000，耗尽不能假设继续可用。实际账号额度/周期须实施时核对，不自动升级购买。

正文图像通过合同以 data URI 传递，JSON/HTML 有编码和封装开销；正文读取和再次下载各消耗一次网关响应。按**假设**每次响应 1 MB 估算，1 GB 仅约 1,000 次大响应；约 4 MB 则约 250 次，还需扣列表、重复下载与其他用量。因此先人工小量读取，不后台轮询、不预抓全库、不做自动重试。真实首轮须量测响应字节和请求计数再给预算，不能用 20,000 请求上限推断可读 20,000 篇。

数据主副本仍在 Windows；被请求的订阅名、标题、正文、内嵌图片会经过 ngrok 和 Sites 服务端，再到当前用户设备内存/下载文件。它们确实离开 Windows。普通 HTTPS edge 终止 TLS，通道服务商可处理明文请求/响应；不能声称端到端只有本人可见，也不能声称“零云端处理”。本方案不使用 D1/R2 或另建云数据库，但第三方处理/日志保留另需核实。

真实接线前必须关闭或确认不采集敏感内容的 agent 请求检查、云端 Traffic Inspector、重放和请求/响应捕获；日志仅留固定错误码、状态、耗时及字节数，不留原文、Authorization、Cookie、URL 参数和原始异常。[Agent configuration](https://ngrok.com/docs/gateway/agent/config/v3) 与平台计划需按实际版本核对；仅关闭本地检查界面不足以证明云端不留日志。若无法核实符合用户要求，停止真实文章试读并报告缺口，不把本地合成日志测试当作平台保证。

退出/撤销：手动停止独立 agent 和窄网关，撤销该机器密钥及 agent 访问，关闭 Site adapter 或恢复默认关闭部署；保留原 Windows 采集存储。自启动、Windows 服务、入站防火墙、路由器映射、长期令牌和自动运行都不是本次批准范围。

## 执行与证据

```text
node --test scripts/sites-local-contract.test.mjs sites/private-reader/test/*.test.mjs
node sites/private-reader/build.mjs
node apps/server/node_modules/jest/bin/jest.js --config apps/server/package.json --runInBand sites-wechat-cache.spec.ts
```

Node 24；需要已有仓库依赖及 OpenSSL（Windows 使用 Git 自带 `C:\Program Files\Git\usr\bin\openssl.exe`，Linux CI 使用 PATH 的 openssl）。不联网下载证书或测试数据。HTTPS 测试由现有 reader CI 的 wildcard 自动执行。

本轮 sushi 独立工作区实测：完整 Node 65/65（原 59 + 新 HTTPS 6），原验证器 Jest 21/21，Worker 构建仍为 27,669 bytes，新增文件定向格式与 diff 检查通过。原合同 blob 仍为 `66896a53ee61efd858efa5aa1abd37e19820c19e`。测试复用已有依赖目录联接，未复制生产数据或重新安装依赖。reader CI 继续执行原链路，并增加原正文验证器 Jest 回归。

交付必须分别报告：代码与测试 SHA、草稿 PR、该 SHA CI；真实连接仍未配置、未部署、未跨设备验收。不要把历史提到的测试数量合并计算为当前覆盖；本轮以实际命令输出为准。
