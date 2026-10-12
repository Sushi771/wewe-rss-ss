# Development Guide

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

- **Pre-commit**: `lint-staged` and `husky` will automatically format your code.
- **CI**: Every PR to `main` is checked for linting and build success.

## 自动刷新入口维护（2026-10-12）

自动与手动批次缓存阶段统一走差量预检；生产补缺前必须通过副本演练及一致性备份。恢复已受理缓存使用持久 cache-only 模式，不能使用普通 resume 隐含提交未受理队列。实现、原值保护、索引、验收和固定产物本地维护入口见[自动刷新修复说明](docs/AUTO_REFRESH_RECOVERY_20261012.md)。
