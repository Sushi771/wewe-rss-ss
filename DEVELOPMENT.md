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
