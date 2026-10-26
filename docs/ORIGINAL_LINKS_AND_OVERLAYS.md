# 原文链接与弹窗维护

公众号列表、全文搜索结果、分组及日期筛选共用文章标题入口。标题使用已保存的官方原文 URL，在新标签页打开，与正文是否缓存无关。缺失或不安全的地址显示“原文链接未保存或不可用”，不会根据内部文章 ID 拼接地址。平台内正文阅读器及其查找功能已删除；正文采集、全文搜索、数据库缓存和 Markdown/图片导出保留。导出仍默认保存到 Obsidian 目录，ZIP 只作为用户显式选择的兼容方式。

`article.byId` 仍由 Sites 的受保护下载投影调用，不能当作阅读器残留删除。Sites 对外的 `body` 阅读操作已撤出，`download` 的身份、归属、正文与媒体完整性检查保留。

当前路由内的 NextUI 浮层通过 `components/AppOverlays.tsx` 导入。Modal 使用 body portal、居中布局、视口内最大高度和主体滚动；保留调用方的关闭、pending 和禁止关闭条件。普通菜单/提示位于 sticky 工具栏之上、模态遮罩之下；模态内菜单使用更高层级。`SubscriptionDialog` 的业务包装仍保留，不改变来源操作或导出行为。

Tailwind 必须从 `@nextui-org/react` 的依赖位置解析 theme 路径。不能假设 pnpm 将 `@nextui-org/theme` 提升到仓库根目录；路径错误会漏掉 Modal 的定位、宽度、内边距和关闭按钮样式。验收必须使用最终编译 CSS/JS，手写 HTML 几何 fixture 不能代替页面入口。

离线回归：

- `node --test scripts/wechat-original-link.test.cjs scripts/feed-avatar-reading-ui.test.cjs scripts/wechat-source-metrics-ui.test.cjs scripts/sites-local-contract.test.mjs scripts/export-article-batches.test.cjs`
- 构建 web 后运行 `node scripts/overlay-matrix-browser.test.cjs` 和 `node scripts/responsive-layout-browser.test.cjs`。
- `node --test scripts/article-date-shortcuts-browser.test.cjs` 保留日历指针、触摸、日期和键盘验证。

浏览器用例仅服务合成 localhost 数据，使用新建临时 profile 并阻断外部域名。不得接入生产数据库、真实采集来源或用户登录状态。原文点击测试在页面事件边界截停导航，验证实际链接、键盘激活及未被组件拦截，不访问公众号。

矩阵逐入口记录通过、失败和不可达项目。`legacy-accounts`、原型页面不属于当前路由；f8412cb 的小红书分组没有添加成员入口，不能把公众号该入口的结果记为小红书通过。最终整合如新增入口，需追加对应验证。
