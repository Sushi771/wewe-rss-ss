#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_dir"
test -f .env.private-online || { echo 'Missing private env file' >&2; exit 1; }
mkdir -p private-data/sqlite private-data/wechat2rss private-data/backups
chmod 700 private-data private-data/sqlite private-data/wechat2rss private-data/backups

docker compose --env-file .env.private-online -f docker-compose.private-online.yml build app
if [[ -f private-data/sqlite/wewe-rss.db ]]; then
  bash scripts/private-online/backup.sh
fi
docker compose --env-file .env.private-online -f docker-compose.private-online.yml stop app
docker compose --env-file .env.private-online -f docker-compose.private-online.yml run --rm --no-deps app \
  ./node_modules/.bin/prisma migrate deploy
docker compose --env-file .env.private-online -f docker-compose.private-online.yml up -d
docker compose --env-file .env.private-online -f docker-compose.private-online.yml ps
