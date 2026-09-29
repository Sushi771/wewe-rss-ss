# 官方搜索 `sn` 与原文不符：离线差异分析

2026-09-30。本文仅使用本机已存的腾讯静态 JS、2026-09-27 旧原文与合集 JSON、只读旧库、当前私有搜索候选的脱敏字段，以及总控已完成的两次单篇结果；本线没有新增网络请求。**index 3 未通过原文身份验收，index 1 也未取得可核原文。**

## 两个已试候选能说明什么

- 总控对当前搜索候选 **index 3** 的原存腾讯长链仅把 HTTP 改成 HTTPS，匿名请求一次，得到 HTTP 200、严格 `#js_content`；当前构建的 [`articleIdentity`](../../apps/server/src/collection/article-page.ts) 解析后，页面 `biz/mid/idx` 与搜索 URL 一致，`snMatch=false`，于是 [`probe-search-candidate-article.cjs`](../../scripts/research/probe-search-candidate-article.cjs)立即 `stop_identity_mismatch`。未保存原 HTML，未继续查短 canonical、字面 `ct`、正文或图片；私有每 URL marker 已在。**不能把这篇计为目标真文章，也不能重发同 URL 追补字段。**
- 为区分新候选个例与旧文对照，总控随后只对不同的 **index 1** 发一次相同匿名 HTTPS 请求。该候选在先前腾讯官方合集 JSON 与旧库 URL 中有一致的 `__biz/mid/idx/sn`；搜索 URL 的这四字段也相同。结果是 HTTP **302**，`Location` 仅脱敏分类为腾讯同域 `verification_or_login`，未跟随、未保存跳转目标；该候选 marker 已在。它没有进入当前页 `sn` 对照，不能支持“旧文当前 `sn` 相同”或“所有搜索链接 `sn` 都不符”。**按验证码/登录限制停止这条公开原文请求路线的后续在线尝试，不用其余未请求索引继续试探。**

## 对当前解析器与历史材料的具体核对

[`articleIdentity`](../../apps/server/src/collection/article-page.ts)在第 104–145 行先找 HTML 中第一个匹配的 `var biz/mid/idx/sn`；再通过 `cgiDataNewField` 从 `window.cgiDataNew` 对象读对应字段。两边均存在且不一致时 `choose` 会抛错；成功返回时至少没有这两种**已读取值**的显式冲突。随后函数以这些值构造腾讯 `/s?__biz,mid,idx,sn` 规范 URL。`cgiDataNewField` 会定位并平衡解析该对象，但旧 `value('sn', ...)` 使用 `html.match`，没有限定脚本块或检查多个 `var sn`。因此 index 3 的 `snMatch=false` 精确表示**解析器所选页面 `sn` 与搜索 URL `sn` 不同**；没有原 HTML 就不知道页面究竟含旧字段、现代字段、多个同名赋值还是其他模板变化，也不能据此断言腾讯已轮换 `sn` 或搜索索引出错。

用当前已构建解析器做三种**纯假 HTML**离线试验：两个 `var sn` 时成功并选第一个；旧 `var sn` 与 `cgiDataNew.sn` 不同时抛错；只有 `cgiDataNew.sn` 时成功并选现代字段。这个试验确认了代码分支行为，不说明 index 3 的真实页面属于哪一种，且没有重现其响应。

把当前**已构建**解析器离线用于八份 2026-09-27 已核目标原文：8/8 可解析；每份与四份旧腾讯合集 JSON 的同条 `(mid,idx)` 都唯一匹配，解析 `sn` 与列表 URL **8/8 相同**。八份 HTML 均恰一条符合旧 `var sn` 模式；其中三份在 `cgiDataNew` 附近还出现 `sn` 字段模式，但本次没有对该现代字段单独取值比较。这证明解析器及四字段比较规则在旧页面上并非普遍错误，**不证明它对 index 3 当天的未保存 HTML 解析无误**。

当前私有首屏 11 候选中，按 `(mid,idx)` 有旧库可比长链接的 **7** 条，其搜索 URL `sn` 与各自旧库长链接均一致；其中 index 1 还与旧官方合集 URL `sn` 一致。index 1 搜索 URL 的 `chksm` 与旧合集 URL 不同，而 `__biz/mid/idx/sn` 相同；旧库两条可比 URL 不带 `chksm`。这说明至少此例的 `chksm` **不能拿来当跨来源稳定文章键**，也没有证据证明 `chksm` 差异造成 index 3 的结果。index 3 不在旧两合集和旧库可辨键内，没有既存同篇 `sn` 对照；旧库存在不透明文章 ID，不能由“可辨键外”推成数据库全新文章。

## 腾讯静态客户端代码支持的上限

本机保存的腾讯搜一搜 [`read_search.fc739bbf.js`](https://search.wxqcloud.qq.com/t/searchweb/search/weixin-search-outlinks/26090701/js/read_search.fc739bbf.js)，SHA-256 `e5e090ee6b6180de2ed72ee3eeebdcdab9a10c5c0f5c95f442fd7940730f7089`，字符偏移约 **47,720–48,950**：按 `doc_url.includes("mp.weixin.qq.com")` 识别公众号项，PC 端 `window.open(r.doc_url, "_blank")`，其他客户端把同一个 `doc_url` 编码给 `weread://mp?url=`；这里没有解析或修正 URL 中的 `sn`。这使搜索 `doc_url` 成为第一方客户端的**导航链接**，但不是 `sn` 与当前原文身份一致的证明。

本机保存的腾讯文章脚本 `wewe-appmsg-muihhh087c466445-20260930.js`，SHA-256 `97ef18b57ed7a313da9be9857f401514f8f73adff05fa92c5f6f161dc0905cd1`，字符偏移约 **87,218–87,300** 用 `window.biz/mid/idx/sn` 拼当前页文章链接，约 **104,868–105,160** 将 `this.cgiData.sn` 传入打赏/付费链接，约 **257,240–258,500** 将 `window.sn` 或页面 URL 中 `sign` 用于音频详情链接，约 **268,940** 给页面交互数据提供 `sn`。这些是真实客户端对**已进入页面的 `sn`** 的使用点；静态脚本没有给出服务端如何生成、轮换 `sn`，也没有证明搜索索引 `sn` 必须与页面字段恒等。

因此，index 3 的不符至少还可能是搜索索引链接过期/异版、当前页面字段与旧 URL 参数语义不同，或当前模板触发解析器选错 `sn`；这些均是待验证假设，**不能选一项当结论**。URL fragment 本来不随 HTTP 请求发送；本次探针未解码或重写查询参数，仅将原存 HTTP 协议升级到 HTTPS。index 1 的 302 只证明该文章、该时点、该匿名请求形状被导向登录/验证，不反推 index 3 不符的原因。

## 后续可执行工作与停止边界

继续做**离线**工作：审当前解析器的多个 `var sn`/现代字段模板边界；用本机已保存页面做不同模板的假响应自测；在其他合法取得的新页面或本人正常完成官方验证后，再独立复审是否有可验证的新来源。若未来允许验证**不同 URL**，探针应在内存中分开输出 `legacySnPresent/Matches`、`cgiDataNewSnPresent/Matches`、`parserSnMatches`、短 canonical、字面 `ct` 的布尔结果；身份不符仍立即停，不输出值或 HTML。现有 index 3 的响应已丢失，不能离线补齐；index 1 触发验证/登录，**当前不对 index 5/7/10 等未请求候选继续匿名 GET，不重发 index 1/3，不跟随其 302**。这条官方搜索来源的五篇不同文章原文闭环验收仍为零，订阅 Provider 尚不能接入。
