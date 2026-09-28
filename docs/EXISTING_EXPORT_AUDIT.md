# 现存文章导出与图片审计（2026-09-28）

## 当前生产检查点

导出盘点只读取生产 SQLite 和用户配置的 Obsidian 目录；没有触发 `saveToObsidian`、
正文重试、微信 UI/剪贴板或真实采集。生产库仍为 12 号、1433 篇，`integrity_check=ok`，
三份新增迁移均已应用。妈妈部落畅聊阁 180 篇，其中 8 篇有缓存正文；其现存最近
20 条仅 3 篇有缓存正文、15 条有 `source_url`。苏洵书院升学指导 104 篇，
其中 1 篇有缓存正文；其现存最近 20 条仅 1 篇有缓存正文、0 条有 `source_url`。
这些“最近”仅按当前库的发布时间排序，不证明真实公众号最新 20 篇已覆盖。

用户 vault 中有两份文件名 ID 与现存文章吻合的 Markdown：妈妈号
`K_oKauPpwhSyavBWQXFMKw` 与苏洵号 `hNPPErPp7WPsyJfjUMtmuw`。
两份已存正文 HTML 的 13 个图片 `src` 均指向 `mmbiz.qpic.cn`；对应 Markdown
引用了 13 个 `attachments/image_*` 本地文件，路径均在相同日期目录下，
文件存在且 JPEG/PNG/GIF/WebP 文件头有效，没有 `/proxy/image` 引用。
两份 Markdown 的 SHA-256 分别为
`0d5efbdef7ac61c8190377dafe0393e9f538772763bd5655c737209f5b34aa7b` 和
`7a7ed7e593ea21e6909fc1a7c500b260e4f6e423493f69247912797ddb0ca38f`；
生产重启及接口验证后未变化。妈妈号这篇有库内 `source_url`；苏洵这篇没有
`source_url` 或 `verified_source_url`，不能由图片可用性反推原文身份已核实。
其余 vault 文件及尚未导出的文章不在本次覆盖范围内。

## 发现与修复

旧 `article.exportMarkdown` 在返回浏览器 Markdown 时，额外向当天 Obsidian
目录写同名文件。它使用代理图片 URL；若同一天已调用 `saveToObsidian`，
再次导出可能覆盖原本含 `attachments/` 本地图片引用的 Markdown。
现改为只返回 Markdown。写 vault 仍由显式 `article.saveToObsidian` 执行。
隔离 SQLite 的两个测试套件 20 项通过：无 vault 时调用浏览器导出不会建目录，
已有 Obsidian 文件在浏览器导出后逐字不变。

新固定产物 `.local-releases/2026-09-28T07-33-41-582Z-d45394439895`
在当前 schema 的备份副本执行 `restart --rehearsal --mode start`，审计
`controlled-restart-1790581126983-69728/summary.json` 为 `passed=true`。
旧 schema 专用 `rehearse.cjs` 对当前库因没有待迁移项拒绝，不作为本轮失败部署。
生产受控跨版本重启审计 `controlled-restart-1790581408694-69172/summary.json`
为 `passed=true`，旧 PID 30568 已退出，新 PID **13464** 自北京时间
2026-09-28 15:43:38 独占 4000。停止后在线备份 SHA-256 为
`9e59b69f6216a1512657d8b29d8bcdb142dff29fa5073d1e020a92d958a616b1`；
重启后独立只读逐字段基线比较相等，12 号/1433 篇、迁移 pending 空。
`/dash` 与两号 RSS HTTP 200，`?limit=20` 各返回 20 条。

生产本机 `article.exportMarkdown` 对上述妈妈号缓存正文返回 HTTP 200、
2589 字符和 7 个代理图片 URL；同一调用前后配置 vault 的 Markdown/图片
文件路径及 SHA-256 全等。这里只验证了浏览器导出的无写入行为；没有重新
执行生产 Obsidian 写入或网络图片下载。图片下载失败时现有 `saveToObsidian`
仍可能退回代理 URL，不能把任何未来导出成功一概解释成图片已本地化。

## 开机任务评估与剩余范围

本机未发现 WeWe-RSS 的计划任务，用户 Startup 目录也没有其快捷方式。
当前 `restart.cjs --mode start --production` 已在副本验证冷启动、端口冲突拒绝、
一致性备份和固定产物核验，可作为用户登录后的任务动作。注册前需让任务的
固定产物路径随受控部署更新，并验证重复登录、4000 已占用及任务运行身份；
目前没有注册任务。它要求共享 `USER_PAUSED`，定时采集仍关闭，因此开机启动
只恢复阅读服务，不会解除微信暂停或证明无人值守采集。

真实最新 20 篇唯一文章、妈妈号后苏洵号重复新增 0、手动与定时持续更新、
未覆盖内容类型及所有文章图片仍待验收。微信 UI/剪贴板继续 `USER_PAUSED`；
获新明确授权的首次仍仅最多 60 秒单篇无写库验证。
