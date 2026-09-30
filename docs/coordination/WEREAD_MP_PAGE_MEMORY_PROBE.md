# 微信读书 MP 页面内存最小 Probe：离线准备（2026-09-30）

## 本轮状态与问题

已实现 [`probe-weread-mp-page-memory.cjs`](../../scripts/research/probe-weread-mp-page-memory.cjs) 的路由构造、`--plan`、`--self-test`、`--preflight` 和有明确授权门禁的 `--execute`。**本轮仅运行离线命令；没有导航目标号、读取会话副本或发送目标列表请求。** 在线执行需等总控复核及其他合法会话实验结束，避免同一会话并发。此 Probe 首次只回答：正常官方页面是否自然显示目录，以及页面内存的 `articles` 是否有可用于后续核查的字段；它不验证五篇文章，也不接入 Provider。

## 路由依据

2026-09-30 腾讯公开 [`app.88f998b2.js`](https://cdn.weread.qq.com/web/wrwebnjlogic/js/app.88f998b2.js)（SHA-256 `996a561d9fb7f79bf4289a91e2b6f77dc617eb2bb9352c0320b33c87b9f3bf51`）原始字符偏移约 614300、614960、615675 分别定义 `mpReaderPage`、`mpReaderURL(bookId) = '/web/mp/reader/' + e(bookId)`、`parseReaderInfoId(infoId)`。路由 `/web/mp/reader/:infoId` 在约 4102944。编码函数采用公开 [GZHReader 固定提交中的 `encode_weread_id`](https://github.com/zhiwuyazhe-fjr/GZHReader/blob/9cde7a4ce5dcda10e946d33551c91629916a9a8d/src/gzhreader_core/providers/weread.py#L51-L77)等价移植，**仅编码 URL 路由段**，不生成签名或票据。离线自测以公开书籍 `43208843` 对应的 `c9c321c07293508bc9c79df` 作已知向量；MP 目标路由的服务端可访问性仍未经验证。

腾讯公开 [`19.42e251bc.js`](https://cdn.weread.qq.com/web/wrwebnjlogic/js/19.42e251bc.js)（SHA-256 `85bea05005a543894c346a39cae5a234b9d77de322316b3a80e87de809af3a3e`）约 438000 初始化 MP 阅读器 Vuex state 的 `articles: []`，约 445600–446400 首屏调用 `/web/mp/articles`，约 455800 把 `data.reviews || []` 追加到该数组；约 462000–465800 的目录 DOM 不展示每篇 `reviewId`、原文 URL 或逐篇发布时间。详情见 [DOM 映射](WEREAD_MP_DOM_RENDER_PATH.md)。这说明只读页面内存是一个具体可验证的研究线索，不保证目标号数据可取，也不保证可持续运行。

另有 [finlater/weread.koplugin 固定版本 MP 样例](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/docs/weread-api-reference.md#L1055-L1197)把 `subReviews[].review.reviewId/createTime/belongBookId/mpInfo.originalId` 列为一个已验证公众号列表回包的字段。这是**另一公众号、另一会话**的开源报告，不能当作本目标号实测；它让本 Probe 把逐篇 `review.createTime` 和身份字段的存在数量也纳入观察。该仓库的直接接口请求代码及其登录上下文需独立审查，本脚本不复制其取文请求。

## 私有会话副本和离线命令

脚本固定读取 Windows 当前用户目录下 `C:\Users\ss\.wewe-rss-private\weread-mp-page-memory\session-copy.json`，实际由 `os.homedir()` 解析；它必须是本人正常登录后生成的 Playwright `storageState` **副本**，并位于该 Git 仓库之外。制作副本时只可从本人已授权的正常浏览器会话调用 Playwright 的 `context.storageState({ path: ... })`，不可把 Cookie 打印到终端、报告或 Git。若没有现成合法会话，须由本人完成正常登录或扫码；本 Probe 不执行登录、不导出浏览器数据库。`--preflight` 只检查文件是否存在、是普通文件且位于私有目录内，不读取其中的 Cookie 值；实际执行时由 Playwright 载入副本，结果不回写副本。

在仓库目录运行（路径按本机实际安装填写；`--plan` 和 `--self-test` 不需要会话副本）：

```powershell
node scripts/research/probe-weread-mp-page-memory.cjs --plan
node scripts/research/probe-weread-mp-page-memory.cjs --self-test
node scripts/research/probe-weread-mp-page-memory.cjs --preflight --playwright-core C:\path\to\node_modules\playwright-core --browser 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

总控复核、会话独占和本人合法登录状态确认后，才可把 `--preflight` 换成 `--execute`，并在末尾**显式**添加 `--approved-online`。本文不把该命令作为当前步骤自动执行。若会话副本缺失或需要扫码，停在离线阶段，其他研究可继续。

## 执行边界和输出

执行前在 `~/.wewe-rss-private/weread-mp-page-memory-target.attempted.json` 以排他写入和 `fsync` 立下**永久 one-shot 标记**。标记或结果文件已存在时拒绝重复执行；浏览器失败也不自动重试。仅一次顶层 `page.goto` 导航已编码的腾讯官方阅读器页面，官方页面本身可能自然加载多个腾讯资源和首屏内容，脚本不控制也不声称 HTTP 请求只有一个。脚本不设置 `page.on('request')`、请求拦截或重放，不调用列表 API，不自动续期、扫码、验证码、滚动、翻页或点击文章。遇登录跳转或验证码，仅输出有限状态并关闭浏览器。

结果只含顶层导航状态、页面种类、验证码可见性、目录 DOM 的组/标题/组日期数量、DOM 是否带原文链接或身份属性，以及 Vuex `articles` 组数、`subReviews` 数量、`reviewId` 去重数量和 `review.createTime/belongBookId/mpInfo.originalId/time/ct/title/pic_url` **存在数量**。值、标题、文章 URL、Cookie、响应头、原始 HTML、截图与正文均不输出、不落盘。结果以排他写入保存到 `~/.wewe-rss-private/weread-mp-page-memory-target.result.json`；脚本崩溃后可能只有尝试标记，此时不得移除标记后重试，先由总控审阅原因。

如果页面实际显示登录或验证，结果只说明这份会话副本的自然导航未得首屏；不能据此排除合法续期后或本人完成验证后的页面路径。如果正常目录与内存条目存在，下一轮还需单独核对号身份、五篇真实不同文章、原文稳定身份与逐篇发布时间，再研究分页、正文和图片。当前脚本不会自动分页；第一方页面目录滚动才能触发后续页，且已审静态代码没有可靠 DOM 末页标记。`storageState` 副本、页面内部 Vuex 结构、浏览器版本和人工验证码边界都可能变化，因此首屏成功也不能直接声称可长期无人值守订阅。
