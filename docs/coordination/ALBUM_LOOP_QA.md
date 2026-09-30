# 当前官方合集闭环 QA（2026-09-30）

范围：妈妈部落畅聊阁当前已恢复精确身份的一个官方合集。19 个不同文章身份、2 页，不代表公众号全史；之前第三合集 54 键的旧临时证据不能用于本次验收。

## 已实测的保护起点

生产 `apps/server/data/wewe-rss.db` 仅以 SQLite 只读连接检查：1 个账号、12 个订阅、1447 篇文章，`quick_check=ok`、外键检查无异常。SQLite 在线一致性备份经 `integrity_check=ok` 与文件 SHA256 复核，账号/订阅/文章逐字段与源基线相等；源前后逐字段完全不变。证据持久保存在 Git 忽略的 `private-data/album-loop-qa/baseline-efb27dc1/`，不是 TEMP。

19 个当前合集身份均与旧库行对应：11 篇已有正文，8 篇缺正文（官方列表索引 5–11、18）。因此首次正式导入新增 0 是合理结果；应补齐的是这 8 篇正文与图片。旧正文保留，不为采集流程重发其历史失败原文。

A 当日真实输入已经私存：2 页官方 JSON、11 篇当前原样 HTML、11 张完整图片字节（其中包括全部 8 篇缺正文的输入）。QA 私有转换脚本复核原文 SHA256，从净化 HTML 图片顺序与本地化 data URI 对应提取已获字节，再用正式图片容器检查器校验。当前有效精确请求 cassette 在 `private-data/album-loop-qa/cassette-a524252e-a9d4-4e8a-94b4-9018feeab87e/manifest.json`；早期 `cassette-a082…` 把列表 HTTP 链接直接当实际 HTTPS 请求，已排除，不再使用。

## Review 与当前验收状态

- 已推动 Provider 缓存可用数逐图调用 `decodeInlineImage`。仅 `data:` 前缀会将坏 MIME 或截断字节误报完整；现在坏缓存不改旧正文，只如实报告缺口。
- 真实原文的 canonical 为 HTTPS `/s?…` 完整身份链接，已定位并推动修复原先只接受短 canonical 的门禁。现在 canonical-ID 行可精确核完整 biz/mid/idx/sn；旧短 ID 继续核短 canonical 与旧 ID 一致，没有放宽身份、标题或已有可信 ct。先前失败副本的 1447 个旧 ID、正文、图片引用、全部指标与合集绑定全部不变，failed 状态正确记录，见 `97286508-de1f-468c-854d-7d77f8f58499/failure-protection.json`。
- 仅对无正文/无 verified 来源的 canonical-ID 行，当旧时间恰等当前合集列表时间、当前原文核验成功、ct 偏差不超过 60 秒，才将未可信列表时间校正为真实 ct。QA 从保存的原样 HTML 独立解析 literal ct 与官方列表对照，仅接受该白名单；已有正文或已有 verified 的可信时间保持逐字段相等。
- QA 保护断言 self-test 共 15 个破坏案例通过，包含错误 ct 白名单、改已有可信 ct、改已有缓存 ct、重复校正等；其余旧 ID、正文、封面、0 阅读、metrics 与账号保护亦通过。这是测试器测试，独立于以下真实订阅输入验收。

## 正式 Provider 与服务实测结果

`private-data/album-loop-qa/ffbaf16d-2d9f-411d-974c-9d71aecf2ee5/result.json` 是当前真实输入的禁网回放：正式 Provider 2 页/19 条，首次新增 0、补正文 8、内联完整图片 6 张，校正未可信列表时间 5 条；第二次手动与 scheduled 入口各新增 0/更新 0/正文请求 0。1447 个旧 ID 无丢失，旧正文/封面/指标/账号与可信时间没有损坏，生产源全表基线完全不变。

同 run 的 `http-5ad18e90-21b5-4cf7-b351-e99609848771/result.json` 是**实际 Nest HTTP 服务**两次启动/退出重启验收，仅使用另建的 19 篇 scope 副本。两次匿名 POST 均 401、私人登录成功、授权 `feed.refreshArticles` 均 200/新增 0、RSS 200、真实 ZIP 下载 200；服务更新后旧文章字段严格相等。上游只回放真实输入，禁外网报告定期落盘、关停后确认存在，不依赖 Windows 强杀时不可靠的 exit hook。

`private-data/album-loop-qa/031ae03c-6db2-4e0a-b9a3-8fc7d59e7a01/result.json` 则是一次**真实联网正式 Provider**完整 SQLite 副本采集：2 次列表、8 次缺正文原文、6 次图片，共 16 请求全部 HTTP 200；新增 0、补正文 8、有限 ct 校正 5，原 1447 篇与所有旧可信字段保护通过，生产未写。当前真实列表/HTML/图片字节与逐请求清单在同目录 `live-inputs/` 持久保存。没有重发 cached 11 篇原文或历史失败原文。后续第二次与 scheduled 检查是离线回放，不混称为多次真实联网更新。

初轮 19 篇 scope 导出有 7 篇缺旧远程图片字节；已由原样旧正文提取 33 个引用、27 个不同精确腾讯 CDN URL，并留 bodyHash 到 `legacy-image-input.json`。A 仅对这 27 图各真实 GET 一次，5,106,897 字节全部完整签名通过，没有重复原文，没有改旧正文。图片原字节清单持久在 `private-data/album-acceptance-20260930/legacy-images/manifest.json`。

最终完整输入 cassette 为 `private-data/album-loop-qa/cassette-ae20c65a-6a7a-4124-8b33-f18b1350738f/manifest.json`（2 页、11 当前原样 HTML、38 不同实际图片字节）。以真正在线成功副本另建的 scope19 做完整禁网验收，结果在 `031ae03c-6db2-4e0a-b9a3-8fc7d59e7a01/complete-exports/exports.json`：

| 检查                                    | 结果                             |
| --------------------------------------- | -------------------------------- |
| RSS / 浏览器 Markdown 有正文            | 19 / 19                          |
| Obsidian 完整                           | 19 / 19                          |
| ZIP 正文与图片完整 / 未完整             | 19 / 0                           |
| 附件实际字节对 inline 或当前 CDN SHA256 | 44 / 44                          |
| 实际 ZIP                                | 64 文件、44 附件、9,493,715 字节 |
| ZIP CRC / staged 逐文件字节             | 通过 / 全部相等                  |
| 缺 cassette 请求 / 实际外网             | 0 / 禁用                         |

同 run 的 `http-c7555846-512e-448e-bc02-0951654dbb97/result.json` 再次验证真正 Nest HTTP 服务启动与退出重启：两次匿名手动更新 401、授权更新 200/新增 0、RSS 200、完整 ZIP 下载 200（均 9,493,715 字节），19 篇旧文章字段严格无变化。每次 2 页及 38 图均为保存的真实输入回放，缺请求 0，禁外网报告已落盘；不能据此声称两次均向腾讯联网。

这些结果证明正式 Provider 在一致性副本上可工作，尚未在生产库启用合集、实际持续运行或等待到自然新文章，不能宣布真实订阅恢复完成。

## 可执行验收命令

需要 Node 24（`node:sqlite`）、Python 和已构建 server；`runtime-root` 指向总控 main。所有副本、日志、cassette、原文和导出只写该目录下 Git 忽略的 `private-data/album-loop-qa/`。无需真实登录凭据。

```powershell
$repo = 'C:/Users/ss/.gemini/antigravity/playground/sparse-comet/wewe-rss-ss'
$cassette = "$repo/private-data/album-loop-qa/cassette-ae20c65a-6a7a-4124-8b33-f18b1350738f/manifest.json"
node scripts/album-acceptance-rehearsal.cjs --database "$repo/apps/server/data/wewe-rss.db" --manifest $cassette --runtime-root $repo
```

脚本先只读备份，再迁移新副本，调用正式 Provider/Trpc 入口首次导入；在新 Node 进程执行第二次手动入口与 scheduled 入口，断言新增为 0、旧逐字段保护和账号不变。它只证明真实输入的持久化回放；独立 Node 进程不能称作 HTTP 服务重启。

成功后脚本另建导出 scope 副本，**只在这个新副本**过滤目标公众号中合集外文章；原 1447 篇演练副本和生产均不删。RSS/浏览器 Markdown/Obsidian/真实 ZIP 控制器会报告完整与不完整数量，ZIP 同 CRC 及 staged 文件逐字节比对。图片缺字节时禁止实际联网并诚实报缺口，不以 19 篇名单代替全部图片验收。

```powershell
# 用上个结果中的 export-scope.db：真正 Nest HTTP 启动、登录、401 权限、更新、ZIP，再退出重启。
node scripts/album-service-acceptance.cjs --copy "$repo/private-data/album-loop-qa/<run>/export-scope.db" --manifest $cassette --runtime-root $repo
# 回放/保护通过后，仅首次更新以真实网络正式 Provider 对一个新的完整副本采集：
node scripts/album-acceptance-rehearsal.cjs --database "$repo/apps/server/data/wewe-rss.db" --manifest $cassette --runtime-root $repo --live
```

HTTP 服务仅监听随机 `127.0.0.1` 端口，使用随机授权码与不含 `.env` 的新 launch 目录，定时采集关闭。认证后的实际接口是 `POST /trpc/feed.refreshArticles`。HTTP 启动/重启是真实服务工程验收，上游仍为当前真实响应离线回放。`--live` 仅首次 Provider 副本采集接通真实网络，后续重复和导出继续回放；触发限制立即停止且不写任何文章/合集绑定。自然新文章尚未出现时不得称真实增量通过。

`require('scripts/album-acceptance-rehearsal.cjs')` 导出 `snapshot(database)`、`summary(snapshot)`、`preservation(before, after, strict=false, provenTimes={})` 和 `verifiedTimesFromCassette(manifestPath)`。导入前设置 `ALBUM_QA_RUNTIME_ROOT` 为 main 根目录；模块导入不运行采集或 HTTP 服务器。snapshot 含账号与原记录，仅内部比较，禁止打印或提交；summary 仅计数与摘要。首次有限 ct 校正必须传 exact 原文白名单，第二次与重启使用 strict=true。
