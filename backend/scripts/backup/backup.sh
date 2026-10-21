#!/bin/sh
# Logical backup of the Safry database (pg_dump custom format) plus a roles-only dump.
# Needs the pg_dump / pg_dumpall client (same major version as the server or newer).
#
#   DATABASE_MIGRATE_URL  owner connection string (falls back to DATABASE_URL). Required.
#   BACKUP_DIR            output directory (default ./backups)
#   BACKUP_KEEP_DAYS      delete dumps older than this many days (default 14, 1..3650). Data erased from the database (anonymised
#                         accounts) stays in older dumps until they age out: see backend/docs/data-retention.md.
#   BACKUP_MAX_TOTAL_MB   size cap for everything in BACKUP_DIR (default 5120, 0 = no cap, otherwise 100..10000000). When the
#                         dumps exceed it the OLDEST ones are deleted, never the newest. If the new dump cannot be written
#                         (volume full) the job fails loudly and keeps the older dumps it still has.
#
# Also writes backup-metrics.prom in BACKUP_DIR (Prometheus text format: last success, last attempt, sizes, volume use) for the
# textfile collector, see docs/ALERTING.md (BackupMissing, BackupVolumeNearlyFull).
#
# A logical dump gives an RPO equal to the schedule (e.g. daily). For minutes-level RPO use
# continuous WAL archiving (see docs/database-operations.md and scripts/backup/pitr-drill.sh).
set -eu

url="${DATABASE_MIGRATE_URL:-${DATABASE_URL:-}}"
[ -n "$url" ] || { echo "DATABASE_MIGRATE_URL or DATABASE_URL is required" >&2; exit 1; }
dir="${BACKUP_DIR:-./backups}"

# integer NAME DEFAULT MIN MAX: prints the validated value of $NAME (or the default)
integer() {
  value="$(printenv "$1" || true)"
  value="${value:-$2}"
  case "$value" in ''|*[!0-9]*) echo "$1 must be an integer" >&2; exit 1;; esac
  if [ "$value" -lt "$3" ] || [ "$value" -gt "$4" ]; then echo "$1 must be from $3 to $4" >&2; exit 1; fi
  printf '%s' "$value"
}
keep="$(integer BACKUP_KEEP_DAYS 14 1 3650)"
if [ "${BACKUP_MAX_TOTAL_MB:-}" = "0" ]; then cap_mb=0; else cap_mb="$(integer BACKUP_MAX_TOTAL_MB 5120 100 10000000)"; fi
cap=$((cap_mb * 1048576))
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$dir"

size() { wc -c < "$1" | tr -d ' '; }
# Bytes of one backup set (dump, checksum, roles) identified by its dump file name.
set_bytes() {
  base="${1#safry-}"; base="${base%.dump}"
  total=0
  for f in "$dir/safry-$base.dump" "$dir/safry-$base.dump.sha256" "$dir/roles-$base.sql"; do
    [ -f "$f" ] && total=$((total + $(size "$f")))
  done
  printf '%s' "$total"
}
dir_bytes() {
  total=0
  for f in "$dir"/safry-*.dump* "$dir"/roles-*.sql*; do
    [ -f "$f" ] && total=$((total + $(size "$f")))
  done
  printf '%s' "$total"
}
# prune MAX_BYTES: delete the oldest backup sets while the directory holds more than MAX_BYTES; the newest dump is never deleted.
prune() {
  [ "$cap" -gt 0 ] || return 0
  limit="$1"
  while :; do
    used="$(dir_bytes)"
    [ "$used" -gt "$limit" ] || return 0
    oldest="$(cd "$dir" && ls -1 safry-*.dump 2>/dev/null | sort | head -n 1)"
    count="$(cd "$dir" && ls -1 safry-*.dump 2>/dev/null | wc -l | tr -d ' ')"
    if [ -z "$oldest" ] || [ "$count" -le 1 ]; then
      echo "WARNING: backups use $used bytes, over the cap of $cap bytes, and only the newest dump is left; raise BACKUP_MAX_TOTAL_MB or free the volume" >&2
      return 0
    fi
    base="${oldest#safry-}"; base="${base%.dump}"
    echo "backup cap: deleting the oldest backup set $base" >&2
    rm -f "$dir/safry-$base.dump" "$dir/safry-$base.dump.sha256" "$dir/roles-$base.sql"
  done
}
metrics() { # metrics SUCCESS(0|1)
  now="$(date -u +%s)"
  used_pct="$(df -Pk "$dir" 2>/dev/null | awk 'NR==2 { gsub("%", "", $5); print $5 }')"
  last="$(cd "$dir" && ls -1 safry-*.dump 2>/dev/null | sort | tail -n 1)"
  last_ok=0
  [ -n "$last" ] && last_ok="$(stat -c %Y "$dir/$last" 2>/dev/null || echo 0)"
  {
    echo "# TYPE safry_backup_last_success_timestamp_seconds gauge"
    echo "safry_backup_last_success_timestamp_seconds $last_ok"
    echo "# TYPE safry_backup_last_attempt_timestamp_seconds gauge"
    echo "safry_backup_last_attempt_timestamp_seconds $now"
    echo "# TYPE safry_backup_last_run_ok gauge"
    echo "safry_backup_last_run_ok $1"
    echo "# TYPE safry_backup_total_bytes gauge"
    echo "safry_backup_total_bytes $(dir_bytes)"
    echo "# TYPE safry_backup_cap_bytes gauge"
    echo "safry_backup_cap_bytes $cap"
    echo "# TYPE safry_backup_volume_used_percent gauge"
    echo "safry_backup_volume_used_percent ${used_pct:-0}"
  } > "$dir/backup-metrics.prom.partial" && mv "$dir/backup-metrics.prom.partial" "$dir/backup-metrics.prom"
}

out="$dir/safry-$stamp.dump"
cleanup_partial() { rm -f "$out.partial" "$dir/roles-$stamp.sql.partial"; }
fail() { cleanup_partial; metrics 0 || true; echo "BACKUP FAILED: $1" >&2; exit 1; }

# Make room first: keep at most the cap minus the size of the newest dump (the new one will be about as big).
newest_before="$(cd "$dir" && ls -1 safry-*.dump 2>/dev/null | sort | tail -n 1)"
room=0
[ -n "$newest_before" ] && room="$(set_bytes "$newest_before")"
if [ "$cap" -gt 0 ]; then
  limit=$((cap - room)); [ "$limit" -gt 0 ] || limit=0
  prune "$limit"
fi

pg_dump --format=custom --compress=6 --file="$out.partial" "$url" || fail "pg_dump did not finish (is the volume full?); older backups were kept"
mv "$out.partial" "$out" || fail "could not move the dump into place"
( cd "$dir" && sha256sum "safry-$stamp.dump" > "safry-$stamp.dump.sha256" ) || fail "could not write the checksum (is the volume full?)"

# Roles (without password hashes): the dump contains GRANTs and RLS policies that reference them.
# Managed databases may refuse this; the dump itself is still valid then.
if pg_dumpall --roles-only --no-role-passwords --dbname="$url" > "$dir/roles-$stamp.sql.partial" 2>/dev/null; then
  mv "$dir/roles-$stamp.sql.partial" "$dir/roles-$stamp.sql"
else
  rm -f "$dir/roles-$stamp.sql.partial"
  echo "note: roles-only dump skipped (insufficient privilege); create safry_app before restoring" >&2
fi

find "$dir" -maxdepth 1 -type f \( -name 'safry-*.dump*' -o -name 'roles-*.sql' \) -mtime "+$keep" -delete
prune "$cap"
metrics 1
echo "backup written: $out"
