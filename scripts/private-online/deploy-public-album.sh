#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_dir"
test -f .env.public-album || { echo 'Missing private .env.public-album' >&2; exit 1; }
# Start with an existing accepted copy. Never create an empty replacement database.
test -f private-data/sqlite/wewe-rss.db || { echo 'Missing accepted SQLite copy' >&2; exit 1; }
chmod 600 .env.public-album
chmod 700 private-data private-data/sqlite
compose=(docker compose --env-file .env.public-album -f docker-compose.public-album.yml)
"${compose[@]}" build app
# The existing backup component checks integrity and a reopened online backup.
"${compose[@]}" run --rm --no-deps app python3 /app/scripts/backup-sqlite.py \
  --database /app/data/wewe-rss.db --backup-root /app/data/backups
"${compose[@]}" stop app
"${compose[@]}" run --rm --no-deps app ./node_modules/.bin/prisma migrate deploy
"${compose[@]}" up -d app
"${compose[@]}" ps app
