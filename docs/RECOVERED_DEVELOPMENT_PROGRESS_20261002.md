# 找回会话后的开发进度（2026-10-02）

本轮按用户要求仅读取旧会话、记录进度和补同步 GitHub，不继续开发、部署、真实平台请求或聊天关联修复。此前等待退出的关联修复器已停止。

## 记录来源与判定方法

按本机会话元数据中的项目工作目录，读取已找回的 96 个 JSONL 会话文件，共提取 1834 条用户及助手消息（含研究子任务和当前恢复聊天）。结合 Git 提交、现有精简交接及运行说明，以最新主执行会话的最终结果覆盖早期阶段结论；未结束的会话和子任务建议不算已交付成果。

原始会话、提取消息、截图、关联修复备份及同步审计仍在 Git 忽略的 `private-data/chat-recovery-20261001/` 等私有目录，未上传。本文只保存脱敏进度与提交标识。

关键会话：

- `01a0f28e-81f9-78b1-98f1-4f0af9e108ef`：最新原 4000 入口修复，最终结果与 2026-10-01 精简交接一致。
- `01a0f1d7-5edb-7432-ac63-5a04f5aa2069`：单号保存与缓存阅读实现；4120 是隔离缓存试用，早期结果不代表正常在线订阅。
- `01a0f1a5-2436-78c2-a889-e9ce69c84505`：真实号名搜索自主发现漏文；搜索索引时间不作为发布时间。
- `01a0f178-a20f-72f3-b05f-ee1ef77dea4b`：纠正固定合集覆盖不足、失败状态与账号入口问题。

## 最新已完成成果

截至最后开发会话及提交 `ba98caec76233b6dd7689c2d119414d616d34464`：

1. 原 `/dash/accounts` 和导航恢复，登录直连腾讯；私人登录保护、凭据仅后台私存、备份及旧停止证据保留。登录恢复不等于公众号目录恢复。
2. 新正常扫码条件下，腾讯 `/web/mp/content` 返回目标号真实正文。稳定身份为 `WX_3895431412_2247493556_1`，号标识为 `MP_WXS_3895431412`。
3. `owner-weread-latest` 读取腾讯 `/api/mp/cover` 当前提供的一篇，再取得正文，接回原手动更新与定时任务的同一保存流程；每次最多两次取文请求，15 分钟冷却，有跨进程锁及持久停止。
4. 原 4000 入口已在最后开发会话中受控部署，原按钮真实新增《市重率不相上下，华育世外中考成绩大PK！》，正文及真实内联图片已在原阅读弹窗显示。该结果来自历史实测，本轮没有重新请求或验证服务运行。
5. 最后实测全库 1448 篇，目标号 195 篇、36 篇缓存正文；原有 1447 篇文章及其他账号、订阅逐字段未变，SQLite 完整性通过。上述数量是历史基线，不当作 2026-10-02 当前数据库读数。
6. 既有 Provider、正文图片保存、RSS、本地 Markdown/Obsidian/ZIP 导出、冻结发布及回滚成果保留。4120 隔离缓存试用与原 4000 生产入口分开。

历史验证记录：服务端 27 套 240 项通过，新增手动/定时路由相关 18 项通过，前端类型检查、前后端冻结构建及改动服务端 ESLint 通过。当前源码历史基线 `ba98cae` 的 [GitHub CI](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36758235673) 已在本轮重新查询为成功；这些结果不等于完整订阅已恢复。

## 尚未完成与有效边界

- **公众号级多篇最新文章发现仍未恢复。** 固定合集仅覆盖所选合集，搜索可能漏文；cover 仅提供一篇，不能保证微信中的最新文章齐全。
- 最新正常会话的 `/web/mp/articles` 返回业务 `-2041` 后已停止；公众号原文的 302 腾讯验证及其他认证拒绝停止记录继续有效，不重复这些请求。
- 原文正常扫码形成的新认证条件已证明单篇正文可取，不能外推目录、分页、所有公众号或全史可用；旧失败也不能外推全路线永久失效。
- 最后会话未证明全部 12 个旧订阅恢复，未交付私人线上 HTTPS 站点。保留原文章、可信时间、正文图片、有效指标及导出；缺失指标不造值。
- 2026-09-29 自主管理自建路线覆盖此前付费采购、桌面微信采集和公司多人系统阶段要求；2026-09-30 晚的原入口修复要求又取消独立五篇/导出验收作为该轮修复前置。旧提示词不重新执行。

本轮只保存这些缺口，不继续验证或修复。更多实现边界见 [精简交接](DEVELOPMENT_HANDOFF.md)、[当前任务](PRIVATE_ONLINE_DELIVERY_TASK.md)及[运行说明](SINGLE_ACCOUNT_SEARCH_RUNTIME.md)。

## GitHub 同步核对

开始时主工作区干净，`main` 与实际远端 `origin/main` 均为 `ba98cae`，没有主线漏推或远端新增提交。

另有 29 个本地历史研究分支包含尚未被任何 GitHub 远端分支覆盖的 146 个不同提交。检查其新增可达的 151 个文本 blob，未发现数据库、私有证据、环境文件、截图、归档文件或所扫描的密钥格式；按原分支名补推，保持主线不变。详细分支与远端 SHA 核对清单见下表。分支上传只保存历史成果，不把研究候选或模拟验证合并为生产功能。

旧 worktree 注册仍在，但列出的目录已不存在；未清理这些注册，也无法据此恢复未提交草稿。已经提交的成果仍可由分支读取。

已核对以下 29 个远端分支的 SHA 与本地一致：

| 分支                                     | 已核对的远端提交                           |
| ---------------------------------------- | ------------------------------------------ |
| `codex/album-export-rehearsal`           | `d49c930c114bedfe9f81838cfa4b55db38bdf7be` |
| `codex/album-provider-loop`              | `50d386ff605e123ec3f59a8cd28630f05f8bd362` |
| `codex/book-articles-auth-followup`      | `dec42b9c20aa4ecb0d515a6f6d1bfb53074509bc` |
| `codex/image-byte-export-validation`     | `64d6dcbb9932b5bf787aebb58957ac28e89899a0` |
| `codex/mobile-link-source`               | `2d4008bcc86d2f7658ef39eb7430f033b504a680` |
| `codex/mobile-refresh-runner`            | `56164bb5d88ce2f40fdd85bbebe230d27b0798fd` |
| `codex/mobile-web-search-probe`          | `00bf50bb2292d799a9055d6b4356731e1ea25b5f` |
| `codex/playwright-browser-session-probe` | `1b561c1bfdccdc3d115f4b86bb24e827b3458ca3` |
| `codex/probe-runtime`                    | `356752df04fe4390e417199e73af86213fb291f9` |
| `codex/provider-integration`             | `35de03d99952f58eb70a703110f28dcd54eff8ed` |
| `codex/public-page-discovery`            | `079c2d247f69f33b1a4a9d66c70461fa0254b270` |
| `codex/refreshed-mobile-cursor-page`     | `ea44846d5a2e96d668a7a9aeaf6b930ab8200749` |
| `codex/refreshed-mobile-target-search`   | `82929ebd0003a62fc10f594feabd7455ee60f7b6` |
| `codex/refreshed-mobile-web-health`      | `5b30a7835e413a5634d63eabec23258659e608da` |
| `codex/renewal-2013-source`              | `23c9fb2e2222b4c5e1e1dd1aa2d34604e314e956` |
| `codex/research-weread`                  | `2f0f4ad12b595fa21c6335e1d167bd1861b06e93` |
| `codex/search-url-identity-diagnostic`   | `0603372c0c754379aa0b74bdfaca2f4addbfda7f` |
| `codex/search-url-private-candidates`    | `c220b6781b07ef8d793f59c4872bd44ea5c761d0` |
| `codex/sogou-public-index`               | `76f1f6a1eeec48a0f6f09c5738d39fe9b8c826be` |
| `codex/source-candidate-matrix`          | `c904ba17ca271447a267792ae89b65d95a996ea8` |
| `codex/target-album-probe`               | `6d1bb818ef47b868550938f4fa3c6beadf4edb76` |
| `codex/verified-article-seed-probe`      | `de034182e0a6b15136b70a079186b96ca1d84cb7` |
| `codex/web-search-broker-probe`          | `6f82b8b16dfd1aead21f1a0403c0194543fef482` |
| `codex/weread-browser-login-launch`      | `fc0efcdd4c442eeb4490fb3b316d1fe941e9c10f` |
| `codex/weread-mobile-web-probe`          | `b97a57621216869bf75abb612cead0a96440d346` |
| `codex/weread-mp-sample-provenance`      | `ee75f45559243fc38630624874410728d006c2ca` |
| `codex/weread-natural-scroll-probe`      | `520e67c450e55aea720efa3a497717d479854cde` |
| `codex/weread-renewal-2013-source`       | `e0c39f3d90029ab69592ac98e3fda1d563f98618` |
| `codex/weread-renewal-ticket-probe`      | `a7d6d1fb02e6e0a29e54764a920b860bb7eb16f5` |

本轮恢复进度文档与精简交接入口随主分支提交同步，最终提交与 CI 结果在交付时核对。原始聊天和私有提取文件不入 Git。
