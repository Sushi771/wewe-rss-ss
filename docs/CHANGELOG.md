# Changelog

All notable changes to the WeWe-RSS project will be documented in this file.

## [2026-09-27] - 真实公开合集补采与发布时间修复

- 新增公开合集在线采集、分页和来源绑定，原“更新”可直接刷新绑定合集。目标“妈妈部落畅聊阁”实际取得两个合集、4 页、32 篇；范围仅限所选合集，不声称恢复完整公众号订阅或真实次条。
- 原文发布时间不再回退为采集时间或封面更新时间；取不到日期时保留旧值，新记录不伪造日期。真实原文正文可缓存供导出。
- 修复真实验收发现的跨源重复：合集时间与原文时间存在秒数偏差，改为核验原文 `biz/mid/idx`，保留旧短链 ID、正文和指标。分页、身份核验失败时不部分写库。
- 全范围指标覆盖统计控制热度排序；缺失显示未获取，公开合集总阅读量不冒充文章阅读量。导出不再把有链接却无指标的文章标为 WeChatDownload 指标来源。
- 新增数据库迁移只增加合集配置列；不重置数据库。详细真实浏览器验证、数据增量及尚未完成项见 [REAL_COLLECTION_ACCEPTANCE.md](./REAL_COLLECTION_ACCEPTANCE.md)。

## [2026-09-27] - 本地多篇采集与热度导出

- 新增 WeChatDownload 采集目录预览、批量导入和目录绑定。支持 UTF-8 CSV、HTML 正文、目录内图片，同次推送的不同 idx 分别入库；重复导入更新已有文章及指标。
- 公众号绑定目录后，“更新”和定时任务读取本地已采集文件。新文章仍需在下载工具中采集，不声称恢复了微信读书无人值守多篇订阅。
- 修复封面单篇被当作完整更新、错误标记历史已结束、批量更新吞掉单号错误的问题。未绑定目录时明确提示“封面预览”。识别上游 errCode / errcode 错误。
- 保存原文长链接，文章列表与 RSS 使用真实来源地址。优先用已导入正文导出 Markdown / Obsidian；缺正文时明确失败，不再把失败提示文本当成功全文。
- 新增阅读/点赞排序及热度 CSV；分别记录阅读、点赞、分享、评论、在看、收藏。源文件缺失项留空，0 保留为 0，10万+ 保留下限标记；记录文件时间，不冒充精确采集时间。公开示例没有收藏量。
- 修复 Obsidian 当日目录附件相对路径，导出文件名包含文章 ID 避免同名覆盖。
- Windows 启动脚本新增源码变更检测、数据库备份、构建及迁移，构建失败停止启动，避免继续运行旧 dist。
- 调查与使用说明见 [SUBSCRIPTION_RECOVERY.md](./SUBSCRIPTION_RECOVERY.md) 和 [LOCAL_COLLECTION.md](./LOCAL_COLLECTION.md)。真实账号采集、Edge 界面验收仍待完成。

## [2026-09-26] - WeRead Native Auth Architecture & MP Article Link/Content Fixes

### 🌟 Background & Root Cause

- **External Proxy 502 Outage**: Previously, the project routed login and sync requests through an external relay (`https://weread.111965.xyz`). That service permanently shut down, causing `502 Bad Gateway` and blocking all logins.
- **WeRead Deprecated `/web/mp/articles`**: The local article-list request returned `-2041`, so the adapter was changed to `/api/mp/cover`. September 27 correction: the official reader still references the article-list route; this error does not prove permanent decommissioning, and cover polling cannot provide complete multi-article synchronization.
- **WeChat Article Link "参数错误"**: WeRead returns compound review IDs (`MP_WXS_<mpId>_<token>`) and replaces URL-safe underscores `_` with tildes `~`. Appending these raw strings to `https://mp.weixin.qq.com/s/...` caused WeChat to return "参数错误".
- **Content Reading & Export Failures**: Direct requests to WeChat articles trigger anti-scraping verification challenges (`secitptpage/verify.html`), causing Markdown and Obsidian exports to fail.

### 🚀 Key Improvements & Fixes

- **Native WeRead QR Auth (`WereadService`)**:
  - Replaced external proxy calls with direct WeRead Web Auth (`GET /api/auth/getLoginUid` and `GET /api/auth/getLoginInfo`).
  - Generates official mobile confirmation links (`https://weread.qq.com/web/confirm?uid=...`), enabling seamless WeChat scanning without third-party reliance.
  - Implemented automatic token parsing and cookie renewal via `/web/login/renewal`.
- **WeChat Article Short Token Reconstruction**:
  - Added token extraction and character normalization: strips `MP_WXS_` prefix and restores `~` back to `_`.
  - Articles now generate valid short links (e.g. `https://mp.weixin.qq.com/s/<token>`) that open official WeChat articles cleanly with 0 errors.
  - Migrated existing database articles to use standard 22-character tokens.
- **Dual-Layer Fulltext Extraction & Markdown Export**:
  - Implemented fallback mechanism: direct WeChat fetch $\to$ WeRead native `/web/mp/content` API.
  - Attempts a WeRead fallback when direct HTML is unavailable. Both upstream paths can fail; this is not a guarantee of full-text availability.
  - Supports both `.rich_media_content` and `#js_content` DOM structures.
- **Accurate Article Publish Timestamps**:
  - Automatically parses real publication timestamps from article HTML scripts instead of defaulting to sync execution time.

## [2026-03-30] - UED/UI Optimization (Quartz Refactor)

### Added

- Created `UserIcon.tsx` component for the navigation bar.
- Added `docs/CHANGELOG.md` for project history.

### Changed

- **Typography**: Increased sidebar item font size to **16px** and headers to **14px** for enhanced legibility.
- **Navigation**: Moved "Account Management" to a dedicated **user icon button** in the top-right toolbar, separating configuration from content navigation.
- **Article List**: Redesigned the table layout to group "**公众号 · 发布时间**" into a unified metadata column, improving visual flow and reducing "spreadsheet-like" clutter while preserving table headers.
- **Layout**: Refined alignment between the article list and the main toolbar (removed container padding offsets).

### Fixed

- Vertical alignment of toolbar elements and article header title.
- Disparity between the development and production UI (port 5173 vs 4000).
