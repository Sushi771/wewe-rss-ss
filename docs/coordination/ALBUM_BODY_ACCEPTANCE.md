# 官方合集正文与图片真实验收（2026-09-30）

本轮只沿已核验目标号“妈妈部落畅聊阁”的官方“复旦数学营”合集执行正文闭环，没有重新开启微信读书、搜狗、Mac/iOS 或其他来源研究。**该合集 19 篇不代表公众号全部历史。**

## 当前真实结果

- 当前匿名官方 JSON 两页共 **19 个不同文章键**，每页 HTTP 200、顶层 `base_resp.ret=0`、`verify_status=0`；本次两页键集合 SHA-256 为 `22fd9c1653c5f4eb2c41b7482f9ac6e82d42e649f20e70dbebf2d9570952625d`，与之前已核验集合一致。分页游标来自当前响应，原样 JSON 这次持久保存。
- **11 篇当前真实原文 GET** 均 HTTP 200，真实 `js_content`、`biz/mid/idx/sn` 和原文发布时间通过。涵盖旧库缺正文的全部 8 篇（当前列表下标 5–11、18），以及下标 2、3、4 的首轮样本。没有重取已知失败下标 0、1、16，也没有遍历其他已有正文文章。
- 7 篇含图片、4 篇无图，共 **11 张图片，11 个不同图片字节 SHA-256**。使用现有 `archiveProviderImages` 真正完整下载并写成内联图片；逐张通过 `decodeInlineImage` 类型、完整容器与长度校验，未用部分 Range 响应替代完整图片。本地 HTML、原字节摘要均持久保存。
- 原文发布时间与合集 `create_time` 差值 **0–45 秒**；两种时间明确分开，正文身份使用实际 `biz/mid/idx/sn`，不以时间近似替代身份。
- 来源原文查询参数只有 `__biz/mid/idx/sn/chksm`；正式请求应保留来源中的 `chksm`，稳定文章身份仍使用 canonical `biz/mid/idx`。本轮没有 Cookie、Key、登录、重试、重定向、系统代理变更或生产写库。

首个当前原文初次解析时，旧解析器没有读到 `var sn = "" || "签名值" || ""` 的非空字面量。原文正文与其余身份字段已取得，问题是本地解析缺口。仅对已存 HTML 诊断，保留原停止记录；修正解析器后，**11 篇全部通过 B 正式构建的 `articleIdentity` 离线回归**，没有再次请求该原文。该问题不能描述为腾讯验证码或身份冲突。

最初恢复入口时另一已知官方合集得到 13 条/2 页，账号匹配但标题不是“复旦数学营”；该次原样响应另存私有目录，未请求正文。随后改用另一个已有明确证据的合集入口并核实标题，主线输入仅使用当前 19 条 manifest，不猜测丢失的第三合集 ID。

## 可复核材料与命令

原始 JSON、HTML、URL、文章标题、完整身份和图片均只存主仓 Git 忽略目录 `private-data/album-acceptance-20260930/`，没有提交。这是持久目录，不能再以临时目录充当长期账本。

`manifest.json` 字段为 `{ observedAt, mpId, biz, albumId, run, items }`；`items` 保留当前官方 `article_list` 原项，`run` 指向本次原样 `page-1.json/page-2.json`。每篇以身份 SHA-256 前 16 位为目录，包含 `original.html`、`sanitized.html`、`localized.html`、`evidence.json`、`images.json`。图片实际字节在 `localized.html` 的 data URI 中，`images.json` 保存正文/本地化 HTML/逐图 SHA-256，可通过现有解码器重新提取并复核。

脚本不连接 SQLite；需要参数指向**主仓根目录**（私有证据存放位置）和**当前已构建的 server 根目录**。合入并构建后，在 PowerShell 从仓库根目录运行下面的离线核验：

```powershell
$projectRoot = (Get-Location).Path
node scripts/album-acceptance-body.cjs verify $projectRoot "$projectRoot/apps/server"
```

本次实际使用 B 独立 worktree 的正式构建运行 `verify`，输出 `requests=0, articles=11, images=11, distinctImageByteHashes=11, ctDeltaMin=0, ctDeltaMax=45`。脚本 `list` 模式才重新请求该已知合集；`body` 模式需要明确当前列表下标；`inspect` 仅对持久 HTML 做离线解析；`images` 模式优先使用对应正文 SHA-256 的完整内联缓存，缺缓存才下载。网络/验证/身份/图片错误留私有停止记录，拒绝后续网络操作；历史失败身份另有静态门禁。

## 仍需由正式闭环完成的验收

这次证明了当前列表、至少五篇当前真实原文、全部旧库缺正文条目以及若干含图文章的完整图片本地化。旧库其余 8 篇已有正文未在本轮重新在线获取；自然新文章未出现，不能声明已观察到真实新增。SQLite 一致性副本、旧字段保护、正式 Provider 两次执行/重启、手动更新、定时更新及 RSS/Markdown/Obsidian/ZIP 由其他工程单元验收。当前列表与旧集合相同，新增为 0 是真实来源状态，不是订阅功能已全部恢复的声明。
