# 微信公众号订阅恢复：总控状态（2026-09-30）

## 最终目标

实现可自行审查、构建、部署的微信公众号订阅核心，支持添加公众号、后台与手动/定时更新、正文及图片保存、RSS、Markdown、Obsidian 与浏览器 ZIP，保留旧数据；运行时不依赖第三方开发者闭源中转或商业授权服务器。

## 总控决定

- main 只由总控整合。接手时本地和远端均为 542bc70。生产 SQLite 只读核验 quick_check=ok、12 个订阅、1447 篇文章；没有生产写库或服务切换。私有 Gateway 配置被 Git 忽略，未读取或记录 Key 值。
- Codex 创建/读取/继续/等待 task 能力存在，但第一批独立 task 延迟注册后与先开工的子 Agent 重复，重复 task 已停止。托管 worktree 创建因忽略目录扫描 AGENTS.override.md 失败；三位实际执行者是子 Agent，各有独立 Git worktree/branch。临时移出的忽略测试产物已恢复原位；没有多人改 main。
- 官方 Gateway /\_list 既有只读结果不含 /book/articles。旧 WeBook 的 i.weread.qq.com/book/articles 路径与失败的 /mp/chapters 不同，但 skey/vid 缺正常登录、可审查且持续可用的来源；本机脱敏证据和私有配置字段名也未证明有这组凭据。2025 登录示例使用占位值且互相矛盾，不以猜测凭据发请求。
- 腾讯公开合集 /mp/appmsgalbum 对非目标号匿名返回首 20、次 10 条且 30 个 key 无重复，但只能证明已知合集范围。目标旧库 194 行没有 album_id/hid；非目标公开原文单次匿名请求遇腾讯验证 302 后停止，未证明原文可反查合集。未取得目标“妈妈部落畅聊阁”五篇新的真实不同文章。
- 三位 Agent 的本轮工程与可执行研究已完成。目前没有目标号的独立实验条件，不创建空转后继任务。恢复条件是目标号自己发布的官方公开合集链接并核实覆盖范围，或腾讯官方开放/恢复有明确正常认证来源的跨号文章列表。若条件变化，先做目标五篇身份与发布时间验收，再推进分页、正文和接入。

## 执行 Agent

| Agent      | Worktree / branch                                                                    | 当前任务与状态                            | 重要结论                                                          | 输出 main commit                   | 阻塞 / 下一依赖                    |
| ---------- | ------------------------------------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| A 来源研究 | C:/Users/ss/.codex/worktrees/weread-research/wewe-rss-ss / codex/research-weread     | 微信读书及腾讯公开页面来源研究完成        | 非目标公开合集列表/分页可用，目标缺合集标识；非目标原文遇验证停止 | f1e9dba、7c4af87、874ac44、8081d93 | 等目标官方合集链接或新官方能力证据 |
| B 隔离探针 | C:/Users/ss/.codex/worktrees/weread-probe/wewe-rss-ss / codex/probe-runtime          | 探针诊断、离线认证字段核查及工程复审完成  | 无目标真实请求；指出并发快照测试失效和 URL 规范边界，均已修复     | b39b7fa、e793a84、6cb64fd          | 等明确的新目标实验条件             |
| C 工程准备 | C:/Users/ss/.codex/worktrees/provider-ready/wewe-rss-ss / codex/provider-integration | Provider、SQLite 保护、旧文章身份修复完成 | 副本迁移 12/1447、0 违反；短 ID 跨 sn 去重和旧字段保护已合入      | 392fe03、a7a961d                   | 真正分页/增量契约须等真实来源字段  |

## 整合验证与后续门槛

- 探针 Mock 24/24、保护 Python 16/16、主线相关 Jest 15/15 通过；C 独立 worktree 服务端全量 Jest 19 套/156 项及构建通过。CI c908337 与 874ac44 的 lint-test/private-image 均成功，运行分别为 https://github.com/Sushi771/wewe-rss-ss/actions/runs/36596331010 和 https://github.com/Sushi771/wewe-rss-ss/actions/runs/36596723918。
- 新来源若取到目标五篇，逐条核对号身份、稳定身份、原文 URL、标题和真实发布时间，再验分页、正文、图片、第二次更新、重启和新文章；近期订阅与订阅前全史分别验收。旧库/Mock/接口受理均不能代替这一步。
- 生产写入前重新核验一致性备份，在 SQLite 副本完成重复导入、旧字段保护、RSS/Markdown/Obsidian/ZIP、重启与第二个号。当前未满足门槛。
