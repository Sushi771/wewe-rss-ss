# 文章日期快捷选择

原有“日期筛选方式”下拉框新增快捷日期分组，复用原生下拉和日期输入，没有新增常驻按钮或依赖。

- 今天：上海当天的单日。
- 近7天（含今天）：上海当天及前六个日历日。
- 本月（至今天）：上海本月1日至今天，排除未来日期。

每次选快捷项时重新计算 `Asia/Shanghai` 当天；页面开着跨过上海午夜后，再选会得到新日期。选择后下拉显示所选快捷项，输入框直接显示实际日期，可继续手动修改。订阅页浏览记忆按相对日期保存快捷含义，重新挂载、获得焦点及每分钟检查上海跨日时重算。手动编辑日期后为固定范围，不随午夜变化。详见 [浏览记忆](FEED_BROWSE_MEMORY.md)。清除日期恢复原有空日期筛选，公众号、分组、关键词、排序保持不变，已选文章通过原有页面处理器清零。

## 技术与验证

只扩展 `ArticleDateFilter.tsx` 与 `article-date-selection.ts`。快捷项调用同一 `onChange`，仍由 `dateSelectionFilter` 生成 `dateStart/dateEnd`；现有查询键、分页、导出和清零机制继续复用。浏览记忆增加相对日期标记与会话保存，详见 [技术说明](FEED_BROWSE_MEMORY_TECHNICAL.md)；没有新增服务端筛选、数据库修改、采集或新增订阅动作。

`scripts/article-date-shortcuts.test.cjs` 的三个测试覆盖上海午夜、跨年、闰年/平年二月底、月初、七天包含边界、既有查询键、清除，以及从实际 index 源码提取的 `onChange` 对选择清零。`scripts/article-date-shortcuts-browser.test.cjs` 使用现有 Vite/React/Tailwind 与隔离无头 Chrome，实际渲染组件，验证三个快捷项、点击时重新计算、组合筛选参数、日期展示、手动编辑、清除和390px无横向溢出。

运行：

```powershell
node --test scripts/article-date-shortcuts.test.cjs scripts/article-date-shortcuts-browser.test.cjs
```

已验证三个单元/页面处理器测试及一个浏览器组件测试，全部通过；改动组件和工具函数的局部 TypeScript 检查通过。浏览器用合成页面状态，不连接产品、数据库或上游；这不代表完整产品端到端或线上验收。缺少 Chrome/Edge 时浏览器测试会显式跳过，应由集成负责人补验。

浏览器回归也使用实际阅读组件和 NextUI 弹窗验证正文查找、字面量及跨行内标签、上一处/下一处、清空、切换、Escape、空 sandbox 和 Blob 回收。新增测试接入 CI；只读缓存的完整产品页验证另由本地发布流程完成。
