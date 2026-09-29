# `/book/articles` 无显式认证头首屏探针

## 依据与区别

旧 WeBook 用调用者提供的 `skey/vid` 自定义头访问 `GET https://i.weread.qq.com/book/articles`，但没有登录实现。另一条独立历史请求形状来自 [wereader 固定提交的真实发送行](https://github.com/Higurashi-kagome/wereader/blob/a27b604dd7753734a27a47f341dbebbc6aef8917/src/worker/worker-popup.ts#L331-L348)：浏览器扩展后台直接 `fetch(...?bookId=MP_WXS_*&count=10&offset=0)`，未设置自定义头或 `credentials: include`。该代码的存在和历史公众号显示反馈不证明 2026 年仍可匿名取文；它仅提供一个与旧 `/mp/chapters`、带头 WeBook 和 Web 搜索均不同的、可审查的最小问题：**当前首屏究竟返回什么？**

[`probe-anonymous-book-articles.cjs`](../../scripts/research/probe-anonymous-book-articles.cjs)对目标 `MP_WXS_3895431412` 使用这个固定 URL，Node HTTPS 直连、无 Cookie/token/自定义鉴权头；仅附普通浏览器 UA 与 `Accept: */*`。它不运行浏览器扩展，不能模拟其完整运行环境或推断服务端对所有客户端的行为。匿名失败只排除本次请求条件，不能排除合法登录的 `skey/vid` 路线。

## 门禁与输出

- `--plan` 和 `--self-test` 均零网络；自检覆盖可判读列表、`-2012`、302、验证页与无列表五种形状。
- 在线只允许显式 `--execute --approved-online`，固定目标、首屏 `count=10&offset=0`，一次 GET，12 秒超时，512 KiB 响应上限；不跟随 3xx，不刷新、重试、翻页或请求原文。存在代理/调试环境变量即不发送。
- 发送前在系统私有临时目录用独占创建写入该固定 URL 的已尝试标记；即使超时也禁止同脚本重发。响应仅在内存解析，输出 HTTP、受控业务码、`reviews` 存在与计数、`reviewId/mpInfo/synckey` 字段计数，不输出目标文章、账号、URL、正文、原始 JSON 或 Cookie。
- 401/403、302、429、验证/限流提示、业务拒绝或响应超限均停止。若出现 `reviews`，也仅说明首屏结构；后续必须逐篇核至少五个真实不同目标文章的号身份、稳定 ID、原文发表时间，再验分页、正文、图片和持续增量，不写生产库。

本探针只读腾讯公开客户端路径，不访问 SQLite，也不使用第三方闭源服务。

## 2026-09-30 单次在线结果

离线 `--plan` 显示标记不存在，五项 `--self-test` 通过。按上述边界只执行一次 `--execute --approved-online`，脱敏结果为：

```json
{
  "requestCount": 1,
  "http": 401,
  "type": "json",
  "decision": "stop_authentication_rejected"
}
```

脚本未读取或输出 401 响应正文，故没有业务码、`reviews`、文章身份、时间或图片可核。请求前已写私有已试标记；事后 `--plan` 确认 `attempted=true`。未重发、未翻页、未请求原文、未读写 SQLite。

这只排除**本机 Node HTTPS、无凭据、普通浏览器 UA、固定首屏参数**在该时点直接取得列表；不能推成所有浏览器扩展上下文或合法 `skey/vid` 认证都返回 401。旧源码无凭据形状目前不足以接 Provider，后续仍追可审查的正常认证来源。
