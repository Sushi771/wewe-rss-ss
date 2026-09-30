# 移动 `/login` 的 `skey` 字段单次核查

日期：2026-09-30。状态：**只完成源码审查、假网络自测及生产库只读预检；线上请求 0。**脚本为 [`probe-mobile-login-skey-once.cjs`](../../scripts/research/probe-mobile-login-skey-once.cjs)。本探针只回答旧 `/login` 新一次正常续期响应是否含顶层 `skey` 或 `data.skey`，并保护可能轮换的凭据；不会访问 `/book/articles`、公众号搜索或原文。

## 为什么需要一次不同于旧 Refresh 的实验

- [2026-06 `syfun/weread-mp-pull@7319d9976d` 的登录响应读取行](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/weread_skey.py#L44-L71)检查 `i.weread.qq.com/login` 顶层 `skey`；其[实际文章请求](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/main.py#L36-L69)却把 `vid/skey` 放入查询参数。该实现每次通过 mitmproxy 监听 Mac 微信读书客户端取得字段，[README 第 265–295 行](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/README.md#L265-L295)证实抓包是其运行依赖，不符合本产品运行边界。其代码没有提供可独立复现的正常登录请求体，也没有公开成功响应样本。
- [2026-08 `qianh/weread-collect-agent@c68be20` 第 163–190 行](https://github.com/qianh/weread-collect-agent/blob/c68be20cd32645198d42f7309d1d327799e1863b/weread_collector/client.py#L163-L190)采用另一形状：向同一文章端点送自定义 `skey` 头；旧请求失败后重放用户给的 `/login` cURL，并从已解包的 `data.skey` 取新值。其[README 第 203–216 行](https://github.com/qianh/weread-collect-agent/blob/c68be20cd32645198d42f7309d1d327799e1863b/README.md#L203-L216)要求用户先用 Proxyman 提供文章及登录 cURL；[测试第 103–170 行](https://github.com/qianh/weread-collect-agent/blob/c68be20cd32645198d42f7309d1d327799e1863b/tests/test_client.py#L103-L170)使用 `httpx.MockTransport`，不是线上成功回包。其[正常 Web QR 登录第 57–90 行](https://github.com/qianh/weread-collect-agent/blob/c68be20cd32645198d42f7309d1d327799e1863b/weread_collector/client.py#L57-L90)把 `payload.skey` 缺失时的 `accessToken` 当回退，却只交给 `/web/mp/articles`，不能证明旧 i 域文章端点接受 Web 凭据。
- [2026-07 `Cairl/WeReadIt@85a160a` 第 50–75 行](https://github.com/Cairl/WeReadIt/blob/85a160a63445320ceacf3e5833d0280f5054bff7/src/wereadit/core/exchanger.py#L50-L75)对同一 i 域兑换接口按客户端平台分别发送 iOS `skey` 头或 Android `accessToken` 头；这证明头名按平台分支，**不证明两个值相同或不同，也不证明 `/book/articles` 规则**。[该提交的一手说明](https://github.com/Cairl/WeReadIt/commit/85a160a63445320ceacf3e5833d0280f5054bff7)报告将 Web `wr_skey` 用作 App skey 得到 HTTP 401、`-2012`，并删除复用路径；这只是其兑换端点的观察，不是本账号文章端点的实测。其[续期代码第 37–98 行](https://github.com/Cairl/WeReadIt/blob/85a160a63445320ceacf3e5833d0280f5054bff7/src/wereadit/core/token_refresher.py#L37-L98)尝试多个 token 键，但依赖用户抓包的 `/login` cURL。
- 先前本机合法 `/login` 已得到新 `accessToken` 并成功建立 Web 书架会话。旧 runner 的 [`tokenFields` 第 201–212 行](../../scripts/research/probe-mobile-refresh-once.cjs#L201-L212)只保存 `accessToken/refreshToken/vid`，所以私有恢复文件**没有 `skey` 不能说明原始回包没有 `skey`**。本轮只按键名和存在性查该私有恢复文件；没有输出任何凭据值。新增实验的唯一新信息是原先被丢弃的字段是否确实存在。

## 门禁与私有恢复

`--preflight` 复用[已执行过的 Web 健康预检](../../scripts/research/probe-refreshed-mobile-web-health.cjs)核唯一账号、原生产库与一致性备份、SQLite 演练副本、旧 Refresh marker、身份相符且已落盘的新 `proposedMobile`；三个 SQLite 句柄都是 `readOnly` 与 `query_only`。新请求使用私有恢复文件中的同设备 `vid/deviceId/refreshToken`，不读原始值到日志，不写生产库。实际 `/login` 方法、路径、版本头、请求体和签名逻辑只复用[旧一次成功的固定 `refreshShape` 第 123–148 行](../../scripts/research/probe-mobile-refresh-preflight.cjs#L123-L148)，不猜新参数。

在线模式须显式 `--approved-online`；先以 `wx` 私有权限写新 marker，再使用无代理的 Node HTTPS 最多发送一次 POST，30 秒超时、不跟随跳转、不重试、响应体读取上限 64 KiB。拒绝代理、Node/Playwright 调试及 TLS 宽松环境变量。即使 HTTP/业务码异常，只要收到响应，就先把**有界原始响应文本和响应头**连同旧 mobile 候选原子存入本次私有 runDir 新文件；若存盘失败，保持进程及内存候选，只允许本地持久化重试，不再联网。超过 64 KiB 或读取中断时只保留已读取的上限内前缀并停止，不能保证未读部分没有 token；这是响应大小保护的明确限制。marker 留存，禁止自动重复。

公开输出仅含 HTTP/业务码、顶层及 `data.skey` 的存在性/类型/粗长度区间、返回 `vid` 与输入身份匹配 `true/false/null`、停止分类、私有保存布尔、请求数和生产写入数。`null` 表示没有可比较的返回 `vid`；即使拿到非空 `skey` 也只称**候选**。验证码、限流、重定向、身份不一致或其他业务错误立即停止；没有后续文章请求。

## 已完成的离线结果与执行条件

`node scripts/research/probe-mobile-login-skey-once.cjs --plan` 返回 `plan_only/maxRequests=1`；`--self-test` 用假网络覆盖 `data.skey`、顶层 `skey`、身份不符、验证、限流、超长响应、异常 HTTP 带轮换 `refreshToken` 及首次私有落盘失败后的本地重试，结果 `self_test_passed/fakeNetworkRequests=2/productionWrites=0`。对本机现有生产库及私有 runDir 的 `--preflight` 返回 `preflight_ready/networkRequests=0/productionWrites=0`。**未运行 `--execute`。**

总控复审后如决定在线执行，使用同一生产 SQLite 绝对路径和已经备份的 `mobile-refresh-*` 私有 runDir：

```powershell
node scripts/research/probe-mobile-login-skey-once.cjs --preflight --db <生产 SQLite 绝对路径> --run-dir <已备份的私有 runDir 绝对路径>
node scripts/research/probe-mobile-login-skey-once.cjs --execute --db <生产 SQLite 绝对路径> --run-dir <同一私有 runDir 绝对路径> --approved-online
```

若 `skey` 存在且身份吻合，**再单独设计和复审**一次 `/book/articles` 首屏：只从已落盘私有响应取新 `skey`；先确认返回层级和账号身份、验证码/限流均无异常，再在旧 WeBook 自定义头形状与 `syfun` 查询参数形状之间依固定源码选择一种，不混用，更不能直接拿 Web `wr_skey` 或旧 `accessToken` 改名代替。文章请求必须新 marker、最多一次、无代理/跳转/重试、只输出脱敏 HTTP/业务码和 `reviews` 结构；取得文章才继续目标身份及五篇验收。若没有 `skey`，只排除**本次同设备 `/login` 回包包含该字段**，不能据此说所有客户端/接口永久不提供。
