# `/book/articles` 2026 query 凭据形状：一次性探针离线准备（2026-09-30）

## 来源和差异

已固定审计 [`syfun/weread-mp-pull@7319d997`](https://github.com/syfun/weread-mp-pull/tree/7319d9976d7390f60edca28a073082c82c10f2f3)；该提交在 2026-06-03，2026-09-30 `git ls-remote` 仍为仓库 HEAD。它的 [`main.py:30-61`](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/main.py#L30-L61)确实用 `httpx.get` 向 **腾讯 `https://i.weread.qq.com/book/articles`** 请求，并把 `bookId/version=2/vid/skey/offset=0/count=1/synckey` 全放在 URL query，随后解析 `reviews[0].subReviews[].review.mpInfo`；[`main.py:143-149`](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/main.py#L143-L149)将 `synckey` 设为 `int(pendulum.yesterday().timestamp())`。这里的 `count=1` 是请求的 review 组数，代码仍遍历首组里的多篇 `subReviews`，不能把它当作“一篇文章上限”。

[`weread_skey.py:44-71`](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/weread_skey.py#L44-L71)从 `i.weread.qq.com/login` **顶层**响应字段读取 `skey`；其 [README](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/README.md#L94-L109)同时说明日常运行以 mitmproxy 监听 macOS 微信读书客户端，每次抓取密钥。仓库没有独立免抓包登录或续期实现，没有随代码提供可核查的真实 `/book/articles` 成功回包、测试日志或样本数据；项目从 2026-06-03 至本次审计未见更新。这是**请求发送代码**和作者功能说明，不是当前认证成功证据。其 `main.py:141` 还会打印 skey 前缀，因此不能照搬运行链和日志。抓包绝不进入本产品最终运行方式。

本仓已经通过本人现有合法 **BOOX/Eink 移动端**凭据按正常 `/login` 请求，私有保存同账号顶层 `skey/vid`，见[登录字段实测](MOBILE_LOGIN_SKEY_FIELD_PROBE.md)。`syfun` 读取的却是 **macOS 客户端** `/login` 响应；字段名和顶层位置相符，跨客户端的 token 权限、有效期和 ArticleService 接受性均未证实。现有记录解决本次最小探针的凭据**来源**，不能证明值仍有效或可供该端点使用。[此前两次 401 对照](BOOK_ARTICLES_401_DIFFERENTIAL.md)分别是匿名 `count=10`，及同一账号合法新 `skey/vid` 按 **2021 WeBook 自定义头**、`count=20`、当前 Unix 秒 `synckey` 的请求；第二次返回 HTTP 401、`-2012`，没有 `reviews`。该 `-2012` 只排除旧头、旧参数、该账号、该时点这一形状。`syfun` 的 query 认证位置、`version=2`、`count=1`、前一天零点 `synckey` 是代码级实质差异；尚无证据保证它能改变服务端结果。文档旧版“包括 syfun 一律停测”的判断体现当时两次 401 后的谨慎边界；用户现明确要求在**源码、认证来源与实质差异齐备**时先设计一次低频隔离验证，因此本次仅准备脚本，线上决定仍留给总控重新审查。

## 新脚本的固定范围

[`probe-book-articles-query-once.cjs`](../../scripts/research/probe-book-articles-query-once.cjs)只读取已有私有 `mobile-login-skey-response.json` 的顶层 `skey` 与同账号 `vid`，不从 `wr_skey`、`wrk-`、Web Cookie 或 `accessToken` 猜值。沿用 `recoveryGate` 对生产 SQLite、原始一致性备份和副本的 **readOnly/query_only** 与移动恢复身份核验；另核此前合法 `/login` 记录和旧 WeBook 实验确实为 HTTP 401、`-2012`。私有登录记录超过 24 小时即停，避免用明显陈旧的候选值消耗一次目标请求；这不是腾讯官方 TTL，也不证明 24 小时内一定有效。该门禁过期须重新设计合法凭据来源，不能删标记或绕过时限。

请求只在显式 `--execute ... --approved-online` 下尝试。先在固定的 Git 外当前用户目录 `~/.wewe-rss-private/book-articles-query-once.attempted.json` 以独占创建和 `fsync` 留**跨 runDir 的独立永久标记**，然后最多一次原生 Node HTTPS GET，无自动重定向、无重试、15 秒超时、响应上限 1 MiB。不设 Cookie、`skey/vid` 自定义头或 Referer；User-Agent 对齐 `uv.lock` 固定 `httpx 0.28.1` 的默认值，`Accept-Encoding: identity` 则是为了有界解析而有意不同于 httpx 的压缩协商。只连腾讯 `i.weread.qq.com`，禁代理、Node 调试和 TLS 宽松环境变量；HTTP 401/403、429、3xx、验证码/限流业务码立即终止该路线，不跟跳转或再试其他参数。`synckey` 取中国时区前一天 00:00 的 Unix 秒，以避免执行主机时区与本用户环境不一致。

**query 中的 `skey/vid` 必须随 TLS 请求发送给腾讯，这是此固定开源形状本身的不可消除特征。**脚本从不打印 URL、query、请求对象、原始错误或原始响应，不向代理发送请求；日志、CLI 参数、Git 及私有结果文件都不保存 query 凭据。腾讯服务端如何记录其自身收到的 URL 不受本项目控制；因此若总控认为 query 凭据暴露面不可接受，应在离线状态停用，不尝试线上验证。

收到响应后仅输出 HTTP、脱敏业务码、重定向**类别**、`reviews` 数组和组/子条目、身份/时间/URL 字段的**存在数量**及停止原因。私有结果文件保存同样的最小结构，并最多保存首组 100 个子条目的 `reviewId/belongBookId/mpInfo.originalId/title/mp_name/time`，用于之后离线核真；不保存正文、原始 JSON、响应头、query 或令牌，且保存前拒绝任何包含 `skey` 或 `vid` 的字符串字段。若私有落盘失败，标记仍保留，不重新联网。即使出现文章，也需另行检查五篇真实不同目标文章的号身份、稳定 ID、可信原文发布时间、分页、正文和图片；此脚本本身不接 Provider 或生产库。

## 本轮离线验证及后续决策

本轮只执行 `node --check`、`--plan`、`--self-test`；**没有向目标 `/book/articles` 发请求，也没有读取本机私有 skey 值**。六种假响应分别覆盖：有真实层级的 `reviews`、空数组、HTTP 401 携 `-2012`、302 验证跳转、429 限流、HTTP 200 携 `-2041`；自测检查标记先于请求、仅一次传输、query 顺序和输出/结果中无模拟凭据。离线命令：

```powershell
node --check scripts/research/probe-book-articles-query-once.cjs
node scripts/research/probe-book-articles-query-once.cjs --plan
node scripts/research/probe-book-articles-query-once.cjs --self-test
```

总控完成源码和敏感信息复审后，若决定存在合法且仍新鲜的同账号私有凭据，可先用生产 SQLite 和原私有 `mobile-refresh-*` 目录运行**只读预检**；预检仍为网络 0。在线执行还须总控重新判断此前 401、腾讯访问限制与 query 凭据风险，不能因为 `preflight_ready` 就自动放行：

```powershell
node scripts/research/probe-book-articles-query-once.cjs --preflight --db '<生产 SQLite 绝对路径>' --run-dir '<原私有 mobile-refresh 目录绝对路径>'
node scripts/research/probe-book-articles-query-once.cjs --execute --db '<同一 SQLite>' --run-dir '<同一私有目录>' --approved-online
```

`-2012`、空数组或错误响应仍只缩限**本次 query 形状**，不能直接推断自建订阅整体失败。若凭据新鲜性门禁、账号身份或私有原备份不通过，保持离线；不得以换 runDir、删除 marker、调整 `synckey/count` 或重放旧头形状规避。该端点没有当前成功样本，未来是否值得真的用掉这一请求额度，要由总控结合剩余公开线索复审，研究可继续在其他独立路线开展。
