# `/book/articles` 新 `skey` 单次首屏对照

日期：2026-09-30。状态：**仅源码审查、假网络自测、现有私有恢复与生产库只读预检；文章端点线上请求 0。**独立脚本为 [`probe-book-articles-skey-first-page.cjs`](../../scripts/research/probe-book-articles-skey-first-page.cjs)。总控此前唯一一次正常移动 `/login` 字段核查得到 HTTP 200、顶层非空 `skey`、`vid` 与同账号相符，且原始响应及可能轮换的 token 已私有原子保存。本脚本只从这份已落盘私有响应读取 `skey`，不从 Web `wr_skey`、旧 `accessToken` 或人工输入猜值。

## 固定源码与这次请求的精确形状

旧 [WeBook 固定提交 `f8b31196` 第 650–673 行](https://github.com/wnma3mz/wechat_articles_spider/blob/f8b31196e88045d079901812ea064ad4953d62a6/wechatarticles/ArticlesUrls.py#L650-L673)构造 `GET https://i.weread.qq.com/book/articles?bookId=MP_WXS_{id}&count=20&offset={offset}&synckey={当前 Unix 秒}`。请求头只有其固定 iPhone UA、字面 `Cookies: wr_logined=1`（源码确为复数 **Cookies**，并非浏览器 `Cookie`）、自定义 `skey` 和 `vid`；旧代码读 `reviews[].review`。脚本将已知目标后缀 `3895431412` 固化为 `MP_WXS_3895431412`，首屏 `count=20/offset=0`，以同样顺序填当前 Unix 秒，只送上述四个头。没有从[另一份 2026 代码](https://github.com/syfun/weread-mp-pull/blob/7319d9976d7390f60edca28a073082c82c10f2f3/main.py#L36-L69)混入 query `skey/vid`，也不带 Web Cookie。

这是在旧公开源码请求形状下，检验**本账号这次合法 `/login` 产出的顶层 `skey` 对该端点当前返回什么**；它并不预设可以取到目标文章。由于 UA 来自 2021 年公开示例、`skey` 来自 2026 年独立移动登录，若认证失败，只能排除这组具体条件，不得扩大成整个微信读书接口永久关闭。

## 私有凭据和账号门禁

`--preflight` 调用已有[Web 健康探针](../../scripts/research/probe-refreshed-mobile-web-health.cjs)的恢复门禁：对生产 SQLite、原一致性备份和演练副本只读且 `query_only`，核唯一账号、旧 `/login` Refresh marker、已保存的新 `proposedMobile`、账号与设备一致。随后独立读取私有的新字段核查 marker 与响应文件，核 marker 路径 `/login`、时间顺序、HTTP 200、判据 `skey_candidate_identity_matched`、响应确为 JSON、顶层 `skey` 为 1–512 个可放入 HTTP 头的可见 ASCII 字符（拒绝 CR/LF）、顶层数字 `vid` 与旧恢复身份一致，及任何业务错误/验证提示不存在。**短 `skey` 只满足头语法，不证明服务器会接受。**只有这些门禁都通过才在内存中取得两项头值；不打印长度、前后缀、哈希或原值。新响应中 `data.skey` 若同时出现便拒绝，以避免层级歧义。脚本也不修改或消费保存的轮换 token；新 `/login` 响应有 `accessToken`、无新 `refreshToken`，旧 `refreshToken` 仍留在私有恢复文件。

在线模式须显式 `--approved-online`，先原子私有创建本端点独立 marker，再由无代理 Node HTTPS 发送**恰一** GET；30 秒超时、不跟随重定向、不重试，响应体最多读 1 MiB。任何 3xx、401、验证码、`-2041/-2063`、限流、`-2012`、非 JSON、体积超限或传输失败均停止；重定向的 `Location` 只输出腾讯已知主机布尔及验证/登录路径类别，不输出 URL 或参数。旧凭据 marker 与本次文章 marker 独立，失败后也不自动换请求形状、换凭据或再测同一端点。

公开输出只含 HTTP、可解析业务码、`reviews` 是否为数组及长度、抽样项是否有稳定 ID、书/号身份、时间、URL 字段的计数，和停止类别；不输出标题、文章 URL、正文、ID、Cookie、凭据或原始 body。为了避免取得首屏后重复发请求，私有 runDir 中以新文件原子保存**最小身份投影**：至多前 20 个顶层 `reviews`、总计至多 200 个 `subReviews` 的少量 ID、来源、时间、标题和链接字段；不保存响应正文、图片内容或完整原始响应。投影保存失败只在本地重试，不再联网。`reviews` 为空仅是这次请求条件下的空响应，不能当“目标号没有新文章”；有条目也还不能计入五篇验收，须离线核号身份、稳定 ID、原文发布时间、正文图片及持续更新。

## 离线证据与交付

`--plan` 显示固定 `/book/articles`、目标 bookId、最多一次请求和 1 MiB 上限。`--self-test` 用假网络核旧源码 URL/头、没有 query 凭据、一次请求、私有落盘失败后仅本地重试、评论结构投影不含正文、空数组与缺键的不同分类、验证码及 302 分类。对本机现有私有 runDir 与生产 SQLite 的 `--preflight` 返回 `preflight_ready/networkRequests=0/productionWrites=0`。**`--execute` 尚未运行。**

复审时使用绝对路径执行只读预检；只有总控决定进行这一次线上对照时才加在线标志：

```powershell
node scripts/research/probe-book-articles-skey-first-page.cjs --preflight --db <生产 SQLite 绝对路径> --run-dir <已有私有 runDir 绝对路径>
node scripts/research/probe-book-articles-skey-first-page.cjs --execute --db <生产 SQLite 绝对路径> --run-dir <同一私有 runDir 绝对路径> --approved-online
```
