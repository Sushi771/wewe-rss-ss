# Development Guide


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
