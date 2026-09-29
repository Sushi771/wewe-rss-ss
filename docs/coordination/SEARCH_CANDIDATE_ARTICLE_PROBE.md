# 官方搜索候选：单篇原文身份探针

2026-09-30。总控对 [URL 结构诊断](SEARCH_RESULT_URL_IDENTITY_DIAGNOSTIC.md)只运行了一次隔离 Web init 和一次目标准确号名首屏搜索，两步 HTTP 200。15/15 条 `doc_url` 是原存 HTTP `mp.weixin.qq.com/s?` 查询形，15/15 有 URL `__biz`；其中 11 条来源名精确匹配目标、URL `__biz` 等于目标且 `mid/idx` 为数字。索引 `bizUin` 0 条。11 条按严格门禁保存到本机私有 `search-url-identity-candidates.json`，没有保存 Cookie、完整搜索响应或游标。这 **11 条仍只是搜索索引的身份主张**，没有一篇经原文 `biz/mid/idx/sn/ct` 核验。

## 本轮离线选择

新增 [probe-search-candidate-article.cjs](../../scripts/research/probe-search-candidate-article.cjs)。先用现有 `recoveryGate` 比对本机移动恢复记录、只读生产 SQLite、原始一致性备份和演练副本；再按 `readPrivateRecord` 重验私有 runDir、URL 诊断 marker、候选文件格式与每条原存链接。脚本不把移动 token 用于原文请求，也不读取或发送 Web Cookie。旧数据库 `articles` 仅以 `DatabaseSync({readOnly:true})` 和 `PRAGMA query_only=ON` 读目标号 `id/source_url/verified_source_url`，比较可辨认的 `(mid,idx)`；旧库其余不透明 ID 无法由此排除。2026-09-27 已保存的四份腾讯 `getalbum` JSON 以固定文件名与 SHA-256 核对，再按列表 URL `__biz/mid/idx` 得到已知两合集 **32 个**稳定键。这四份正文不重复 `album_id`，其“两合集”归属来自先前请求与文件来源；SHA-256 防止本次读取时材料被无意换掉。

在总控提供的本次私有 runDir 上，`--preflight` 只读结果：候选 **11**，本机已知尝试标记命中 **1**、未见标记 **10**；不在旧两合集 32 键内 **10**，不在旧库 194 行的**可辨认**键内 **4**，两者均不在 **4**。优先选择未见尝试标记且两者均外、索引时间较后的 **index 3**，公开审核摘要 `30db5616c99296a2`。这个“新键”仅相对已保存两合集与旧库可辨键，**不是新发表文章，也不保证完全不在旧库**。本机已知尝试判据包括旧探针固定摘要、`%TEMP%` 顶层与本次私有 runDir 的 `.attempted` 文件；没有全设备网络历史，不能作绝对“从未请求”的保证。若审查者选择另一个索引，可单独 `--preflight --index N`，每次公开输出至多一个候选摘要。

## 单次原文请求门禁

`--execute` 需审查者明确给索引、该索引预检摘要及 `--reviewed yes`；运行前重新走完整预检。每篇原存 URL 都须再核为 `mp.weixin.qq.com/s?`、唯一目标 `__biz`、数字 `mid/idx`、可选规范十六进制 `sn/chksm`，不接收额外查询参数；不从解码诊断值构造请求。只把原存 `http://` 协议改为 `https://`，保留原查询。候选带的 URL fragment 不会进入 HTTP 请求；脚本不按其值作身份推断。每个原存 URL 的私有 `.attempted` marker 在网络前以 `wx + fsync` 写入，同一 URL 不自动重试；候选索引可在**另一次人工审查**后选择其他 URL，脚本无自动循环/分页。

原文请求是匿名 `https.request`：不带 Cookie、移动 token、Web 凭据或授权头，`agent:false`，拒绝代理与调试环境变量，12 秒超时，最多接收 6 MiB HTML。Node 请求不会自动跟随 3xx；遇 HTTP 401/403/429、3xx、验证码或限制页立即停，不重发。3xx 的 `Location` **只在内存中分类**腾讯域布尔、同文章域布尔、`/s` 长/短或验证/其他路径、是否 HTTPS 与是否带常见认证参数；不输出、不保存跳转 URL 或参数，也不跟随。HTTP 200 且严格 `#js_content` 后，用当前构建的 `articleIdentity/articlePublishTime/articleContentHtml` 分别核原文账号、`mid/idx`、URL 有 `sn` 时的 `sn`、`og:url` 短 canonical、字面 `var ct` 与解析时间一致、非空正文、原始 `img/data-src` 与清洗后图片数。索引 `timestamp` 仅作与原文 `ct` 的布尔对照，绝不替代发表时间。任一阶段不闭环即停止；只输出受控状态、布尔/计数及一个摘要，无标题、原始 URL、完整 ID、`ct` 数值、HTML、Cookie 或私有路径。生产库写入始终为零。

```powershell
node scripts/research/probe-search-candidate-article.cjs --plan
node scripts/research/probe-search-candidate-article.cjs --self-test --parser <ABSOLUTE_BUILT_ARTICLE_PAGE_JS>
node scripts/research/probe-search-candidate-article.cjs --preflight --db <ABSOLUTE_PRODUCTION_DB> --run-dir <ABSOLUTE_PRIVATE_REFRESH_RUN_DIR> --album-dir <ABSOLUTE_SAVED_ALBUM_JSON_DIR> --parser <ABSOLUTE_BUILT_ARTICLE_PAGE_JS>
# 下面仅展示审查所需形状；本线没有执行线上请求。
node scripts/research/probe-search-candidate-article.cjs --execute --db <ABSOLUTE_PRODUCTION_DB> --run-dir <ABSOLUTE_PRIVATE_REFRESH_RUN_DIR> --album-dir <ABSOLUTE_SAVED_ALBUM_JSON_DIR> --parser <ABSOLUTE_BUILT_ARTICLE_PAGE_JS> --index 3 --digest 30db5616c99296a2 --reviewed yes
```

本轮 `node --check`、`--plan`、假网络 `--self-test` 和**真实私有候选的离线 `--preflight`**通过。在线原文请求 **0**，生产 SQLite 写入 **0**。首次真实原文验证及后续每篇选择均待总控复审；尚无五篇真实不同目标文章，不能接入 Provider 或宣称订阅恢复。

## 总控唯一一次在线执行

总控合入脚本后复跑 `--plan`、假网络 `--self-test` 与真实私有材料的 `--preflight --index 3`，后者仍为 11 个候选、10 个无已知尝试标记，index 3 摘要仍为 `30db5616c99296a2`，不在已保存两合集及旧库可辨认键内。随后按审查标志仅对这一个原存 URL 作一次匿名 HTTPS GET，返回 HTTP 200，`#js_content` 存在；当前解析器取得的 `biz/mid/idx` 与候选一致，但 `sn` **不一致**，因此脚本在身份门禁处返回 `stop_identity_mismatch`。此次没有进一步解析原文 `ct`、正文或图片，也没有保存页面 HTML；私有单 URL 哨兵已落盘，同 URL 不重发。这个结果只排除**该候选 URL 按四字段精确匹配的本次验证**，不能说明搜索索引所有候选错误，更不能把该页计为目标真实文章。其余未请求候选须先审查差异和下一次门禁。生产 SQLite 写入仍为零。
