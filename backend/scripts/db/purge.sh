#!/bin/sh
# Daily database maintenance. Owner-only procedures, safe to repeat:
#   1. ensure_audit_event_partitions: creates the monthly audit_events partitions for the next AUDIT_PARTITIONS_AHEAD months
#      (migration 20261012_db_audit_partitioning). If this job stops for longer, rows land in audit_events_default (never lost)
#      and are moved into their month the next time the partition is created.
#   2. purge_refresh_sessions: batched removal of expired or revoked refresh sessions.
#   3. purge_audit_events: DROPs audit_events partitions that lie wholly older than the retention (default 24 months).
#
#   DATABASE_MIGRATE_URL         owner connection string (falls back to DATABASE_URL). Required.
#   SESSION_RETENTION_DAYS       default 30 (30 days after expiry; minimum accepted by the procedure: 1)
#   AUDIT_RETENTION_DAYS         unset = 24 months; an integer overrides it; the procedure refuses less than 30
#   AUDIT_PARTITIONS_AHEAD       months of audit partitions to keep ready, default 6 (1..60)
set -eu
url="${DATABASE_MIGRATE_URL:-${DATABASE_URL:-}}"
[ -n "$url" ] || { echo "DATABASE_MIGRATE_URL or DATABASE_URL is required" >&2; exit 1; }
sessions="${SESSION_RETENTION_DAYS:-30}"
case "$sessions" in ''|*[!0-9]*) echo "SESSION_RETENTION_DAYS must be an integer" >&2; exit 1;; esac
ahead="${AUDIT_PARTITIONS_AHEAD:-6}"
case "$ahead" in ''|*[!0-9]*) echo "AUDIT_PARTITIONS_AHEAD must be an integer" >&2; exit 1;; esac
if [ -n "${AUDIT_RETENTION_DAYS:-}" ]; then
  case "$AUDIT_RETENTION_DAYS" in *[!0-9]*) echo "AUDIT_RETENTION_DAYS must be an integer" >&2; exit 1;; esac
  audit_retention="$AUDIT_RETENTION_DAYS days"
else
  audit_retention="24 months"
fi
psql "$url" -v ON_ERROR_STOP=1 -c "CALL ensure_audit_event_partitions(0, $ahead)"
psql "$url" -v ON_ERROR_STOP=1 -c "CALL purge_refresh_sessions(interval '$sessions days')"
psql "$url" -v ON_ERROR_STOP=1 -c "CALL purge_audit_events(interval '$audit_retention')"
echo "purge done"
