# 文章搜索条件提示（2026-10-11）

## 产品

关闭搜索框或按 Esc 后，关键词继续筛选文章，并在列表上方显示 `搜索：xxx`。点提示右侧关闭按钮即可清除关键词、恢复其它现有筛选条件下的结果。重新打开搜索框时隐藏提示，避免重复显示；空关键词不显示提示。长关键词在窄屏截断，悬停可查看完整内容，清除按钮保持可见。

## 技术

仅修改 `apps/web/src/pages/feeds/index.tsx` 搜索局部，复用现有 NextUI `Chip` 的 `onClose`，不新增依赖。输入框与 Chip 共用 `handleClearSearch`；`handleSearchChange` 同步更新原始关键词并清空文章选择，防止沿用旧选择导出。关闭和 Esc 仍只隐藏搜索框，不清除关键词。

不 trim、不防抖、不更换搜索接口或标题/正文搜索语义。原有 `ArticleList` 的 key 包含关键词，关键词变化后重建列表并从首批查询；保留日期、文件夹、顺序状态及其请求映射。与并行日期、批量选择功能集成时使用最新文件局部补丁，保留清选择 effect、批量导出防重和选择禁用状态。

## 测试

已通过 TypeScript（`pnpm --filter web exec tsc --noEmit`）、页面 ESLint、Prettier 检查。隔离构建：`pnpm --filter web exec vite build --outDir ../../output/playwright/search-filter/build`，成功；现有 Browserslist、依赖注释和大 chunk 警告不阻断构建。

浏览器回归使用当前实际页面、虚构 tRPC 数据和独立无头 Edge，阻止外部网络及所有非 GET 接口，不访问生产 SQLite、不采集、不更新。私有脚本与结果位于被 Git 忽略的 `output/playwright/search-filter/`；使用现有私有 Playwright runtime，未安装包。

上述浏览器回归全部通过（7 组）：关闭/重开不重复显示、Esc 保留关键词、空结果仍可清除恢复、第二页与选择重置、快速输入最终值与输入框 clear、日期与顺序组合清除不丢其它条件、390px 长关键词不横向溢出且可清除。所有未预期请求和页面错误均为零；上线后的真实数据与桌面目视验收未执行。

本项不修改 `docs/DEVELOPMENT_HANDOFF.md`，不提交推送、不重启、不部署。生产版本仍需由父任务统一集成与验收。
