#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_dir"
database="$project_dir/private-data/sqlite/wewe-rss.db"
backup_root="$project_dir/private-data/backups"
mkdir -p "$backup_root"
mkdir -p "$project_dir/private-data/wechat2rss"
chmod 700 "$backup_root"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ -f "$database" ]]; then
  docker compose --env-file .env.private-online -f docker-compose.private-online.yml run --rm --no-deps app \
    python3 /app/scripts/backup-sqlite.py --database /app/data/wewe-rss.db --backup-root /app/data/backups
fi

# Stop upstream briefly so its private data files are copied consistently.
upstream_container="$(docker compose --env-file .env.private-online -f docker-compose.private-online.yml ps -q wechat2rss)"
if [[ -n "$upstream_container" ]]; then
  docker compose --env-file .env.private-online -f docker-compose.private-online.yml stop wechat2rss
  trap 'docker compose --env-file .env.private-online -f docker-compose.private-online.yml start wechat2rss' EXIT
fi
tar -C "$project_dir/private-data" -czf "$backup_root/wechat2rss-$stamp.tar.gz" wechat2rss
trap - EXIT
if [[ -n "$upstream_container" ]]; then
  docker compose --env-file .env.private-online -f docker-compose.private-online.yml start wechat2rss
fi
chmod 600 "$backup_root/wechat2rss-$stamp.tar.gz"
sha256sum "$backup_root/wechat2rss-$stamp.tar.gz" > "$backup_root/wechat2rss-$stamp.tar.gz.sha256"
chmod 600 "$backup_root/wechat2rss-$stamp.tar.gz.sha256"
