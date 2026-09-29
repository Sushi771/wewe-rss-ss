# 微信公众号订阅恢复：总控状态（2026-09-29）

## 最终目标

实现可自行审查、构建、部署的微信公众号订阅核心，支持添加公众号、后台与手动/定时更新、正文和图片保存、RSS、Markdown、Obsidian 与浏览器 ZIP 下载，保留旧数据；运行时不依赖第三方开发者的闭源中转或商业授权服务器。

## 基线

- 总控工作区：`main`，接手时本地与远端均为 `542bc70f2d04530cc84de1d10bb18e59b246252b`；协调与探针基线已推送至 `b39b7fae2343036ce120c823156059a12412f7bc`。
- 生产 SQLite 只读核验：`quick_check=ok`，12 个订阅、1447 篇文章；未写生产库。
- 私有 Gateway 配置文件存在且被 Git 忽略；不在协调文档记录凭据。
- 接手时四个未提交文件含探针错误诊断及交接更新，已保留并提交。旧执行窗口随后遗留的探针补丁由总控接管，模拟测试 23/23 通过，格式与差异检查通过，已推送。
- Codex 独立 task/worktree 创建请求未取得正式 thread ID；托管 worktree 注册卡在对大量忽略目录的 `AGENTS.override.md` 扫描并报错。当前三位执行者为本总控实际运行的子 Agent，各用独立 Git worktree/branch；不称作已创建的独立 Codex task。临时移出的忽略测试产物已原位恢复。
- 真实来源尚未通过目标号五篇验收；未部署线上可用订阅入口。

## 第一批执行 Agent

| Agent | Worktree / branch | 当前任务 | 状态 | 重要结论 | 输出 commit | 阻塞 | 下一依赖 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A 来源研究 | `C:/Users/ss/.codex/worktrees/weread-research/wewe-rss-ss` / `codex/research-weread` | 核实官方 skill、`/book/articles`、当前开源取文实现，写 `RESEARCH_WEREAD.md` | 运行中（子 Agent） | 待报 | 待报 | 无 | 给 B 明确的新实验条件 |
| B 隔离探针 | `C:/Users/ss/.codex/worktrees/weread-probe/wewe-rss-ss` / `codex/probe-runtime` | 审查探针诊断并仅执行有独立依据的最小实验，写 `PROBE_RESULTS.md` | 运行中（子 Agent） | 待报 | 待报 | 等待 A 的实验条件 | A 的认证与请求证据 |
| C 工程准备 | `C:/Users/ss/.codex/worktrees/provider-ready/wewe-rss-ss` / `codex/provider-integration` | 审查 Provider、身份、增量、保护及副本验收，写 `INTEGRATION_READY.md` | 运行中（子 Agent） | 待报 | 待报 | 无 | 真实来源字段与验收结果 |

## 总控下一步

读取三个执行 Agent 的真实结果，review、测试、整合，并据真实来源证据决定接入或下一条独立实验。
