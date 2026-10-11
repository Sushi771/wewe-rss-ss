# 品牌返回公众号文章列表验收

手机进入工具或账号页后，顶部“公众号源”链接被窄屏规则隐藏，原品牌文字无法导航。现在 WeWe RSS 品牌使用现有 RouterLink 返回公众号文章列表，不增加导航栏按钮。

## 实现与路由

- `Nav.tsx` 的 NavbarBrand 使用 `as={RouterLink}`、`to="/feeds"`。
- App 的 `BrowserRouter basename="/dash"` 会生成 `/dash/feeds`；不要在组件中硬拼 `/dash`。
- 保留品牌图片、文字、字号、间距及现有版本 Tooltip，增加“返回公众号文章列表”无障碍名称和键盘可见焦点轮廓。
- 复用现有列表浏览状态恢复；本改动不另写状态存储。

## 产品验收

在 390px 与 1440px 各验证以下四组：工具页鼠标、工具页 Tab/Enter、账号页鼠标、账号页 Tab/Enter。

1. 公众号列表设置关键词与发布时间排序，加载第二页并滚动。
2. 通过现有导航进入工具或账号页。
3. 点击品牌，或者连续 Tab 到品牌后按 Enter。
4. 品牌应有正确链接与可见键盘焦点，返回 `/dash/feeds`，不发生横向溢出。
5. 关键词、排序、第二页及原滚动文章锚点应保留；不启动刷新、取文、下载或登录。

## 可复跑技术验收

先完成正常 web 构建，然后运行：

```powershell
node scripts/nav-brand-browser.test.cjs
```

脚本直接使用 Node 的 WebSocket/CDP 和本机已安装 Edge，不安装 Playwright。需要支持全局 WebSocket 的 Node（本轮为 24.11.1）。可用 `NAV_TEST_BROWSER` 指定已安装浏览器路径，`NAV_TEST_EVIDENCE` 指定私有证据目录。

脚本为实际生产前端产物启动仅监听 127.0.0.1 的本机 fixture 服务，真实派发鼠标及键盘事件。全部文章、正文与来源均为合成 fixture；测试通过不能称为真实订阅恢复。结果 JSON 与焦点截图只留在临时目录，禁止提交。

脚本核验八组交互、basename 生成链接、Tab 可达及焦点轮廓、窄屏无横向溢出、关键词与排序、40 条已加载文章和滚动锚点。服务拒绝非 GET，测试阻止使用外部解析并检查没有刷新、登录或下载 API。

## 本轮结果

基线：`ff150609305ae21ecaaac8cf41deb8e3f0e025ab`。

独立临时副本：TypeScript `tsc --noEmit` 通过，生产 Vite 构建通过（保留既有大 bundle 提示）；八组离线浏览器验收通过。未修改共享工作树，未部署或发布。
