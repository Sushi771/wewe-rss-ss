# 文章阅读正文内查找

## 用户用法

点击已缓存文章标题打开原有阅读弹窗，再点「正文内查找」。输入关键词后，正文中的匹配文字显示黄色，当前匹配显示橙色边框；控件显示当前位置和匹配数。↑/↓ 或查找输入框中的 Enter / Shift+Enter 可向前、向后循环跳转。查找输入框或查找控件获得焦点时，Escape 先关闭查找，保留阅读弹窗；再次按 Escape 按原有行为关闭阅读。

可在阅读弹窗的控件获得焦点时使用 Ctrl+F / Cmd+F 打开查找。正文 iframe 保留原有空 sandbox，键盘事件不会穿过这个隔离边界；在正文内点击后，请回到查找输入框使用上述快捷键。图片和链接仍在原有隔离正文内，不放入应用主页面。

仅查找当前已缓存正文的文本，区分大小写，按字面量匹配，不支持正则表达式。例如 `.*[x]` 会查找这些实际字符。空关键词不高亮，零结果显示「0 处匹配」并禁用导航。切换文章或关闭查找清空关键词及匹配状态。为避免极多匹配拖慢阅读，显示最多 5000 处；出现 `5000+` 时，可输入更长关键词缩小范围。

## 技术实现与成熟机制

没有新增 npm 依赖。复用现有 React 18、NextUI Modal，使用浏览器长期提供的 [HTML template](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/template)、[TreeWalker](https://developer.mozilla.org/en-US/docs/Web/API/Document/createTreeWalker)、[Blob Object URL](https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static) 和 HTML fragment / CSS `:target`。

- `ArticleReader.tsx` 仅接受原有详情查询已经返回的 `contentHtml`。不取外网文章、不调用正文补取或保存接口、不增加存储状态。
- `article-reader-find.ts` 在从未插入主 DOM 的 inert template 中扫描文本节点，包括正文根部的纯文本；排除 script、style、noscript、template、表单文本控件、SVG/MathML、`hidden` 和 `aria-hidden` 子树。属性、脚本和样式文本不参与匹配。相邻行内标签可组成一个匹配，独立段落不拼接。CSS 类控制的隐藏文本不做渲染可见性判定，属于这个无脚本隔离方案的限制。
- 关键词用 `String.indexOf` 查找，生成的 mark 使用 `textContent`，关键词不进入 HTML 模板、属性名、选择器或正则。只包装匹配文本，原来的图片、链接和排版元素保留。
- 高亮副本在内存中变成临时 Blob HTML，仍由 `sandbox=""` 的 iframe 展示。没有 `allow-same-origin`、`allow-scripts`、iframe DOM 读取或正文脚本。附加 CSP 禁止脚本、嵌套 iframe、对象、连接和表单提交。可信 base 保留原 srcDoc 的相对图片/链接解析基准；原有图片资源策略不扩展。
- 每个匹配使用随机前缀的锚点；改变 iframe URL 的 fragment 由浏览器原生滚动，CSS `:target` 标识当前匹配。导航不重建正文，换关键词时防抖 120ms。旧 Object URL 在重建或卸载时释放，取消的计时器不再更新已卸载组件。
- 搜索只改显示副本，不改缓存字符串、SQLite、Markdown、RSS 或离线导出。父 Modal 在查找打开时禁用键盘关闭，查找控件拦截 Escape，关闭后恢复原有行为。

## 测试与验收边界

离线 Node 回归：

```sh
node --test scripts/article-reader-find.test.cjs scripts/feed-avatar-reading-ui.test.cjs scripts/wechat-source-metrics-ui.test.cjs scripts/feed-reading-ui.test.cjs
pnpm --filter web build
```

`scripts/article-date-shortcuts-browser.test.cjs` 的无头隔离页面使用真实 React/NextUI Modal 和实际 helper，验证根文本、中文、emoji、跨行内标签、正则特殊字符、匹配上限、零结果、图片/链接保留、脚本/style/attribute 排除、上一处/下一处循环、Enter、Escape 保留弹窗、切换清空与卸载后全部 Blob 回收。原有阅读和指标测试只新增新组件的 mock，不改变断言。浏览器回归与 Node 测试已接入 CI；没有可用 Chrome/Edge 时明确跳过浏览器部分。

只读缓存验收的真实正文、截图、浏览器 profile 与原始输出留在忽略目录。尚未在 Safari/Firefox、不同系统或辅助技术中验收；正文 iframe 获焦后的快捷键限制与 CSS 隐藏文字计数限制如上所述。
