# Redbook 运行时接入与有限验收

## 本机页面：首次小量检查与正式归档分开

原小红书页面的“本机首次小量检查”入口，仅在 localhost、127.0.0.1 或 ::1 地址可用。先选定已保存的博主主页，再由用户在掩码输入框填写订阅平台访问密码及自己账号的 a1、web_session。订阅平台访问密码是打开 WeWe 的密码，不是小红书验证码。页面不读取浏览器存储或现有 Cookie，不回显秘密，不保存到 localStorage/sessionStorage；提交后清空登录字段。已有访问密码复用到独立实例需要用户明确同意，不能因允许启动实例而自动读取其他配置。

点击“仅保存本机会话”只保存内存会话，不请求平台；诊断最长 24 小时。接下来用户分别确认读取一页列表、选择并确认读取一篇正文。没有分页追赶、自动重试或正式归档。列表仍严格检查 has_more/cursor 和作者归属，正文仍严格检查作者/笔记身份、时间单位与范围、全文及图片 URL 结构。URL 中的作者 ID 在这一步仅是待核验对象，不是可信作者绑定。

图片默认关闭。单独勾选并点击下载时，最多尝试 1 或 2 张，合计最多 1,000,000 字节，CDN 不带账号头；不支持的 AVIF、超限或首个受限响应立即停止。受限/未知结构保留 pending 样本并将共享队列持久暂停，不允许通过新会话、重启、406 换签、HTML 或换端点绕过。样本只在内存中供本机查看，清除 Cookie、令牌、签名字段及嵌入 URL 的查询/片段；关闭页面清空页面内存，后台会话到期清空，用户也可先“撤销并清空”。不写 XhsNote、不建立已验证归档、不自动标记 reviewed=true。

核验后用户填写从原笔记独立取得的全文、全部图片数量、北京时间，并分别确认作者归属、全文、全部图片顺序和发布时间，再明确允许后续正式归档。服务端按原 review contract 校验参考值、绑定证据与已保存主页；这个操作只启用剩余有效期内的正式 source，不发送请求、不刷新。原页面刷新仍必须另行点击，正式扫描最多三页/理论 90 条，增量、重复跳过、补缺及正文保护沿用原实现。成功交接也始终返回 platformVerified:false/liveValidation:pending，不能据此声称真实接口已验证。

新增精确路由均为 POST /local/redbook/diagnostic/{status,session,list,detail,images,sample,review,discard}；只允许真实 loopback socket、严格原始 Host、匹配 Origin、现有应用访问密码，并拒绝任何 Forwarded、`X-Forwarded-*` 或 Via。响应 Cache-Control:no-store。公开部署应拒绝整个 `/local/redbook/*` 前缀。本机页面只发同源 POST，无任意 host/baseURL 注入。

无需提前准备已经审核的真实 API 样本才能执行这个显式小量诊断；诊断不能绕过后续正式归档的人工核验。真实账号/签名/全文/原图仍需用户后续实测。本次仅离线合成验收，无真实 Cookie/API、生产数据库或媒体。

本候选已有固定目标 API/图片 HTTP transport、短期内存会话、安全作者绑定、持久扫描状态和 Nest provider 实际装配。默认没有会话而关闭；有效交接后原小红书页面刷新可以调用来源，**不再是永久休眠骨架**。本次只用合成 HTTP/SQLite 验证，未配置真实账号、未发平台请求，平台接受签名及真实全文/原图仍待有限真实验收。

## 后端私有交接

入口为 `GET /local/redbook/status`、`POST /local/redbook/session`、`POST /local/redbook/revoke`、`POST /local/redbook/resume-operator`。它们要求服务器 socket 的 loopback 对端、loopback Host、完全匹配 Host 的 Origin，以及部署已有的 AUTH_CODE；没有 AUTH_CODE 时拒绝。拒绝 Forwarded、`X-Forwarded-*` 和 Via。部署若有本机反代，必须在代理明确 deny `/local/redbook/*`：应用不能识别删除全部转发头且重写 Host/Origin 的本机代理。PRIVATE_ONLINE_MODE 下同样支持直连本机交接，这些精确路径使用专用上述门禁，其他私有路由继续要求原登录会话。WEWE_ACCEPTANCE_MODE 下交接拒绝。没有新增访问令牌或登录逻辑，新增本机页面仅供用户手动填写，不自动读取浏览器登录信息。

凭据仅保留内存，最长两小时，到期/撤销/关机清空引用并 abort 未完成 HTTP；重启需再次显式交接。撤销可取消正在等待作者查询的交接。活动扫描全部先收到取消，不因另一作者锁失败漏取消；已在提交的当前 SQLite 页可以完成并保留，然后停在检查点，不声称撤销已完成事务。安装/更换会话不重置扫描账本，不清除受限/不确定请求停顿。

先在原页面保存目标的规范公开主页 `https://www.xiaohongshu.com/user/profile/<authorId>`。首次可信绑定来自提交证据，同时核对：本地博主记录主页、显式 authorId、列表 user_id、详情 user_id、笔记身份。只解析 URL 的 ID 不构成可信绑定。

`session` 输入的顶层仅允许：

```json
{
  "cookies": {
    "a1": "<用户安全交接的值>",
    "web_session": "<用户安全交接的值>"
  },
  "expiresAt": "<未来不超过两小时的整数 Unix 毫秒，实际输入须为 number>",
  "bindings": [
    {
      "creatorId": "<原页面保存的本地博主 ID>",
      "authorId": "<经证据核对的上游作者 ID>",
      "profileUrl": "https://www.xiaohongshu.com/user/profile/<authorId>",
      "review": {
        "contract": "redbook-v0.8.2-url-default-v1",
        "reviewedAt": "<最近七日内的整数 Unix 毫秒，实际输入须为 number>",
        "authorIdentityChecked": true,
        "fullTextChecked": true,
        "allImagesChecked": true,
        "publicationTimeChecked": true,
        "noteId": "<列表及详情中同一笔记 ID>",
        "publishedAt": "<独立核对的整数 Unix 秒，实际输入须为 number>",
        "textSha256": "<独立全文参考的 UTF-8 SHA256 小写十六进制>",
        "imageUrlSha256s": ["<按完整图片顺序的规范 URL.href SHA256>"],
        "list": "<脱敏列表 data 对象，实际输入须为 object>",
        "detail": "<脱敏详情 data 对象，实际输入须为 object>"
      }
    }
  ]
}
```

模板占位值不是可运行配置。最多 20 个互不重复的作者绑定，证据和 JSON 大小受限。列表形态为 notes/cursor/has_more，每个 note 有 note_id/user.user_id/xsec_token；证据样本的 xsec_token 可以替换为固定脱敏文字，实际请求 token 由运行列表取得。详情形态为 items[0].id/note_card，须包含相符 note_id/user.user_id、type:normal、整数毫秒 time、title/desc、image_list[].url_default。样本传入系统时只做内存校验；不落盘样本、Cookie、token 或原始 URL，不在响应/日志回显。

四项 checked 是操作者对独立证据的明确审阅声明。必须先人工核对该笔记真实作者、全部正文、全部图片及发表时间，不能从同一个响应数组自己算图数就认为“全部图片已证实”。代码核验样本一致性及参考哈希，不能替人证明外部真实性。状态始终返回 `reviewBasis:operator-supplied-evidence`、`platformVerified:false`、`liveValidation:pending`；安装成功只表示可以进行受控测试，不能声称平台已验证。

如需从本机 PowerShell 交接，先由用户安全准备上述私有文件，放在 ignored `private-data/` 或仓库外，不要把真实值贴到聊天、源码或命令参数。以下只在用户明确批准真实范围后自行执行：

```powershell
$redbookBase = 'http://127.0.0.1:4000' # 改为实际本机端口
$redbookPassword = Read-Host '已有 AUTH_CODE' -AsSecureString
$redbookHeaders = @{ Origin = $redbookBase; Authorization = [pscredential]::new('local', $redbookPassword).GetNetworkCredential().Password }
Invoke-RestMethod "$redbookBase/local/redbook/session" -Method Post -Headers $redbookHeaders -ContentType 'application/json' -InFile '<用户私有交接文件绝对路径>'
# 完成后撤销；不创建访问令牌
Invoke-RestMethod "$redbookBase/local/redbook/revoke" -Method Post -Headers $redbookHeaders -ContentType 'application/json' -Body '{}'
$redbookHeaders.Clear()
```

安装本身零网络、零绑定写库；首次成功页提交由现有缓存事务写入可信作者 ID。原页面 capability/刷新入口自动取同一个 runtime provider，不需重写页面。成功输入后若作者不在交接名单、主页变更、现存作者冲突或会话到期，来源不会发请求。

## HTTP 与扫描边界

API 只允许 edith.xiaohongshu.com 的 GET `/api/sns/web/v2/user_posted` 与 POST `/api/sns/web/v1/feed`，15 秒绝对超时、8MiB 流式上限、JSON 校验、无重定向/代理配置/自动重试/406 换签/HTML 回退。图片只允许 mapper 已列的两个 HTTPS CDN 域名，10 秒/10MB 单图上限，只发送 accept，不携 Cookie、Authorization 或其他账号头；原有 20MB/篇、图数/顺序/容器字节校验继续执行。生产不存在 baseUrl、host、fetch 注入开关。测试只在 spec 中把原生 https.request socket 重新路由到合成本地 HTTP；此桥接没有进入生产模块。

每次手动窗口仍最多三批、每批请求30，理论90；有后续游标而用完预算返回 partial。完整缓存查询先于详情/媒体，SQLite 成功页之后提交持久检查点，账本放在部署 SQLite 同目录 `.redbook-state/`，输入不能指定路径。完成的下次手动窗口从头检查新增。上游限制与不确定请求/提交停顿跨新会话/重启保持，不能靠重新交接恢复。`resume-operator` 仅接受同一当前绑定的可安全继续 operator 检查点；不能恢复受限/不确定请求或超预算页。

## 最小真实闭环

代码已可离线继续至装配/HTTP/数据库/导出闭环。外部剩余条件是：用户安全会话输入、指定作者及真实脱敏证据，确认有限真实请求范围；Node 20.16/22 的实际执行证据也仍未取得（当前运行时 Node24）。首次只测指定作者前少量图文，核对实际正文、图数/顺序/字节并保存；重复刷新新增0且不重复详情媒体；同目录重复保存跳过；删一张测试图片后补齐且手写正文保留。任一限制响应立即停止，不自动重试或切换端点。

这轮未部署/修改生产、未推送 GitHub、未执行远端 CI。只有有限真实验收完成后才能通知用户“实际小红书已通过”；当前可通知“接入代码及合成链路完成，等待安全配置与有限实测”。
