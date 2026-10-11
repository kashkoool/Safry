#!/bin/sh
# Restore drill in Docker: dump a running source Postgres container, restore into a throwaway
# container, and prove the restore is complete (row counts, constraints, RLS, roles).
#
#   SRC_CONTAINER   running Postgres container to back up (required)
#   SRC_DB          database name inside it (default safry)
#   SRC_USER        superuser/owner role (default postgres)
#   TEST_CONTAINER  name of the throwaway target (default safry-restore-test)
#   PG_IMAGE        image (default postgres:17-alpine)
# Exit code 0 only if every check passes. The throwaway container is always removed.
set -eu
src="${SRC_CONTAINER:?set SRC_CONTAINER}"
db="${SRC_DB:-safry}"
user="${SRC_USER:-postgres}"
dst="${TEST_CONTAINER:-safry-restore-test}"
image="${PG_IMAGE:-postgres:17-alpine}"
work="$(mktemp -d)"
cleanup() { docker rm -fv "$dst" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT INT TERM

echo "1/5 dumping $src/$db"
docker exec "$src" pg_dump -U "$user" --format=custom "$db" > "$work/db.dump"
docker exec "$src" pg_dumpall -U "$user" --roles-only --no-role-passwords > "$work/roles.sql"

echo "2/5 starting throwaway $dst (no published port)"
docker run -d --name "$dst" -e POSTGRES_PASSWORD=restore-test "$image" >/dev/null
i=0
until docker exec "$dst" psql -U postgres -Atc "select 1" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 60 ] || { echo "target did not start" >&2; exit 1; }; sleep 1
done
sleep 3

echo "3/5 restoring"
docker exec "$dst" psql -U postgres -qc "CREATE DATABASE $db" >/dev/null
docker exec -i "$dst" psql -U postgres -q < "$work/roles.sql" >/dev/null 2>&1 || true
docker exec -i "$dst" pg_restore -U postgres --exit-on-error --no-owner --dbname="$db" < "$work/db.dump"

echo "4/5 comparing"
counts_sql="SELECT string_agg(format('SELECT %L AS t, count(*) AS n FROM %I', tablename, tablename), ' UNION ALL ' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'"
invariants_sql="SELECT 'idx=' || count(*) FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL SELECT 'check=' || count(*) FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace AND convalidated
  UNION ALL SELECT 'rls=' || count(*) FROM pg_class WHERE relforcerowsecurity
  UNION ALL SELECT 'policies=' || count(*) FROM pg_policies
  UNION ALL SELECT 'role=' || rolname || ',' || rolsuper || ',' || rolbypassrls FROM pg_roles WHERE rolname = 'safry_app'
  UNION ALL SELECT 'migrations=' || count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL"
for c in "$src" "$dst"; do
  q="$(docker exec "$c" psql -U "$user" -d "$db" -Atc "$counts_sql")"
  docker exec "$c" psql -U "$user" -d "$db" -Atc "SELECT t || '=' || n FROM ($q) x ORDER BY t" > "$work/$c.out"
  docker exec "$c" psql -U "$user" -d "$db" -Atc "$invariants_sql" >> "$work/$c.out"
done
if diff "$work/$src.out" "$work/$dst.out" >/dev/null; then
  echo "5/5 PASS: $(wc -l < "$work/$dst.out") checks identical (row count per table, indexes, validated CHECKs, forced RLS, policies, safry_app role, applied migrations)"
else
  echo "5/5 FAIL: source and restored database differ" >&2
  diff "$work/$src.out" "$work/$dst.out" >&2 || true
  exit 1
fi
