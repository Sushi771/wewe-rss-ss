# 微信读书 MP 页面内存最小 Probe：离线准备（2026-09-30）

## 本轮状态与问题

已实现 [`probe-weread-mp-page-memory.cjs`](../../scripts/research/probe-weread-mp-page-memory.cjs) 的路由构造、`--plan`、`--self-test`、`--preflight` 和有明确授权门禁的 `--execute`。支持独立的合法 Web 会话副本，或从已核验的本人移动端恢复记录在临时浏览器上下文内做**至多一次**腾讯官方 `/web/login/session/init`。两种模式共用同一个目标页 one-shot 标记。总控复核、合法会话独占确认后，**恢复模式已在线执行唯一一次**；没有直接发送目标文章列表请求，官方页面自然加载的请求不受脚本控制。此 Probe 首次只回答：正常官方页面是否自然显示目录，以及页面内存的 `articles` 是否有可用于后续核查的字段；它不验证五篇文章，也不接入 Provider。

## 路由依据

2026-09-30 腾讯公开 [`app.88f998b2.js`](https://cdn.weread.qq.com/web/wrwebnjlogic/js/app.88f998b2.js)（SHA-256 `996a561d9fb7f79bf4289a91e2b6f77dc617eb2bb9352c0320b33c87b9f3bf51`）原始字符偏移约 614300、614960、615675 分别定义 `mpReaderPage`、`mpReaderURL(bookId) = '/web/mp/reader/' + e(bookId)`、`parseReaderInfoId(infoId)`。路由 `/web/mp/reader/:infoId` 在约 4102944。编码函数采用公开 [GZHReader 固定提交中的 `encode_weread_id`](https://github.com/zhiwuyazhe-fjr/GZHReader/blob/9cde7a4ce5dcda10e946d33551c91629916a9a8d/src/gzhreader_core/providers/weread.py#L51-L77)等价移植，**仅编码 URL 路由段**，不生成签名或票据。离线自测以公开书籍 `43208843` 对应的 `c9c321c07293508bc9c79df` 作已知向量；MP 目标路由的服务端可访问性仍未经验证。

腾讯公开 [`19.42e251bc.js`](https://cdn.weread.qq.com/web/wrwebnjlogic/js/19.42e251bc.js)（SHA-256 `85bea05005a543894c346a39cae5a234b9d77de322316b3a80e87de809af3a3e`）约 438000 初始化 MP 阅读器 Vuex state 的 `articles: []`，约 445600–446400 首屏调用 `/web/mp/articles`，约 455800 把 `data.reviews || []` 追加到该数组；约 462000–465800 的目录 DOM 不展示每篇 `reviewId`、原文 URL 或逐篇发布时间。详情见 [DOM 映射](WEREAD_MP_DOM_RENDER_PATH.md)。这说明只读页面内存是一个具体可验证的研究线索，不保证目标号数据可取，也不保证可持续运行。

另有 [finlater/weread.koplugin 固定版本 MP 样例](https://github.com/finlater/weread.koplugin/blob/dfdc200cbf4ceaca0a72c8c14763aaec80ec386f/docs/weread-api-reference.md#L1055-L1197)把 `subReviews[].review.reviewId/createTime/belongBookId/mpInfo.originalId` 列为一个已验证公众号列表回包的字段。这是**另一公众号、另一会话**的开源报告，不能当作本目标号实测；它让本 Probe 把逐篇 `review.createTime` 和身份字段的存在数量也纳入观察。该仓库的直接接口请求代码及其登录上下文需独立审查，本脚本不复制其取文请求。

## 模式一：私有 Web 会话副本

脚本固定读取 Windows 当前用户目录下 `C:\Users\ss\.wewe-rss-private\weread-mp-page-memory\session-copy.json`，实际由 `os.homedir()` 解析；它必须是本人正常登录后生成的 Playwright `storageState` **副本**，并位于该 Git 仓库之外。制作副本时只可从本人已授权的正常浏览器会话调用 Playwright 的 `context.storageState({ path: ... })`，不可把 Cookie 打印到终端、报告或 Git。若没有现成合法会话，须由本人完成正常登录或扫码；本 Probe 不执行登录、不导出浏览器数据库。`--preflight` 只检查文件是否存在、是普通文件且位于私有目录内，不读取其中的 Cookie 值；实际执行时由 Playwright 载入副本，结果不回写副本。

在仓库目录运行（路径按本机实际安装填写；`--plan` 和 `--self-test` 不需要会话副本）：

```powershell
node scripts/research/probe-weread-mp-page-memory.cjs --plan
node scripts/research/probe-weread-mp-page-memory.cjs --self-test
node scripts/research/probe-weread-mp-page-memory.cjs --preflight --playwright-core C:\path\to\node_modules\playwright-core --browser 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

## 模式二：已核验的本人恢复凭据

若 `session-copy.json` 不存在，可选择恢复模式。`--preflight --recovery` 通过现有 `recoveryGate(db, runDir, 'present')` 验证刷新记录、账号身份、生产 SQLite 与 `original.sqlite`、`rehearsal.sqlite` 的只读一致性和历史健康哨兵；再通过既有 `privateRootGate` 与 `targetGate` 验证忽略目录和目标号。它读取私有恢复文件以做校验，**不打印、保存或提交令牌**。此前目标 cover 实验的哨兵属于另一条路线，不阻止这次不同的官方页面实验；本 Probe 自己的全局标记在两种模式间共享。

恢复模式只读预检的命令形状如下；`<...>` 由总控填入本机已存在的绝对路径，不能把凭据值作为命令参数：

```powershell
node scripts/research/probe-weread-mp-page-memory.cjs --preflight --recovery --db '<生产 SQLite 绝对路径>' --run-dir '<mobile-refresh 绝对路径>' --playwright-core '<playwright-core 模块目录绝对路径>' --browser 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

该模式的在线执行先在**全局目标页 one-shot 标记落盘后**启动全新隔离的 Edge BrowserContext，确认初始 Cookie 为空，只调用一次官方 `/web/login/session/init`，沿用现有已实测的 `vid/pf/skey/rt` 请求字段与 10 秒超时、零重定向、零重试。成功后仅在内存检查五种 Web Cookie 是否齐全及 `wr_vid` 是否与恢复账号一致；若失败或要求验证，关闭上下文，不导航目标页。只有通过此门禁才自然导航一次官方 MP 页面。脚本不导出 `storageState`，不输出 Cookie 名值、令牌、初始化原始响应体或浏览器错误详情；结果只有安全的状态码与布尔量。所用固定 User-Agent 与既有移动端到 Web 健康实验一致，这也是与真实日常浏览器仍需核对的行为差异。

本机恢复模式的只读预检已返回 `ready: true`、`markerAbsent: true`、`recoveryAndBackupValidated: true`；`sessionCopyPresent: false` 符合当前缺少独立 Web 副本的事实。该预检通过既有门禁读取了私有恢复记录和只读 SQLite，未调用 Web init 或目标页面，也未创建尝试标记。沿用项目既有 Playwright `1.58.2` 固定门禁；本机 Codex bundled `1.62.1` 不满足该门禁，不能直接替换为本次在线执行运行时。

执行前需总控复核、会话独占和本人合法登录状态确认，再把对应模式的 `--preflight` 换成 `--execute`，并在末尾**显式**添加 `--approved-online`。本次恢复模式已执行，不能因空目录或入口读取失败移除哨兵重试。若后续需要本人扫码，停在该路线，其他研究可继续。

## 唯一在线运行的脱敏结果

2026-09-30，恢复模式运行一次后，私有全局尝试标记与脱敏结果文件均存在。脚本状态为 `initial_catalog_not_observed`：

1. 官方 Web init `initRequests: 1`、`initHttp: 200`，Web Cookie 齐全且与恢复账号匹配（两个布尔量均为 `true`）；未保存或输出 Cookie 值。
2. 官方 MP 阅读器顶层导航 `pageNavigations: 1`、`navigationStatus: 200`，页面种类为 `mp_reader`。`captchaVisible: false`，`catalogPresent: true`。
3. 首屏可见 DOM 的目录组、标题和组时间数量均为 `0`；原文链接及身份属性存在性均为 `false`。
4. 脚本预设的 `#app.__vue__.$store` 入口未找到 MP state（`vueStoreFound: false`）；记录的组、子文章、`reviewId`、逐篇时间、原始 ID、封面等存在数量均为 `0`。`loadFail` 与 `loading` 都为 `false`，但这两个值依赖同一未找到的 Vuex 入口，**不能据此判断页面请求是否成功或失败**。

这次结果只证明该账号、会话、时点下的**本次自然页面首屏**没有显示目标文章，且当前脚本未取得页面内存中的 MP 列表。它没有观察或保存 `/web/mp/articles` 的响应，不证明服务端返回空列表、`-2041`、验证码、跨号限制或目标号不存在，也不排除页面内部状态读取入口有误。离线复核的第一方 [`app.88f998b2.js`](https://cdn.weread.qq.com/web/wrwebnjlogic/js/app.88f998b2.js) 约 2876349 调用 `$mount('#app')`，约 1804199 的根节点仍带 `id: app`；[`19.42e251bc.js`](https://cdn.weread.qq.com/web/wrwebnjlogic/js/19.42e251bc.js) 约 373000 把 MP state 注册为 `mp`，页面组件约 376000 从 `state.mp` 读取数据。静态代码不能解释本次 `vueStoreFound: false` 的实际原因。由于 one-shot 哨兵已落盘，**不再重试本目标页 Probe**；可继续离线核查页面挂载及其他独立、有公开依据的取文路线。

## 执行边界和输出

执行前在 `~/.wewe-rss-private/weread-mp-page-memory-target.attempted.json` 以排他写入和 `fsync` 立下**永久 one-shot 标记**。标记或结果文件已存在时拒绝重复执行；浏览器失败也不自动重试。恢复模式至多一次官方 Web init，两种模式都至多一次顶层 `page.goto` 导航已编码的腾讯官方阅读器页面。官方页面本身可能自然加载多个腾讯资源和首屏内容，脚本不控制也不声称 HTTP 请求只有一个。脚本不设置 `page.on('request')`、请求拦截或重放，不直接调用列表 API，不自动续期、扫码、验证码、滚动、翻页或点击文章。导航后至多约 5 秒以 500 毫秒间隔只读检查 DOM 与 Vuex；发现可见验证码、登录跳转、目录或加载失败即停止观察并关闭上下文，不自动处理验证码。

结果只含顶层导航状态、页面种类、验证码可见性、目录 DOM 的组/标题/组日期数量、DOM 是否带原文链接或身份属性，以及 Vuex `articles` 组数、`subReviews` 数量、`reviewId` 去重数量和 `review.createTime/belongBookId/mpInfo.originalId/time/ct/title/pic_url` **存在数量**。值、标题、文章 URL、Cookie、响应头、原始 HTML、截图与正文均不输出、不落盘。结果以排他写入保存到 `~/.wewe-rss-private/weread-mp-page-memory-target.result.json`；脚本崩溃后可能只有尝试标记，此时不得移除标记后重试，先由总控审阅原因。

如果页面实际显示登录或验证，结果只说明所用合法会话路径的自然导航未得首屏；不能据此排除本人完成验证后的页面路径。如果正常目录与内存条目存在，下一轮还需单独核对号身份、五篇真实不同文章、原文稳定身份与逐篇发布时间，再研究分页、正文和图片。当前脚本不会自动分页；第一方页面目录滚动才能触发后续页，且已审静态代码没有可靠 DOM 末页标记。`storageState` 副本、页面内部 Vuex 结构、浏览器版本和人工验证码边界都可能变化，因此首屏成功也不能直接声称可长期无人值守订阅。
