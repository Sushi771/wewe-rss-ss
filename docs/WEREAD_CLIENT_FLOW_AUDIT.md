# 微信读书完整客户端链路核对（2026-09-28）

## 结论与本轮范围

**尚未恢复订阅；没有取得新的最近 5 篇、正确分页或正文实测结果。** 用户本轮要求先验证这三个条件，再接入现有项目。全部历史回补不再作为第一阶段门槛；现有历史文章、ID、正文、图片和 RSS / Markdown / Obsidian 导出继续保留。

对固定版本 weread-omni 与旧实验的完整链路核对后，未发现足以支持再次扫码或重放文章首屏的、尚未验证的实质协议差异。旧实验已完成 SDK 同类墨水屏客户端登录、凭据保存和续期；续期成功后目标首屏仍返回 HTTP 499 / `-2041`。本轮依照用户“已经等价失败的，不重复”要求停止重复实验，不安装运行 CLI、不请求微信接口、不写生产库，也不接入 SDK。**这不是证明所有账号或所有时间都不可用。**

电脑微信窗口、滚动、剪贴板、抓包、聊天库/缓存采集均不再执行。旧桌面代码仅保留作历史资料。付费 API、第三方中转和全历史探针不再是本轮主线，不部署服务器或重写界面。

## 固定源码与证据来源

- 上游：[teng-lin/weread-omni](https://github.com/teng-lin/weread-omni/tree/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4)，commit `88bd2e095d7d7ee423eaadf8f40653e72c5be6d4`，包版本 `0.1.2`，MIT，Node.js `>=22.13.0`。没有安装包、全局 skill 或执行上游代码。
- 本轮补充下载公开 `device-ua.ts`、`accounts.ts`、`eink-provider.ts`、`auth/credentials.ts`、`api/client.ts`、README、package.json；连同既有 QR、token、profile、mobile、mobile-client、public-accounts、LICENSE，共 **14 个文件**逐一按 Git blob SHA-1 与固定 commit 的树核验，一致。证据：本机忽略目录 `output/playwright/weread-client-audit/source-checks.json`；此前树与源码在 `output/playwright/complete-alternative/`。
- 旧实验通过 `read_thread` 读取原聊天 `01a0e0a8-deeb-7ba2-af52-78e55c0188c0` 的命令与输出核查，没有执行旧命令，没有读取账号表、浏览器存储或微信缓存。仅将脱敏结论保存于本机 `output/playwright/weread-client-audit/old-flow-summary.json`。
- 既有 `output/playwright/complete-acceptance/old-weread-experiment-review.json` 只证明首屏形状等价；本轮新增的是登录、设备、续期、持久化和 CLI 到 SDK 的完整比较。

## 相同 / 不同 / 证据缺失

“相同”指已观察到的业务协议及凭据来源相同，不指两套 HTTP 客户端逐字节一致。所有凭据只列字段名，不记录原文。

| 核对项           | weread-omni 固定源码                                                                                                                                         | 旧实验实际流程                                                                                                                 | 判断                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 扫码入口         | `qrlogin.ts`：`i.weread.qq.com/wxticket?nonceStr=weread`，再 `open.weixin.qq.com/connect/sdk/qrconnect`                                                      | `exec-6eb53953-09f0-4330-aa4e-910da467949d` 调用相同主机、路径、nonce、应用 ID、scope 和签名来源                               | **相同**；不是只走生产 Web 登录                                                                                            |
| 用户确认与授权码 | `long.open.weixin.qq.com/connect/l/qrconnect`，`f=json`；405 后使用 `wx_code`                                                                                | `exec-761072e8-5144-4317-ac3e-8036d8d306c9` 使用同一确认链和授权码交换，输出 `LOGIN_SUCCESS`                                   | 核心链路**相同**；SDK 增加 `last`、轮询截止/状态处理，旧脚本轮询策略不同；成功确认后无新增列表授权证据                     |
| 客户端配置       | `device-ua.ts`：BOOX / Onyx，Android 11，baseapi 30，appver/basever `2.1.2.10245900`，channelId 900                                                          | QR 脚本保存这些头，登录和列表脚本读取同一 headers；完整 UA 一致                                                                | **相同**；不能再以“换墨水屏 UA”为新实验                                                                                    |
| 设备与安装状态   | `profile.ts`：deviceType 3；设备 ID 为 `eink334691225` 加补齐 19 位的随机 63 位整数；安装 ID 为 `eink31` 加 26 位数字                                        | 登录脚本使用同一算法、deviceName BOOX、deviceType 3                                                                            | **相同**；随机实例值当然不同，不构成新授权机制                                                                             |
| 首次登录请求     | `POST i.weread.qq.com/login`；code、appFirstInstall 1、isFromQrcode 1、isAutoLogout 0、trackId 空串、时间戳和 random；SHA-256(timestamp + deviceId + random) | 上述登录脚本的 JSON 字段与签名算法相同                                                                                         | **相同**                                                                                                                   |
| 凭据来源及隔离   | `/login` 返回 vid/accessToken/refreshToken，加本地 deviceId                                                                                                  | 成功后写入项目账号 JSON 的独立 `mobile` 对象；后续列表读取 `c.mobile`                                                          | **相同**的客户端来源；不是把 Web Cookie 当本次客户端 token                                                                 |
| 列表认证与主机   | `profile.authHeaders` 为 vid/accessToken；`mobile.ts` 默认主机 `i.weread.qq.com`，附客户端版本头                                                             | `exec-502758a0-0e69-49c0-bbd4-36167dc94785` 读取 mobile.vid/mobile.accessToken 和保存的版本头                                  | **相同**；该旧实验未在列表附加 wr_skey Cookie                                                                              |
| 首屏             | `GET /mp/chapters`，bookId、count 20、synckey 0，无 offset                                                                                                   | 同上命令第一请求参数相同，HTTP 499 / `-2041`；它还试过 offset 0 的另一形状，同样失败                                           | **相同，已失败**；synckey 首屏不是新发现                                                                                   |
| 客户端续期       | `token.ts`：同设备 ID，`POST /login`，refreshToken、inBackground 0、kickType 1、refCgi/trackId 空串、deviceType 3；同一 SHA-256 公式                         | `exec-4e734c3b-5f11-4cd7-aef2-625d2e3e8664` 同字段及公式，返回 HTTP 200 和新的 accessToken 后再请求首屏，仍 HTTP 499 / `-2041` | 核心协议**相同，续期后也已失败**；SDK random 为 1–1000，旧脚本为 0–999，仅边界差异，无证据说明可改变已成功续期后的列表权限 |
| 凭据持久化       | TokenManager 缓存/串行保存，续期未返回 refreshToken 时保留旧值；AccountManager 按账号保存                                                                    | 旧脚本将新 accessToken 写回 mobile，refreshToken 缺失时保留旧值；随即读取新 token 发请求                                       | 保存容器及并发保护**不同**；新 token 实际用于失败首屏，不能把落盘机制当权限修复                                            |
| CLI 与 SDK 连接  | `AccountManager.open → einkProvider.open → createEinkClient → WeReadClient`；canonical.publicAccounts 直接引用 eink.publicAccounts                           | 旧脚本直接发同协议 HTTP                                                                                                        | 软件封装**不同**；open 路径没有额外的设备激活、订阅授权或验证码完成步骤                                                    |
| 传输及错误分类   | fetch、JSON、禁止重定向、超时；401/-2012 可续期一次；`-2041` 明确抛错，不续期重试                                                                            | axios，超时与默认 headers/重定向策略不同；旧探针人工续期后仍失败                                                               | 工程行为**不同**；没有捕获两者逐字节网络流，底层 TLS/默认头**证据缺失**。不以客户端库更换或猜头为重试依据，不做抓包        |
| 分页与正文       | 首屏 synckey；后续 offset；nextOffset 按 `offset + data.length` 推算；synckey 为增量 token；正文是另一次获取                                                 | 首屏没有文章数组，没有成功下一页或由新列表取得的正文                                                                           | 成功行为**证据缺失**。SDK 的推算游标、Mock、旧库正文不能填补该缺口                                                         |

生产 `apps/server/src/weread/weread.service.ts` 的 `getLoginUid/getLoginInfo`、Web Cookie、`/web/login/renewal` 确实与客户端登录不同，且仍有 `accessToken → wr_skey` 赋值。**但它不是旧独立客户端实验所用的凭据路径**；仅比较生产代码会遗漏已经完成的客户端失败验证。未通过真实列表门槛前，本轮不改生产登录、账号数据或更新路由。

上游源码入口：[QR 登录](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/auth/qrlogin.ts)、[续期](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/auth/token.ts)、[设备头](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/device-ua.ts)、[传输与错误](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/api/mobile.ts)、[公众号与分页](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/api/resources/public-accounts.ts)、[账号连接](https://github.com/teng-lin/weread-omni/blob/88bd2e095d7d7ee423eaadf8f40653e72c5be6d4/src/eink-provider.ts)。SDK 对 `-2041` 成因的注释是作者解释，本轮只确认它的报错分支，不将其提升为本账号风控成因的诊断。

## 实测、保存与接入门槛

本轮微信登录/列表/正文请求 **0**，第三方文章 API 请求 **0**，没有二维码或验证码操作。上游 CLI 未安装、未构建或执行；没有需要用 `--help` 准备的新独立实测。

生产只读检查：4000 端口仍为 PID 33332，固定产物 `2026-09-28T14-40-10-239Z-294f5da06040`，不含桌面 helper。库内 12 个订阅、1447 篇文章，目标身份为妈妈部落畅聊阁 / `MP_WXS_3895431412`。没有迁移、生产写入、重启或导出覆盖；本轮不把已有导出测试算成新通道正文通过。源码目录的 `.paused` 检查时已不存在，本轮重建本地忽略的 `USER_PAUSED` 标记以保护历史 helper；未运行 helper。未发现旧 collector/login-poll/verify 脚本活动进程。

以后只有出现具体新增协议条件及可核对源码/实测依据，才重新评估独立客户端验证。条件具备时仍须先在隔离目录、无生产写入下完成：

1. 目标当前返回的最近 **5 篇真实不同文章**，记录标题、实际发布时间、公开 ID/链接和账号身份；不以旧库或 cover 凑数。
2. 首屏成功后才按真实响应支持的条件测试下一页，分开记录服务端字段、SDK 推算游标、原始组数、展开条数及主次条；失败不推进检查点。当前没有证明分页正确。
3. 由新列表取得文章后核验正文与图片、本地导出；然后才决定现有后端适配及一致性备份后的受保护写入。后续最近 20 篇、第二号、手动/定时及真实新文增量分别验收。

没有新依据时保持阻塞待办，不让用户重复扫码、不改用电脑微信采集，也不创建空转后继窗口。用户可先对照本报告；不能将此次研究同步称作“订阅更新好了”。

## 本轮核验结果

14 个固定源码 blob 一致；10 份既有入口文档已链接本报告并覆盖旧执行方向。生产前后在各自只读事务中对 feeds/articles 的全部列按 ID 排序取 SHA-256，计数及哈希一致，仍为 12 号/1447 篇，SQLite `quick_check=ok`；证据为本机 `production-before.json` 和 `production-after.json`。固定产物完整性检查通过且 `desktopHelperIncluded=false`，`/dash` HTTP 200。原始证据与 `.paused` 均被 Git 忽略。仅修改文档及本地暂停标记，无应用代码变更，因此未运行应用构建或 Mock 测试，也没有将这些只读检查当成采集验收。
