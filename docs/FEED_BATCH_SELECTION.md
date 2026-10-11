# 文章批量选择与导出范围

2026-10-11；本轮仅补齐 feeds 文章选择操作。复用已有 NextUI Checkbox、Button，不新增依赖，不修改后端采集、导出路径或笔记保护规则。日期与搜索功能由其他任务负责，本任务保留其共享源码改动及用户交接文件。

## 产品行为

- 工具栏始终显示“已选 N 篇”和“清空选择”。无选择时清空与本机批量导出按钮禁用；原私人线上模式仍不提供 Obsidian 导出按钮。
- 列表表头标为“全选已加载”，只选择当前筛选下已经加载的文章。分页加载更多保留原选择，新加载文章保持未选；再次全选才纳入它们。
- 部分文章选中时显示半选；全选核对 ID 集合，不能用“选中数等于行数”代替。即便数量相同、ID 不同，也不会显示全选。
- 公众号、搜索、分组、日期、排序或时间方向变化会清空选择。重新读取列表后消失的 ID 在绘制前移除，计数与导出不含隐藏选中项。
- 导出期间禁用选择与清空，并用同步锁防止连续提交。导出只遍历点击时的已选 ID 快照；全部成功清空原选择，中途失败停止并保留原选择。若期间切换筛选，旧导出完成不清掉新作用域的选择。
- Checkbox 提供全选及每篇文章的可访问名称，沿用组件原生键盘行为；工具栏可以换行，窄屏仍能操作计数、清空和导出。

## 技术实现

`apps/web/src/utils/feed-selection.ts` 计算已加载 ID、可见选中 ID 及全选/半选。`list.tsx` 使用 `useLayoutEffect` 移除不可见选中项，分页只改变已加载集合，不扩展选择。复选框导出期间禁用。

`index.tsx` 保留日期/搜索/分组清空 effect、完整查询作用域 key 和原导出 mutation；新增计数、清空、`useRef` 提交锁及成功后的选择身份检查。后端接口、输出目录、Markdown/图片生成及旧笔记保护均沿用现有实现。

共享 list/index 的选择区域已与日期及搜索任务确认写权，改动完成后释放。未修改 `docs/DEVELOPMENT_HANDOFF.md`，未提交、推送、重启或部署；由父任务统一集成发布。

## 验收与复现

自动回归：

```powershell
# 指定可写临时目录，避免 Windows 沙箱默认 Jest 缓存重命名限制。
$env:TEMP = 'C:\Users\ss\AppData\Local\Temp'
$env:TMP = $env:TEMP
pnpm --filter server test --runInBand --cacheDirectory C:\Users\ss\AppData\Local\Temp\wewe-feed-selection-jest-cache --runTestsByPath src/trpc/feed-batch-selection-ui.spec.ts src/trpc/article-list-ui.spec.ts src/trpc/article-local-layout.spec.ts
node --test scripts/feed-export-date-ui.test.cjs
pnpm --filter web exec tsc --noEmit
pnpm --filter web exec eslint src/utils/feed-selection.ts src/pages/feeds/list.tsx src/pages/feeds/index.tsx
```

- 三套 Jest：31/31（新增选择回归 19 项、原列表 UI 8 项、原本地导出 4 项）。覆盖部分/全选、同数量不同 ID、重复行 ID、加载更多、消失行、筛选切换、清空、连续提交、失败保留及晚完成保护。
- 原导出日期/编辑提示测试：3/3；适配同步锁与函数式成功清空，原提示行为保持。
- 实际导出测试执行当前前端 handler、原 tRPC router 和 Markdown/图片 exporter。缓存均为合成正文/data URI 图片，只写系统临时隔离目录；核对已选 ID 与实际查询/保存 ID 一致，未选文章不导出，实际图片字节正确，失败保留选择及隔离模拟手写笔记。禁止 fetch/axios 出站，未触碰用户笔记或生产数据库。
- web 类型检查、局部 ESLint、六个相关源码/测试文件 Prettier 检查和局部 `git diff --check` 通过。本任务未运行共享 production build；联合构建由日期与集成任务负责。

真实页面回归复用日期任务隔离脚本：对实际 SQLite 进行只读一致性备份，原编译 router 只读副本，当前前端源码在独立随机本机端口运行；独立无登录 Edge 测试配置只允许该端口 GET，禁 POST/外网。共 1713 篇存量，10 项检查通过：零计数/禁用、行键盘选择与半选、键盘全选前 20 篇、加载 40 篇仍仅选 20 篇、键盘清空、日期切换、时间方向切换、390px 无横向溢出、桌面保留选择、重载清空。窄屏截图已人工查看。

浏览器导出 mutation 调用数为 0；真实写文件由上述临时目录自动测试覆盖。28 个微信头像 GET 在发送前拦截，无平台取文、登录或新增订阅请求。页面原始截图及数据库副本包含私人内容，只保存在 Git 忽略的 `output/playwright/feed-selection-20261011/`，不得提交。

验收限制：未执行用户真实目录导出、生产刷新、部署或远端 CI。本项功能无剩余开发阻塞；统一发布仍由父任务执行。
