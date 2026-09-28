# 电脑微信正文状态与元数据保留（2026-09-28）

后续单元已实现本机单篇正文重试、可信身份绑定和独立失败结果，见
[单篇正文重试检查点](SINGLE_ARTICLE_BODY_RETRY.md)。下文“尚无单篇入口”为本检查点的历史状态；
生产仍未部署，权限与真实验收边界不变。

## 本轮结果

已修复“20 篇中任一正文为空便丢弃整批已核验元数据”的工程缺口。
这是隔离验证完成，**尚未部署或通过真实微信采集验收**。没有微信 UI、剪贴板、新上游请求、生产写入、迁移或重启。

- 列表仍须提供 20 篇唯一文章，原文须同时证明目标账号、biz/mid/idx、短链、标题、发布时间及普通列表时间顺序。
  原文容器存在但清洗后没有正文时，保存元数据，正文保持 null；不从旧库补数量。
- 页面请求失败、原文结构缺失、未知日期、身份冲突、重复身份和验证/错误页面仍使整批失败，不写文章。
  新增结构化验证/错误界面检查；不能凭空正文推断“已删除”“付费”等原因。
- 清洗后再次检查正文是否含文本或允许的图片。脚本、iframe、无效图片及空白容器不算取得正文；允许的纯图片正文仍可缓存。
- 新增 nullable `Article.lastBodyStatus`（数据库 `last_body_status`），值为 available / unavailable。
  它表示最近一次通过元数据核验的桌面原文正文结果，与已有 `contentHtml` 缓存独立。
  旧行迁移后为 null，不回填猜测；该字段不代表任何一次失败请求的即时状态。
- 已有 ID、非空正文、图片/封面、来源及指标继续保留；缺正文不会抹掉旧缓存。
  状态、文章及通道在同一文章事务内写入；状态相同且无实际内容变化时不更新文章时间戳。

## 结果与使用入口

采集结果和 `Feed.lastCollectionResult` 分别记录：

| 字段                                     | 含义                                          |
| ---------------------------------------- | --------------------------------------------- |
| articles                                 | 当前窗口已核验的唯一文章信息数                |
| bodyFetch.succeeded / unavailable        | 本次原文正文取得数 / 未取得数                 |
| bodyCache.available / retained / missing | 窗口内可用缓存数 / 沿用旧正文数 / 仍缺正文数  |
| bodyUnavailable                          | 本次未取得正文的实际存储 ID，以及是否仍有缓存 |

总体保持 `partial`、`complete:false` 和 `article-tab-latest-20-unique`，不将“文章”页当全部内容类型。
页面沿用最近操作消息显示上述数量，article.list/byId 提供独立状态。
`verify-desktop-evidence.ts` 的只读证据输出也包含正文计数与每篇状态，不输出正文原文。

普通更新再次经过同一身份核验，可以补齐空缓存；即使新请求取得正文也不替换旧非空正文。
普通更新仍遵守桌面暂停，不因此恢复 UI。**尚无只重试单篇正文的独立入口**：
当前重试要求文章仍在新的 20 篇窗口中，窗口外缺正文条目需要后续补齐这个入口。

RSS 遇到已记录 unavailable 且无缓存的文章仍保留标题、原文链接和日期，正文显示明确提示，不隐式访问上游。
Markdown/Obsidian 对这种条目返回可见的正文不可用错误，不生成空导出；已有缓存仍照常导出并本地化图片。
未记录状态的旧文章保持原有导出获取流程。这里的提示并不意味着受限正文一定能恢复。

## 验证与证据

服务端 **14 套 / 176 项**全部通过，比上轮净增 17 项。
新增跨组件用例使用真实解析器、临时 SQLite、真实事务、TRPC、RSS 和 Obsidian 文件输出，网络和桌面均 mock：

- 20 篇中 3 篇正文缺失，元数据全保存，1 篇沿用旧缓存、2 篇正文为 null；正文/图片/来源/指标保留。
- 重复更新新增 0、更新 0，文章时间戳也不变；后续正文成功补空缓存，再次更新仍为 0。
- 第 20 篇日期无效整批无文章写入；SQLite trigger 中止末条时，前面文章和状态一起回滚，之后可以重试。
- RSS 保留缺正文条目，不发正文请求；旧缓存 Markdown/Obsidian 输出正常，本地 PNG 字节一致。
- 空白、脚本、无效图片不算正文；原文结构、身份、日期和验证页防线保持。
- 两个新增迁移后，旧 raw 全字段仅增加 nullable 字段，其余值不变。

定向服务端 ESLint、Prettier、后端隔离 TypeScript 构建、前端 TypeScript 和证据脚本类型检查通过。
没有改前端页面代码或重新构建前端包；没有改 helper，不重跑已通过的 PowerShell/Python 专项。
项目没有 Makefile，当前环境没有 make/markdownlint，不能声称 `make lint` 通过；文档用现有 Prettier 检查。

本机证据在 Git 忽略目录 `output/playwright/body-state-audit/`：
`server-tests.json`、`server-tests.log`、`production-before.json`、`production-after.json`、
`production-preservation.json`、`production-summary.json`。

## 本机构建与生产边界

新迁移为 `20260928020000_article_body_status`，仅用于临时库。
生产既没有该列，也没有上一轮 `collection_channel`；不能直接启动新代码连接旧 schema。

本机 Prisma CLI 5.22.0 / Client 5.10.1 的版本差异和运行中引擎锁仍存在。
本轮使用现有 5.10.1 generator，在上述忽略目录中生成独立 client，复制匹配的现有 5.10 引擎，
并核对引擎 SHA-256 相同。没有修改已安装 client、覆盖运行中 DLL 或安装依赖。
隔离配置保留 TypeScript 检查，并将 `@prisma/client` 指向该独立目录。
初次测试配置漏了 Jest 类型根、跨组件 mock 漏了 axios.create、初次构建配置未正确继承 test 排除规则，
均已修复后完成上述最终验证；没有关闭类型检查、删断言或改产品逻辑绕过。

复现入口（本机既有依赖）：

```powershell
node output/playwright/body-state-audit/prepare-validation.cjs
node apps/server/node_modules/jest/bin/jest.js --config output/playwright/body-state-audit/jest.config.json --runInBand
node apps/server/node_modules/typescript/bin/tsc -p output/playwright/body-state-audit/tsconfig.build.json --outDir output/playwright/body-state-audit/server-build-final
node apps/server/node_modules/typescript/bin/tsc -p output/playwright/body-state-audit/tsconfig.web.json --noEmit
```

该脚本与配置只属于本机验证证据，不是生产部署方案。正式部署仍须新建并核验一致性备份、取新基线，
协调匹配的 Client/引擎生成，再迁移两个字段并重启。当前安装的 client 尚无本轮新字段，普通构建需完成对应生成。

本轮开始与结束均为 **12 号 / 1430 篇**，所有旧保护字段零差异，完整性 ok。
妈妈号 180/8 正文、苏洵 104/1；既有 20 篇证据仍缺 13 篇入库。
`.paused=USER_PAUSED` 未改变，限定单篇授权未答复。真实单篇/20 篇/第二号/持续更新与新通道导出仍未验收。
获得新 UI 授权后，第一次仍只能 60 秒、单篇、无写库的标签关闭验证；新窗口授权不解除此边界。
