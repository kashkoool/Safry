#!/bin/sh
# Daily database maintenance. Owner-only procedures, safe to repeat:
#   1. ensure_audit_event_partitions: creates the monthly audit_events partitions for the next AUDIT_PARTITIONS_AHEAD months
#      (migration 20261012_db_audit_partitioning). If this job stops for longer, rows land in audit_events_default (never lost)
#      and are moved into their month the next time the partition is created.
#   2. purge_refresh_sessions: batched removal of expired or revoked refresh sessions.
#   3. purge_credential_tokens: removes password-reset and verification links after they expired or were used.
#   4. purge_login_throttles: removes idle sign-in attempt counters (not blocked, not trusted).
#   5. sweep_expired_bookings: cancels PENDING bookings older than BOOKING_PENDING_TTL_HOURS (the rule the API computes).
#   6. purge_audit_events: DROPs audit_events partitions that lie wholly older than the retention (default 24 months).
#   7. record_maintenance_run: heartbeat. Written only when every step above succeeded; the API turns it into a metric and an
#      alert fires when it is older than 36 hours.
# Keep the CALL list in sync with backend/scripts/db/run-purge.ts (a unit test compares them).
#
#   DATABASE_MIGRATE_URL            owner connection string (falls back to DATABASE_URL). Required.
#   SESSION_RETENTION_DAYS          default 30, 1..3650 (days after expiry or revocation)
#   CREDENTIAL_TOKEN_RETENTION_DAYS default 7, 1..3650 (days after expiry or use)
#   LOGIN_THROTTLE_RETENTION_HOURS  default 24, 1..720 (hours without activity)
#   BOOKING_PENDING_TTL_HOURS       default 48, 1..720: must equal the API's setting of the same name
#   AUDIT_RETENTION_DAYS            unset = 24 months; otherwise 30..3650 days
#   AUDIT_PARTITIONS_AHEAD          months of audit partitions to keep ready, default 6 (1..60)
#   PURGE_BATCH_SIZE                rows per committed batch, default 5000 (100..100000)
set -eu
url="${DATABASE_MIGRATE_URL:-${DATABASE_URL:-}}"
[ -n "$url" ] || { echo "DATABASE_MIGRATE_URL or DATABASE_URL is required" >&2; exit 1; }

# integer NAME DEFAULT MIN MAX: prints the validated value of $NAME (or the default)
integer() {
  value="$(printenv "$1" || true)"
  value="${value:-$2}"
  case "$value" in ''|*[!0-9]*) echo "$1 must be an integer" >&2; exit 1;; esac
  if [ "$value" -lt "$3" ] || [ "$value" -gt "$4" ]; then echo "$1 must be from $3 to $4" >&2; exit 1; fi
  printf '%s' "$value"
}
sessions="$(integer SESSION_RETENTION_DAYS 30 1 3650)"
tokens="$(integer CREDENTIAL_TOKEN_RETENTION_DAYS 7 1 3650)"
throttles="$(integer LOGIN_THROTTLE_RETENTION_HOURS 24 1 720)"
pending="$(integer BOOKING_PENDING_TTL_HOURS 48 1 720)"
ahead="$(integer AUDIT_PARTITIONS_AHEAD 6 1 60)"
batch="$(integer PURGE_BATCH_SIZE 5000 100 100000)"
if [ -n "${AUDIT_RETENTION_DAYS:-}" ]; then
  audit_retention="$(integer AUDIT_RETENTION_DAYS 30 30 3650) days"
else
  audit_retention="24 months"
fi
psql "$url" -v ON_ERROR_STOP=1 -c "CALL ensure_audit_event_partitions(0, $ahead)"
psql "$url" -v ON_ERROR_STOP=1 -c "CALL purge_refresh_sessions(interval '$sessions days', $batch)"
psql "$url" -v ON_ERROR_STOP=1 -c "CALL purge_credential_tokens(interval '$tokens days', $batch)"
psql "$url" -v ON_ERROR_STOP=1 -c "CALL purge_login_throttles(interval '$throttles hours', $batch)"
psql "$url" -v ON_ERROR_STOP=1 -c "CALL sweep_expired_bookings(interval '$pending hours', $batch)"
psql "$url" -v ON_ERROR_STOP=1 -c "CALL purge_audit_events(interval '$audit_retention')"
psql "$url" -v ON_ERROR_STOP=1 -c "CALL record_maintenance_run('purge')"
echo "purge done"
