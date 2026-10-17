#!/bin/bash
# Gurmad V2 backup: daily DB dump (custom format), weekly uploads tarball, 14-day retention.
set -euo pipefail
APP=/home/zakariye/gurmad-v2/server
OUT=/home/zakariye/backups
STAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$OUT/db" "$OUT/uploads"

set -a; . "$APP/.env"; set +a
export PGPASSWORD="$DB_PASSWORD"

pg_dump -h "${DB_HOST:-localhost}" -p "${DB_PORT:-5432}" -U "$DB_USER" -Fc "$DB_NAME" -f "$OUT/db/gurmad_v2_$STAMP.dump"
pg_restore --list "$OUT/db/gurmad_v2_$STAMP.dump" > /dev/null   # sanity: archive is readable

# uploads: once a week (Sunday) or when forced
if [ "$(date +%u)" = "7" ] || [ "${FORCE_UPLOADS:-0}" = "1" ]; then
  tar -czf "$OUT/uploads/uploads_$STAMP.tar.gz" -C "$APP" uploads
fi

find "$OUT/db" -name 'gurmad_v2_*.dump' -mtime +14 -delete
find "$OUT/uploads" -name 'uploads_*.tar.gz' -mtime +28 -delete
echo "$(date -Is) backup ok gurmad_v2_$STAMP.dump"
