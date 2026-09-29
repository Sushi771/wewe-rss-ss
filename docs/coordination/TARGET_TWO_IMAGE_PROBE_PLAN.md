# 目标旧文章双图片字节探针：一次真实结果（2026-09-30）

## 候选与已完成的离线检查

生产 SQLite 以 `mode=ro`、`query_only=ON` 打开，`quick_check=ok`，仍有 12 个订阅、1447 篇文章。目标号一篇已有缓存正文和完整 `verified_source_url` 的旧文章，官方原文 `__biz/mid/idx/sn` 四字段身份摘要为 `792e0623ba3ee739`。正文恰有两张不同的 `mmbiz.qpic.cn` HTTPS 图片，URL SHA-256 前 16 位依次是 `d306250f513bedc2`、`7070eee8dd479e6a`。两者与已请求的单图摘要 `862f10b2324802c9` 不同；未在目标号其余已核验正文或本机 12 份已保存目标 HTML 中复用，本机没有对应尝试哨兵。这只限定本机可检查的历史材料，不能证明其他环境从未请求过。

[`probe-target-two-images.cjs`](../../scripts/research/probe-target-two-images.cjs) 已实现 `--dry-run` 与 `--self-test`。前者重新核对唯一文章、两张图片的顺序与摘要、允许域名、无本机哨兵、SQLite 一致性及计数，外部请求为 0。后者在 SQLite 一致性临时副本中以两张**合成 PNG**走现有 `archiveProviderImages`，随后禁网执行重建路由后的 Obsidian 和限定单篇 ZIP 附件路径；外部请求仍为 0。两项均通过：Obsidian 两个附件、ZIP 两个附件，旧字段与其他文章保持不变，演练临时目录已删除。合成测试不代表腾讯图片今天可读。

## 线上执行边界与结果

总控审查并用当前服务端构建完成离线演练后，运行一次 `--online <生产 SQLite 绝对路径> --approved-online`。缺少显式标志时 `--online` 在读取数据库或联网前被拒绝。脚本先重新运行全部只读门禁；按正文顺序，对**每个 URL** 在系统临时目录原子创建并 `fsync` 仅含摘要和时间的私有 `.attempted` 哨兵，紧接着最多一次匿名 HTTPS GET。每张超时 10 秒、响应上限 10 MB；总上限两次 GET。不使用代理、Cookie、授权头、重定向或重试；要求 HTTP 200、允许的图片 MIME、无压缩或 identity 编码、声明长度与接收字节一致以及容器签名。遇重定向、验证、受限、传输或图片校验失败，立即停止；未开始的后一张不预写哨兵。哨兵保留防止误重发。

两张都取得完整字节：HTTP 200，第一张 `image/png` **92,237 字节**，第二张 `image/jpeg` **130,633 字节**，声明长度均与实收一致。图片只在内存、临时一致性副本和临时附件中流转；生产库不写。副本仅替换这一篇的 `content_html`，校验其他字段、全库文章快照与 `quick_check`；随后禁网验证 Obsidian 两个附件字节及限定单篇 ZIP 中两个附件的哈希和 Markdown 相对路径，全部通过。结果为 `networkGets=2`、`outcome=complete_images_and_scoped_exports`、附件各 2、`oldFieldsPreserved=true`。脚本没有输出原始 URL、标题、正文、凭据或图片字节；临时库、附件与 ZIP 在进程结束时删除，两张私有尝试哨兵保留。它只证明这篇旧文章两张图片与限定离线导出，不能证明全号图片、正文、增量或订阅恢复。
