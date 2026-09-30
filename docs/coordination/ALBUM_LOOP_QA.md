# 当前官方合集闭环 QA（2026-09-30）

范围：妈妈部落畅聊阁当前已恢复精确身份的一个官方合集。19 个不同文章身份、2 页，不代表公众号全史；之前第三合集 54 键的旧临时证据不能用于本次验收。

## 已实测的保护起点

生产 `apps/server/data/wewe-rss.db` 仅以 SQLite 只读连接检查：1 个账号、12 个订阅、1447 篇文章，`quick_check=ok`、外键检查无异常。SQLite 在线一致性备份经 `integrity_check=ok` 与文件 SHA256 复核，账号/订阅/文章逐字段与源基线相等；源前后逐字段完全不变。证据持久保存在 Git 忽略的 `private-data/album-loop-qa/baseline-efb27dc1/`，不是 TEMP。

19 个当前合集身份均与旧库行对应：11 篇已有正文，8 篇缺正文（官方列表索引 5–11、18）。因此首次正式导入新增 0 是合理结果；应补齐的是这 8 篇正文与图片。旧正文保留，不为采集流程重发其历史失败原文。

A 当日真实输入已经私存：2 页官方 JSON、11 篇当前原样 HTML、11 张完整图片字节（其中包括全部 8 篇缺正文的输入）。QA 私有转换脚本复核原文 SHA256，从净化 HTML 图片顺序与本地化 data URI 对应提取已获字节，再用正式图片容器检查器校验。当前有效精确请求 cassette 在 `private-data/album-loop-qa/cassette-a524252e-a9d4-4e8a-94b4-9018feeab87e/manifest.json`；早期 `cassette-a082…` 把列表 HTTP 链接直接当实际 HTTPS 请求，已排除，不再使用。

## Review 与当前验收状态

- 已推动 Provider 缓存可用数逐图调用 `decodeInlineImage`。仅 `data:` 前缀会将坏 MIME 或截断字节误报完整；现在坏缓存不改旧正文，只如实报告缺口。
- 当前真实回放触发实际正文门禁：真实原文的 canonical 为 HTTPS `/s?…` 完整身份链接，而 `fetchArticleBody` 无条件要求 `/s/<22位短链>`，导致 8 个缺正文输入 `invalid_page`。这些原样 HTML 的正式身份/标题/ct 可解析，验证码 DOM 均无；已交 B 修复，必须仍精确核 biz/mid/idx/sn/ct/title，旧短 ID 仍检查短 canonical 与 ID 一致。此处不需要新的来源研究或重复腾讯请求。
- 失败批次的演练副本仍持久保留；尚未声称成功导入、重复 0 新增、HTTP 服务重启或全部导出通过。
- QA 保护断言 self-test 共 11 个破坏案例通过：旧 ID 消失、ct 改变、正文清空、封面清空、0 阅读被 null 覆盖、点赞/metrics/创建时间变化、账号改变、重复新增等均被阻止。ZIP 校验器另以独立合成文件验证 CRC 与文件字节一致；这两项是测试器测试，不是订阅验收。

## 可执行验收命令

需要 Node 24（`node:sqlite`）、Python 和已构建 server；`runtime-root` 指向总控 main。所有副本、日志、cassette、原文和导出只写该目录下 Git 忽略的 `private-data/album-loop-qa/`。无需真实登录凭据。

```powershell
$repo = 'C:/Users/ss/.gemini/antigravity/playground/sparse-comet/wewe-rss-ss'
$cassette = "$repo/private-data/album-loop-qa/cassette-a524252e-a9d4-4e8a-94b4-9018feeab87e/manifest.json"
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
