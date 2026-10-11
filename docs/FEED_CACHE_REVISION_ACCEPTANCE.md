# 缓存变化与列表可见验收

本单元复用现有认证 tRPC、文章无限列表、任务队列和 sessionStorage 浏览状态。后台保存文章后改变 `feed.cacheRevision`；前端观察版本变化并失效当前活跃列表、摘要及订阅查询，保留已加载页数和稳定文章锚点。不会重新提交采集、下载正文或恢复旧任务面板。

## 接口与状态语义

- `feed.cacheRevision`：protectedProcedure.query，无 input，返回 `{revision:string}`。版本采用进程 epoch 与 counter；已保存文章变化才更新，重启改变 epoch，GET 不能发上游请求。
- `feed.cacheSyncStatus`：protectedProcedure.query，无 input，返回诊断快照；`feeds` 中每项含 `feedId`、`upstreamCheckTime`、`nextUpdateTime`、`paused`、`lastCacheReadAt`、`state`。未知值为 null。前端在选号、手动操作回执后、实际文章版本变化或重连时读取，不每秒读取诊断快照。
- `paused`、`waiting`、`synced-cache`、`media-pending`、`unavailable` 分别显示暂停、等待变化、现存缓存已同步、媒体待核、检查未完成。检查时间不等于内容完成时间；旧缓存非空或 `complete:false` 不能证明本轮最新文章已全部采集。

revision 使用同一个认证客户端，页面可见、聚焦且在线时约每秒读一次；失焦、后台或断网停止并中止在途请求。恢复后马上补查。网络错误按 2/4/8/16/30 秒退避，列表失败保留未确认版本并退避重试。没有版本变化时不失效文章查询、不改变阅读位置，也不显示更新完成。首次读到的版本作为当前页面加载基线。

持续变化在一次列表读取期间合并为最新版本，至多追加一次必要读取。文章内容详情及已完成任务历史不随 revision 反复轮询。单号按钮反馈为缓存同步，不声称上游本轮采集结束。

## 回归

基线：`ff150609305ae21ecaaac8cf41deb8e3f0e025ab`。本补丁必须和上述后台契约一起集成。

独立前端构建使用 Temp 中两条纯 mock 查询的类型夹具；这些临时后端代码不进入补丁。统一集成后须使用实际后台实现再次完成构建与回归。

```powershell
node --test scripts/cache-revision-watch.test.cjs scripts/cache-sync-status-ui.test.cjs scripts/feed-refresh-state-ui.test.cjs scripts/manual-refresh-progress-ui.test.cjs scripts/subscription-tasks-ui.test.cjs scripts/feed-browse-state.test.cjs scripts/refresh-feed-view.test.cjs
pnpm --filter web build
# 复用已安装 Playwright；缺少 runtime 时浏览器测试明确 skip。
# BROWSE_TEST_PLAYWRIGHT 指向模块，BROWSE_TEST_EXECUTABLE 可指定已安装 Chromium。
node --test scripts/cache-revision-browser.test.cjs
```

浏览器夹具服务本次生成的产品构建，使用独立无登录上下文，拦截全部远端请求与 mutation，仅返回合成只读数据。覆盖新文章由 revision 到实际列表、无变化不重复读取、长列表页数/锚点/选择、阅读弹窗、失焦/断网/后台恢复、390px 筛选值及无虚假完成。日期验证通过 URL 与 sessionStorage 语义，不依赖日期输入组件内部 DOM。

## 验收边界

单元与 mock 浏览器通过不等于真实订阅恢复。前端模拟计时仅覆盖本地 revision 已变化到 DOM 文章出现；不含上游生成、缓存检测、备份、实际入库或正文图片归档。多页重读的速度也受本地服务响应影响。

最终统一集成必须分别记录：上游缓存提交→发现、发现→本地安全保存/版本变化、版本变化→列表可见、正文及图片→实际文件可打开。全部阶段实测通过才可宣称端到端两秒目标达标。旧数据保护、账号停止状态和未授权上游请求仍须独立核对。
