# 本人可见 Web 登录后的 MP 页 DOM / 内存观察：离线准备（2026-09-30）

## 要回答的问题

已有[移动恢复会话的目标 MP 页面单次结果](WEREAD_MP_PAGE_MEMORY_PROBE.md)是顶层 HTTP 200、目录 0，且脚本未找到预设的 `#app.__vue__.$store`；它未观察列表接口响应，也未覆盖本人在腾讯官方可见页面完成登录后的独立会话。[第一方续期源码审计](WEREAD_RENEWAL_2013_SOURCE.md)又发现快速微信登录组件把 `ql=1` 传给 Web init，另一登录分支传 `ql=0`；旧恢复探针省略 `ql`，两者的认证上下文不能视为相同。

[`probe-weread-logged-mp-dom.cjs`](../../scripts/research/probe-weread-logged-mp-dom.cjs)因此只准备一项新上下文的首屏观察：**本人在专用可见 Edge 窗口通过腾讯正常页面完成登录后，官方 MP 阅读器是否自然显示目录，DOM 或第一方已知 `state.mp.articles` 是否有身份、时间字段？** 本脚本不读 `wr_ql` 等 Cookie 值，不能证明本次人工登录实际属于 `ql=1` 分支；会话登录方式须在可见页面由本人确认。它也不请求 `/web/mp/articles` 或任何目标列表 API，不能直接诊断该接口的业务码。

## 会话与请求边界

脚本只接受 [`weread-login-window.ps1`](../../scripts/research/weread-login-window.ps1) 已记录、进程和回环监听均已核实的**专用 Edge** 会话。它调用该脚本 `Status` 获取本机 `127.0.0.1` CDP 地址，再用固定 `playwright-core@1.58.2` 的 `connectOverCDP` 附加到已经可见的浏览器；[Playwright 官方文档](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)说明连接可访问默认 context。[`browser.close()` 对已连接浏览器只断开连接](https://playwright.dev/docs/api/class-browser#browser-close)，不关闭本人的可见窗口。探针不创建新浏览器、context 或标签页，不复制原浏览器 profile，不调用 `context.cookies()`、`storageState()`，也不读页面的 localStorage。

连接后必须恰有一个 `weread.qq.com` 顶层标签页；多个或零个时在目标请求前停止。对这个既有标签页，若已处于目标 MP 路由只观察，否则最多执行一次普通 `page.goto` 到第一方 `/web/mp/reader/<编码 bookId>`。浏览器随后可能自然加载腾讯自己的资源，脚本不记录、不监听、不拦截、不重放任何请求或响应；不安装扩展、抓包器，也不调用 `page.on('request')`、`route`、`request.get/post`。不滚动、不点按、不处理扫码或验证码，不自动续期。只有本人在可见窗口正常完成必要验证，才应运行一次在线模式；若出现腾讯验证码或登录页，脚本记录可见性并停止，不替本人操作。

新的全局 one-shot 标记固定为当前用户私有目录 `~/.wewe-rss-private/weread-logged-mp-dom.attempted.json`，结果为相邻的 `weread-logged-mp-dom.result.json`。脚本先核私有根目录不是链接、没有已有标记或结果；连接并选定唯一官方标签页后，在**目标导航之前**以独占创建和 `fsync` 写标记。导航、观察失败也消耗该标记；不得删除、更名或换路径来重试。同一目标的旧移动恢复探针另有自己的永久标记，本次仅因正常可见登录的认证来源不同而成为独立实验。

## 只读字段与解释

页面检查最多十次，每次间隔 500 毫秒，通常在显示目录、登录、验证码或页内加载失败标志后立即结束。返回 JSON 只含：

- 页面类别（MP 阅读器、登录、其他），可见验证码与登录弹窗布尔量；目录容器、组、标题、组时间数量，是否存在原文链接和身份属性，**不返回链接、标题或 HTML**。
- Vue 实例、Store、`state.mp` 是否可见，以及 Store 在 `#app`、其子节点、目录及附近组件中的入口类别；若找不到 Store，所有页内加载状态为 `null`，不把它当成服务端失败。
- 已知第一方 `state.mp.articles` 中组、子条目及不同 `reviewId` 数量；`review.createTime/belongBookId/mpInfo.originalId/time/ct/title/pic_url` 与组时间字段的**存在数量**；`mp.bookId` 是否等于固定目标 ID，仅输出布尔量，不返回任何身份值。

入口检查仅使用公开静态客户端已证实的 `state.mp`，以及 Vue 常见的 `__vue__/$store` 挂载属性；不会枚举未知应用状态或猜测私有 API 响应字段。DOM 没有身份或发布时间时，也不能用组时间代替逐篇发表时间。若 Store 再次不可见，结果只表示此入口未读到；不能推出目标无文章、接口 `-2041`、Cookie 无效或跨号不可用。目录出现也只是首屏线索，不能直接满足五篇真实文章、可信时间、正文图片、分页与长期更新验收。

## 离线检查与未来人工步骤

本专项目前只运行了 `--plan`、`--self-test` 与 `node --check`；**未调用 `Start`、`Status`、`--preflight` 或 `--execute`，未启动在线浏览器或访问目标页**。假页自测覆盖有 `state.mp` 的两篇样例、Store 缺失、可见验证码、重复标签页拦截、先落标记再导航、目标页已打开时零重复导航，以及标记排他写；假页中的身份和标题不会进入输出。

离线命令：

```powershell
node --check scripts/research/probe-weread-logged-mp-dom.cjs
node scripts/research/probe-weread-logged-mp-dom.cjs --plan
node scripts/research/probe-weread-logged-mp-dom.cjs --self-test
```

总控复审并安排在线时，本人先按[可见登录窗口预案](WEREAD_LOGIN_WINDOW_PLAN.md)在专用 Edge 窗口完成腾讯正常登录，并从可见页面确认已登录。`Status` 只校验进程和本机端口，**不证明登录成功**。之后使用 Git 外已审的固定版本 `playwright-core` 目录执行本机预检，再由总控决定一次性在线观察：

```powershell
node scripts/research/probe-weread-logged-mp-dom.cjs --preflight --playwright-core '<固定 1.58.2 模块目录绝对路径>'
node scripts/research/probe-weread-logged-mp-dom.cjs --execute --playwright-core '<同一目录>' --approved-online --owner-login-confirmed
```

预检只读专用会话 `Status`、本地模块版本和标记，不访问目标页，也不读取登录凭据。执行后的结果只留在私有目录并向终端输出相同的脱敏 JSON；无截图、HAR、trace、原始页面、请求头或票据。完成后本人关闭可见窗口并运行启动脚本的 `Stop` 清理短时调试 profile。若可见验证码、账号限制或频控出现，停止该路线并只保留脱敏事实；其他独立研究可继续。
