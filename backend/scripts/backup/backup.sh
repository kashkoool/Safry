#!/bin/sh
# Logical backup of the Safry database (pg_dump custom format) plus a roles-only dump.
# Needs the pg_dump / pg_dumpall client (same major version as the server or newer).
#
#   DATABASE_MIGRATE_URL  owner connection string (falls back to DATABASE_URL). Required.
#   BACKUP_DIR            output directory (default ./backups)
#   BACKUP_KEEP_DAYS      delete dumps older than this many days (default 14)
#
# A logical dump gives an RPO equal to the schedule (e.g. daily). For minutes-level RPO use
# continuous WAL archiving (see docs/database-operations.md and scripts/backup/pitr-drill.sh).
set -eu

url="${DATABASE_MIGRATE_URL:-${DATABASE_URL:-}}"
[ -n "$url" ] || { echo "DATABASE_MIGRATE_URL or DATABASE_URL is required" >&2; exit 1; }
dir="${BACKUP_DIR:-./backups}"
keep="${BACKUP_KEEP_DAYS:-14}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$dir"

out="$dir/safry-$stamp.dump"
pg_dump --format=custom --compress=6 --file="$out.partial" "$url"
mv "$out.partial" "$out"
( cd "$dir" && sha256sum "safry-$stamp.dump" > "safry-$stamp.dump.sha256" )

# Roles (without password hashes): the dump contains GRANTs and RLS policies that reference them.
# Managed databases may refuse this; the dump itself is still valid then.
if pg_dumpall --roles-only --no-role-passwords --dbname="$url" > "$dir/roles-$stamp.sql.partial" 2>/dev/null; then
  mv "$dir/roles-$stamp.sql.partial" "$dir/roles-$stamp.sql"
else
  rm -f "$dir/roles-$stamp.sql.partial"
  echo "note: roles-only dump skipped (insufficient privilege); create safry_app before restoring" >&2
fi

find "$dir" -maxdepth 1 -type f \( -name 'safry-*.dump*' -o -name 'roles-*.sql' \) -mtime "+$keep" -delete
echo "backup written: $out"
