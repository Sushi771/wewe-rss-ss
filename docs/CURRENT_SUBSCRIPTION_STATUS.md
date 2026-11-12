# 当前订阅状态只显示一行

切换订阅后，工具栏下的缓存同步提示应替换成当前订阅状态。状态查询失败仍显示“上游状态暂无法读取”；缓存已同步、图片待核与当前采集完成保持区别。历史提示不应持续增加并挤压日期筛选与文章列表。

## 根因

`feeds/index.tsx` 中 `CacheSyncStatus` 与来源详情 `details` 是同一父节点的兄弟元素，两者原先都使用 `key={currentMpId}`。订阅切换触发重复 key 的 React reconciliation；旧状态节点没有正常移除。真实安装的 React 在隔离 Chromium 中，第一次切换就能复现两个状态节点。状态组件自身没有手动 append DOM，也没有不断追加提示的 state 集合。

修复为两个兄弟元素使用不同前缀：`cache-status:${currentMpId}` 与 `source-details:${currentMpId}`。两者仍在订阅改变时按各自身份重新挂载，来源详情的展开状态不会跨订阅残留。查询结果继续按当前 `feedId` 查找，不用旧订阅的状态标记新订阅。

## 回归证据

`scripts/cache-status-switch-browser.test.cjs` 从实际页面提取兄弟元素及其 key，并挂载真实 `CacheSyncStatus`、React 和 TanStack Query。测试开启 StrictMode，连续切换 20 次，在旧的全订阅读取晚返回后再次检查，并重复渲染 10 次。每一步只允许一个状态节点，提示对应最终订阅，错误读取仍可见。

测试只在隔离 headless Chromium 中使用合成数据和延迟查询，不读取生产数据库、不调用平台，也不代表真实 API、正文或图片已经恢复。用户截图所示状态累积与文章数量不能单独证明后端恢复。日期筛选、文章列表和服务端读取问题仍按各自功能验收。
