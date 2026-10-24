# Development Guide

## 小红书订阅开发（2026-10-24）

小红书开发以本机交付源码 `f609bda0334f17f6c28ff84020d31cd5c47f3417` 为基线；维护入口见[开发交接](docs/xiaohongshu/DEVELOPMENT.md)、[技术说明](docs/xiaohongshu/TECHNICAL.md)和[验收记录](docs/xiaohongshu/ACCEPTANCE.md)。原生来源默认关闭，已完成271项后台及50项关联前端合成回归；严格主页schema和加密会话迁移已实测，列表及真实账号3篇归档仍待完成。页面20条追加基于后端全量查询。GitHub采用基于交付分支的draft PR，仅包含本任务差异，不合并或部署；聚焦离线CI见 `.github/workflows/xhs-subscription-ci.yml`。

## Owner Web session stops (2026-10-03)

The latest-item source validates the bound owner session before interpreting a
historical stop. A changed Web login does not grant directory access or authorize
another refresh. Keep the original stop and response intact and identify the
operation by its initial `wr_vid` and `wr_skey`. Auxiliary cookies, file paths and
capture timestamps do not identify a new authentication session. Legacy stops
without an authentication fingerprint remain blocked if ownership is uncertain.

Explicitly authorized, saved single-article evidence can be checked offline. The
helper returns a state copy with verification for that authentication session and
keeps refresh blocked. It never writes article data or clears another source's
stop. Store evidence and credentials in ignored private storage. Preserve the
state lock and 15-minute cooldown.

Run focused regressions with
`pnpm --filter server exec jest --runInBand owner-weread-latest owner-weread-session-state owner-web-cookie-lifecycle owner-web-search collection.service`.
Build with `pnpm build:server`. Building and pushing source do not update the
running frozen release. Deployment separately selects the reviewed release,
retains the database and private binding, and restarts the existing backend; no
second service or port is needed.

The saved 2026-10-03 test established one body and one PNG. Directory requests
remain stopped by the existing `-2041` evidence. The original refresh entry has
not passed the latest-ten-article acceptance test. Do not rerun the consumed
live-test budget as part of tests, builds or deployment.

## Project Structure

- `apps/server`: NestJS backend.
- `apps/web`: Vite/React frontend.
- `scripts/`: Maintenance and utility scripts for administrators and developers.

## Productivity Commands

Use `pnpm` to run these common tasks:

- `pnpm dev`: Start both server and web in development mode.
- `pnpm fmt`: Format the entire codebase.
- `pnpm lint`: Run linting across all packages.
- `pnpm accounts:check`: Check existing accounts.
- `pnpm feed:check`: Test feed accessibility.
- `pnpm feed:debug`: Debug feed issues with detailed logs.

## Quality Gates

Release-tool changes must also follow [isolated build and strict search rollback](docs/ISOLATED_RELEASE_BUILD.md).
Passing gate tests or CI does not establish that a frozen rollback package starts
after migration21; the actual synthetic upgrade/application rollback remains a
separate acceptance requirement.

- **Pre-commit**: `lint-staged` and `husky` will automatically format your code.
- **CI**: Every PR to `main` is checked for linting and build success.

## 自动刷新入口维护（2026-10-12）

自动与手动批次缓存阶段统一走差量预检；生产补缺前必须通过副本演练及一致性备份。恢复已受理缓存使用持久 cache-only 模式，不能使用普通 resume 隐含提交未受理队列。实现、原值保护、索引、验收和固定产物本地维护入口见[自动刷新修复说明](docs/AUTO_REFRESH_RECOVERY_20261012.md)。

## 导出增量与范围合同（2026-10-13）

同目录完整文章在媒体准备前跳过，缺图按回执补齐并保留原正文；界面区分新增、跳过、补齐、失败。全周期操作使用“导出当前筛选全部”，ZIP独立区分整号与当前筛选快照。产品行为、回执保护、取消边界与离线验收见[导出说明](docs/INCREMENTAL_ARTICLE_EXPORT.md)。
