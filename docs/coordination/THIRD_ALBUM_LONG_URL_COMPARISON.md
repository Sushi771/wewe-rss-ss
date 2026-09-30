# 第三合集签名长链接与已试原文请求对照（2026-09-30）

本轮只读、网络请求 **0**，未读取凭据或输出完整文章 URL。审计材料为已提交的探针源码与脱敏运行记录，以及持久私有目录中的搜索候选文件：只统计其 **11** 项中已请求的 index 1、3 的查询字段存在性，不打印字段值。第三合集六份私有最小页账本与来源文件目前均不在本机；下表**没有**把其他合集或搜索的请求冒充第三合集 54 项的原文请求。

## 七次可定位的当前长链接 GET

| 来源与脱敏摘要 | 实际请求的公开查询形状 | 请求上下文 | 已记录结果 |
| --- | --- | --- | --- |
| 旧官方合集未缓存条目 `e28e53cb45b7c1eb` | 列表 `item.url` 含 `__biz/mid/idx/sn/chksm`；原 `http` 升为 HTTPS、fragment 移除，查询字段保留 | 匿名、浏览器 UA、腾讯同源 Referer/Origin | **200**，有正文节点及可解析 `ct`；当时简化 `var biz/mid/idx` 比较未闭环，原响应未保存 |
| 旧官方合集另一条目 `792e0623ba3ee739` | 同样带 `chksm`，仅升 HTTPS、移除 fragment | 匿名、Chrome 120 UA、同源 Referer | **200**，正文节点存在；解析身份与列表四字段至少一项不合，具体字段未留，原响应未保存 |
| 旧官方合集已核旧文对照 `8c460d508c0aae1b` | 带 `chksm`，脚本将列表 URL 规范为 HTTPS 并清除 fragment | 匿名、Chrome 120 UA、同源 Referer | **200**，正文节点存在；合并的解析/规范化/时间步骤 `parser_stop`，未保存当前响应 |
| 旧库已核长链 `5e44e0d46c308fe2` | 只有 `__biz/mid/idx/sn`，**无 `chksm`** | 匿名、Chrome 120 UA；无 Referer/Origin | **302** 后停止，未读取跳转目标；同篇后来使用原存官方**短路径**另得 200、四字段/`ct`/正文闭环，不能拿短路径结果追认长请求 |
| 旧正文互链 `1c9ac9e993100643` | `__biz/mid/idx/sn/scene`，**无 `chksm`**；fragment 移除 | 匿名、Chrome 120 UA、同源 Referer | **302** 后停止，未保存跳转目标 |
| 微信读书搜索私存候选 index 3 | 原存 `http` 长查询含 `__biz/mid/idx/sn/chksm`，只升 HTTPS；不是合集 `item.url` | 匿名、Chrome 131 UA；无 Referer/Origin，不传 WeRead Cookie/token | **200**，正文节点存在，页面解析的 `biz/mid/idx` 一致而 `sn` 不同；在身份门禁停止，未验 `ct` 或保存 HTML |
| 微信读书搜索私存候选 index 1 | 同样含 `__biz/mid/idx/sn/chksm`，只升 HTTPS；历史报告证明其与旧库及已知合集条目**四字段**相同，不证明 `chksm` 或整串 URL 相同 | 与 index 3 相同的匿名 Chrome 131 请求 | **302**，跳转只在内存归类为腾讯同域验证/登录路径；未跟随，已停止该公开原文路线 |

计数：**7** 次长查询 GET；**5** 次请求自带来源给出的 `chksm`（4 次 HTTP 200、1 次 302），**2** 次没有 `chksm`（均 302）。其中从**旧官方合集 `item.url`** 提取并保留五个查询字段的请求为 **3** 次，均得 200，但均未完成当次原文身份/时间/正文图片闭环。搜索的 **2** 次有 `chksm`，却来自搜索 `doc_url`，不能算“官方合集原样 URL”。第三合集 **54 项实际原文 GET 为 0**。2026-09-27 已存旧原文的取得过程缺少可对照本轮的完整请求账本，未混入以上七次。

这里的“合集链接请求”指**列表原值派生**，并非字节原样请求：脚本对旧 `http` 链接升 HTTPS，移除不进入 HTTP 的 fragment，`URL` 对象可能规范化序列化；查询的 `chksm` 没有被猜造或替换。两次无 `chksm` 的 302 与这三次 200 是不同文章、不同来源；不能据此推断 `chksm` 是状态差异的原因。搜索 index 1 的 302 也不能推出第三合集带 `chksm` 的链接失败，因为它不是第三合集列表原值、完整查询一致性未证且已明确遇验证。**“带 `chksm` 的列表原样链接也已试失败”不成立**：有过三个旧合集签名查询的 200 和后续解析止步，第三合集 54 项没有原文请求。

源码与结果定位：[`public-article-one-shot.cjs`](../../scripts/collection-source-probe/public-article-one-shot.cjs) 的 `fieldsFromUrl/loadSeed/fetchOnce`、[`public-article-reference-control.cjs`](../../scripts/collection-source-probe/public-article-reference-control.cjs) 的 `officialArticleUrl/loadReferences/fetchOnce`；[`probe-verified-article-seed.cjs`](../../scripts/research/probe-verified-article-seed.cjs) 的 `officialSeed`（严格四参数）与 `fetchOnce`；[`public-interlink-one-shot.cjs`](../../scripts/collection-source-probe/public-interlink-one-shot.cjs) 的 `articleUrl/fetchOnce`；[`probe-search-candidate-article.cjs`](../../scripts/research/probe-search-candidate-article.cjs) 的 `candidateSeed/fetchOnce`。旧合集四次与互链结果见 [`PUBLIC_PAGE_DISCOVERY.md`](PUBLIC_PAGE_DISCOVERY.md) 的原文请求及“长链 302 后的请求形状对照”；搜索两次见 [`SEARCH_CANDIDATE_ARTICLE_PROBE.md`](SEARCH_CANDIDATE_ARTICLE_PROBE.md)；短路径与第三合集边界见 [`THIRD_ALBUM_ARTICLE_LINK_SHAPE.md`](THIRD_ALBUM_ARTICLE_LINK_SHAPE.md)。

## 是否存在尚可验证的不同形状

**存在未对第三合集验证的明确形状**：官方 `getalbum` 当前返回的**某一条原生 `item.url` 五查询字段**，与旧库四参数、正文互链加 `scene`、搜索索引 `doc_url` 来源不同。它的接口返回与 54 项校验在历史上成立，但当时只存了 `msgid/itemidx/createTime/sn/chksm`，没有留完整原始 `item.url`；这些字段不能安全重建原值、参数顺序、协议或 fragment。现有第三合集精确 ID 和六页文件亦已丢失。**现在没有可放行的具体第三合集 URL**，不能拼出 `chksm` 或重发已试文章补材料。

恢复单条可审 URL 的前提：从新的合法一手材料独立取得**精确**同号官方合集入口（例如另一篇未请求、已核目标旧文当前页面中静态声明的同号合集标签，或用户正常获得的官方链接），先审历史请求集合与访问限制；随后只对明确链接做经复审的一次低频 `getalbum` 首屏。响应须 HTTP 200、`ret=0`、目标 `__biz` 与精确合集 ID 相符、逐项 `msgid/itemidx` 等于 `item.url` 的 `mid/idx`，`sn/chksm` 唯一有效；若该合集不是原第三合集，不称“恢复 54 项”。在 Git 忽略的持久私有目录以有界、不可覆盖、同步落盘方式保存**原始响应及其哈希**和脱敏请求账本，禁提交标题、URL、ID、凭据与原文。若来源页面或 `getalbum` 遇 3xx、验证、403/429、身份冲突或响应异常，停止对应网络路线。

只有从这份**新保存的精确响应**选出一条与私有历史已试集合严格排重、目标身份可核的不同文章，才可设计单次原文 Probe：私有排他哨兵先于请求，禁代理、Cookie、自动跳转、重试，HTTPS，12 秒及 6 MiB 界限；保留返回的五字段查询原值，不追加或猜测参数。若原值为 HTTP，须明确记录“仅升 HTTPS”的变换，不能称字节原样。3xx/验证/限频立即停，绝不继续搜索候选 index 1 的已停形状；若 200 且非验证页，先把有界 HTML 私存，再分阶段核字面/解析的 `biz/mid/idx/sn`、短 canonical、字面 `ct`、严格正文与图片 `data-src`，报告各字段是否存在与是否相符而不输出值。这样的首次问题仅是“这条新列表原文现在返回什么”；五篇、分页外覆盖和持续订阅另验。
