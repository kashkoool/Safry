#!/bin/sh
# Point-in-time-recovery drill in Docker (PostgreSQL continuous archiving).
#   1. the source server archives WAL to a volume (archive_mode=on)
#   2. pg_basebackup takes a base backup
#   3. more rows are written, a recovery target time T is noted, then "disaster": every row is deleted
#   4. a fresh server is built from the base backup + archived WAL and recovers to T
# PASS only if the restored table holds exactly the rows that existed at T.
#
#   DRILL_PREFIX  name prefix for the containers and the volume (default safry-pitr)
#   PG_IMAGE      image (default postgres:17-alpine)
set -eu
p="${DRILL_PREFIX:-safry-pitr}"
image="${PG_IMAGE:-postgres:17-alpine}"
vol="$p-archive"
src="$p-src"
dst="$p-restored"
cleanup() { docker rm -fv "$src" "$dst" >/dev/null 2>&1 || true; docker volume rm "$vol" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
cleanup
psqlq() { docker exec "$1" psql -U postgres -d drill -Atq -c "$2"; }
wait_ready() {
  i=0
  until docker exec "$1" psql -U postgres -Atc "select 1" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 60 ] || { echo "$1 did not start" >&2; exit 1; }; sleep 1
  done
}

docker volume create "$vol" >/dev/null
docker run --rm -v "$vol:/backup" --entrypoint sh "$image" -c 'mkdir -p /backup/wal /backup/base && chown -R postgres /backup'

echo "1/6 starting source with WAL archiving"
docker run -d --name "$src" -e POSTGRES_PASSWORD=drill -v "$vol:/backup" "$image" \
  -c wal_level=replica -c archive_mode=on \
  -c "archive_command=test ! -f /backup/wal/%f && cp %p /backup/wal/%f" -c archive_timeout=10 >/dev/null
wait_ready "$src"; sleep 3; wait_ready "$src"
docker exec "$src" psql -U postgres -qc "CREATE DATABASE drill" >/dev/null
psqlq "$src" "CREATE TABLE ledger(id int primary key, note text); INSERT INTO ledger SELECT g, 'before-backup' FROM generate_series(1,1000) g"

echo "2/6 base backup"
docker exec -u postgres "$src" sh -c 'rm -rf /backup/base/* && pg_basebackup -U postgres -D /backup/base -Ft -z -X none -c fast'

echo "3/6 more writes, then note the recovery target T"
psqlq "$src" "INSERT INTO ledger SELECT g, 'after-backup' FROM generate_series(1001,2000) g"
sleep 1
target="$(psqlq "$src" "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")"
sleep 1
echo "   T = $target (2000 rows at that moment)"

echo "4/6 disaster: delete everything, flush WAL to the archive"
before="$(psqlq "$src" "SELECT archived_count FROM pg_stat_archiver")"
psqlq "$src" "DELETE FROM ledger"
psqlq "$src" "SELECT pg_switch_wal()" >/dev/null
i=0
until [ "$(psqlq "$src" "SELECT archived_count FROM pg_stat_archiver")" -gt "$before" ]; do
  i=$((i + 1)); [ "$i" -lt 60 ] || { echo "WAL was not archived" >&2; exit 1; }; sleep 1
done
sleep 3
docker stop "$src" >/dev/null

echo "5/6 recovering a new server to T from base backup + archive"
docker run -d --name "$dst" --user postgres -v "$vol:/backup:ro" --entrypoint sh "$image" -c "
  set -e
  mkdir -p /tmp/pgdata && chmod 700 /tmp/pgdata
  tar xzf /backup/base/base.tar.gz -C /tmp/pgdata
  touch /tmp/pgdata/recovery.signal
  echo \"restore_command = 'cp /backup/wal/%f %p'\" >> /tmp/pgdata/postgresql.auto.conf
  echo \"recovery_target_time = '$target'\" >> /tmp/pgdata/postgresql.auto.conf
  echo \"recovery_target_action = 'promote'\" >> /tmp/pgdata/postgresql.auto.conf
  exec postgres -D /tmp/pgdata -c listen_addresses=''" >/dev/null
i=0
until docker exec "$dst" psql -U postgres -d drill -Atc "select pg_is_in_recovery()" 2>/dev/null | grep -q f; do
  i=$((i + 1))
  [ "$i" -lt 90 ] || { echo "recovery did not finish" >&2; docker logs "$dst" 2>&1 | tail -20 >&2; exit 1; }
  sleep 1
done

echo "6/6 verifying"
rows="$(psqlq "$dst" "SELECT count(*) FROM ledger")"
after="$(psqlq "$dst" "SELECT count(*) FROM ledger WHERE note = 'after-backup'")"
if [ "$rows" = "2000" ] && [ "$after" = "1000" ]; then
  echo "PASS: recovered $rows rows at T ($after written after the base backup came from archived WAL); the DELETE after T was not replayed"
else
  echo "FAIL: expected 2000 rows (1000 after-backup), got $rows ($after)" >&2
  exit 1
fi
