# 订阅页浏览记忆：验收

## 合并布局后的本地检查点

两份独立补丁已合并，文章行同时保留稳定 ID 与完整缓存行的紧凑样式。最终前端构建在本机独立、无登录的无头 Edge 配置中通过九组实际页面回归，接口使用合成只读数据并拦截上游及所有 mutation。新增覆盖零选择隐藏、行/全选后操作出现、分页不扩大选择、10 页恢复上限、手动继续分页，以及行高从 96px 回到 56px 时按文章锚点恢复。

原七组页面场景仍通过，包括显式 URL 优先、可见筛选与清除、刷新/返回、正文弹窗空 sandbox、已删源/分组/文章及 storage 失败。原工具导航入口没有恢复；直接打开保留路由后使用浏览器返回验证。上海跨日快捷与正文查找由原离线组件回归覆盖。

前后端 lint、类型检查及构建通过；两套受影响的原布局/选择合同测试更新夹具后 27 项通过。最终全套 Jest 的 102 个测试套件、1574 项测试全部通过。当前 schema 的独立发布产物通过当前数据库备份副本启动演练与 20 条 RSS 就绪检查。提交、远端 CI、生产服务切换与已部署页面复验仍须完成，不能把此检查点称为正式发布或订阅恢复。

开发服务器模式的新增回归在本机依赖加载阶段超时，夹具读取请求为零；已构建产物的同一九组场景通过。此限制保留在私人诊断中，不据此宣称开发服务器模式通过。桌面可见浏览器目视验收及其他浏览器未核验。

本记录针对独立补丁；不是生产部署或真实上游订阅恢复证明。验证使用实际 React 页面和组件、虚构只读 tRPC 数据及隔离无头浏览器；外部请求、所有非 GET 请求均被拦截。未启动产品后端或访问实际数据库／笔记／凭据。

## 可复现检查

`scripts/feed-browse-state.test.cjs` 校验上海跨日快捷、固定日期、显式 URL 优先、坏数据／版本／过期、存储失败和位置数量／页数边界。

`scripts/feed-browse-state-browser.test.cjs` 复用现有 Vite／React，渲染实际订阅页，接口夹具含延迟游标分页。需要已存在的 Playwright runtime，通过 `BROWSE_TEST_PLAYWRIGHT` 指定模块；默认查找 `playwright-core`，缺失时显式跳过，不自动安装。可用 `BROWSE_TEST_CHANNEL` 选已安装的 Chromium 通道；默认 Edge。可用 `BROWSE_TEST_RESULT` 将脱敏结果写入私有位置。

```powershell
node --test scripts/feed-browse-state.test.cjs scripts/article-date-shortcuts.test.cjs scripts/feed-reading-ui.test.cjs scripts/feed-export-date-ui.test.cjs scripts/feed-refresh-state-ui.test.cjs scripts/local-release/desktop-home-entry.test.cjs
node --test scripts/feed-browse-state-browser.test.cjs
node --test scripts/article-date-shortcuts-browser.test.cjs
pnpm --filter web exec tsc --noEmit
pnpm --filter web exec vite build --outDir ../../output/browse-state-build
```

浏览器覆盖：可见日期／顺序／关键词刷新恢复，勾选不恢复，第二页延迟加载与文章锚点，缓存正文打开关闭，工具页返回，分组和公众号范围，显式查询与清除，清除后的首批页数，文章删除／空结果／已删源／分组降级，390px 的清除可达性及存储读写失败。测试还断言没有更新、下载、正文重试、新增订阅或登录请求。

## 发布边界

独立副本已通过29项相关 Node 测试；实际订阅页浏览器回归的7组场景及既有日期快捷／正文查找浏览器组件测试均通过。TypeScript、改动前端文件的 ESLint 零警告、Prettier 与隔离 Vite 构建通过。构建仅有既有 Browserslist、依赖注释和大 chunk 提示。浏览器未预期请求及页面错误为零；既有产品静态图标使用本地合成图片响应。父任务应在合并布局后重新核对：实际滚动容器 ref、文章锚点属性、日期快捷标记、阅读关闭检查点与清除选择状态。仍需统一整合、发布及桌面目视验收。公开文档不包含本机私人路径、浏览器原始记录或补丁所在私有位置。

列表恢复限10页、8种近期视图、8小时；超过限制或文章顺序／删除变化只保证有界、可继续浏览的降级，不保证完全相同像素。没有跨设备或正文 iframe 的精确位置承诺。
