#!/usr/bin/env bash
# Backup and restore drill (throwaway Docker only; nothing cloud, no secrets).
#
# Proves, end to end, that a logical backup of a migrated and seeded database restores into a brand-new
# PostgreSQL server with nothing lost:
#   1. start PostgreSQL (SOURCE), apply every migration with the migrate image, create the runtime login,
#      seed tenant A, bootstrap tenant B (demo data, per-run generated passwords)
#   2. pg_dump --format=custom (+ pg_dumpall --roles-only, roles are not part of a database dump)
#   3. start a second, empty PostgreSQL (TARGET), restore roles and database with pg_restore --exit-on-error (timed: RTO)
#   4. compare SOURCE and TARGET: row count of every table (including each audit_events partition), indexes,
#      constraints (and whether validated), enabled + FORCED row-level security, policies, audit_events partitions,
#      role attributes and memberships, table grants, functions, applied migrations
#   5. functional RLS check as the real runtime login: tenant A sees only A, tenant B only B, no tenant sees nothing
#   6. `prisma migrate status` against the restored database must report it is up to date
# Any difference exits non-zero with the differing lines.
#
# Usage: scripts/drills/backup-restore.sh
#   MIGRATE_IMAGE=<tag>  reuse an already built migrate image instead of building backend/ (target migrate)
#   PG_IMAGE=<image>     PostgreSQL image (default postgres:17.11-alpine, as ci.yml)
# Needs only docker and bash. Works on ubuntu CI and Git Bash.
#
# NOT proven here: the managed cloud backup service, point-in-time restore, cross-region restore, restore of
# an encrypted/off-site copy, or restore time at production data volumes (see docs/DEPLOYMENT.md, "Recovery drills").
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && { pwd -W 2>/dev/null || pwd; })"   # Windows form under Git Bash so native git/docker accept it
# shellcheck source=scripts/drills/lib.sh
. "$HERE/lib.sh"

drill_init
SRC="safry-drill-src-$DRILL_ID"; DST="safry-drill-dst-$DRILL_ID"
IMG="${MIGRATE_IMAGE:-safry-drill-migrate:$DRILL_ID}"
if [ -z "${MIGRATE_IMAGE:-}" ]; then
  build_migrate_image "$ROOT" "$IMG"
  DRILL_IMAGES+=("$IMG")
fi

log "1/6 source: start PostgreSQL, migrate, runtime login, seed tenant A, bootstrap tenant B"
start_pg "$SRC"
psql_owner "$SRC" postgres -c "CREATE DATABASE $DRILL_DB" >/dev/null
run_migrate "$IMG" "$SRC" >/dev/null || fail "migrate deploy failed on the source"
create_runtime_role "$SRC" "$ROOT/backend/scripts/db/create-runtime-role.sql" || fail "runtime role creation failed"
run_seed "$IMG" "$SRC" drilla admin-a@drill.invalid || fail "seed (tenant A) failed"
run_bootstrap "$IMG" "$SRC" drillb admin-b@drill.invalid || fail "bootstrap (tenant B) failed"
# Audit rows in the current month's partition and in the legacy partition, so partition data is exercised.
psql_owner "$SRC" "$DRILL_DB" <<'SQL' >/dev/null || fail "audit rows insert failed"
SELECT set_config('app.bypass_rls', 'on', false);
INSERT INTO audit_events ("id","tenantId","action","entityType","entityId","metadata","occurredAt")
SELECT gen_random_uuid(), t."id", 'drill.event', 'drill', g::text, '{}'::jsonb, now()
  FROM tenants t, generate_series(1, 25) g;
INSERT INTO audit_events ("id","tenantId","action","entityType","entityId","metadata","occurredAt")
SELECT gen_random_uuid(), t."id", 'drill.legacy', 'drill', '1', '{}'::jsonb, now() - interval '5 years' FROM tenants t;
SQL

# Deterministic text describing data and structure of a database.
fingerprint() {
  psql_owner "$1" "$DRILL_DB" <<'SQL'
SELECT 'rows ' || tablename || ' = ' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text
  FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
SELECT 'index ' || md5(string_agg(indexname || ':' || indexdef, '|' ORDER BY indexname)) || ' n=' || count(*) FROM pg_indexes WHERE schemaname = 'public';
SELECT 'constraint ' || conrelid::regclass || '.' || conname || ' validated=' || convalidated
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1;
SELECT 'rls ' || relname || ' enabled=' || relrowsecurity || ' forced=' || relforcerowsecurity
  FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p') ORDER BY relname;
SELECT 'policy ' || tablename || '.' || policyname || ' ' || cmd || ' ' || md5(coalesce(qual,'') || coalesce(with_check,''))
  FROM pg_policies ORDER BY 1;
SELECT 'partition ' || c.relname || ' ' || pg_get_expr(c.relpartbound, c.oid)
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'public.audit_events'::regclass ORDER BY c.relname;
SELECT 'role ' || rolname || ' super=' || rolsuper || ' bypassrls=' || rolbypassrls || ' login=' || rolcanlogin || ' createdb=' || rolcreatedb
  FROM pg_roles WHERE rolname IN ('safry_app','safry_runtime') ORDER BY 1;
SELECT 'member ' || r.rolname || ' -> ' || m.rolname FROM pg_auth_members a
  JOIN pg_roles r ON r.oid = a.member JOIN pg_roles m ON m.oid = a.roleid WHERE r.rolname = 'safry_runtime' ORDER BY 1;
SELECT 'rolesetting ' || r.rolname || ' ' || s FROM pg_db_role_setting d JOIN pg_roles r ON r.oid = d.setrole, unnest(d.setconfig) s
  WHERE r.rolname = 'safry_runtime' ORDER BY 1;
SELECT 'grants safry_app n=' || count(*) FROM information_schema.role_table_grants WHERE grantee = 'safry_app' AND table_schema = 'public';
SELECT 'function ' || p.proname || ' ' || md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' ORDER BY 1;
SELECT 'migration ' || migration_name || ' finished=' || (finished_at IS NOT NULL) || ' rolledback=' || (rolled_back_at IS NOT NULL) FROM _prisma_migrations ORDER BY migration_name;
SQL
}

fingerprint "$SRC" > "$DRILL_WORK/src.fp" || fail "fingerprint of the source failed"
tables_with_rows="$(grep -c '^rows .* = [1-9]' "$DRILL_WORK/src.fp" || true)"
[ "$tables_with_rows" -ge 8 ] || fail "source looks empty ($tables_with_rows tables with rows); the drill would prove nothing"
grep -q '^partition audit_events_' "$DRILL_WORK/src.fp" || fail "no audit_events partitions on the source"
total_rows="$(awk '/^rows /{s+=$4} END{print s+0}' "$DRILL_WORK/src.fp")"
tenant_a="$(psql_owner "$SRC" "$DRILL_DB" -c "SELECT id FROM tenants WHERE code='drilla'")"
tenant_b="$(psql_owner "$SRC" "$DRILL_DB" -c "SELECT id FROM tenants WHERE code='drillb'")"
[ -n "$tenant_a" ] && [ -n "$tenant_b" ] || fail "seeded tenants not found"
count_of() { psql_owner "$1" "$DRILL_DB" -c "$2"; }
a_members="$(count_of "$SRC" "SELECT count(*) FROM tenant_memberships WHERE \"tenantId\"='$tenant_a'")"
b_members="$(count_of "$SRC" "SELECT count(*) FROM tenant_memberships WHERE \"tenantId\"='$tenant_b'")"
[ "$a_members" -gt 0 ] && [ "$b_members" -gt 0 ] || fail "a tenant has no memberships; isolation check would be vacuous"

log "2/6 backup: pg_dump (custom format) + roles"
docker exec -e PGPASSWORD="$DRILL_PG_PASSWORD" "$SRC" pg_dump -h 127.0.0.1 -U postgres --format=custom --dbname="$DRILL_DB" > "$DRILL_WORK/db.dump" || fail "pg_dump failed"
docker exec -e PGPASSWORD="$DRILL_PG_PASSWORD" "$SRC" pg_dumpall -h 127.0.0.1 -U postgres --roles-only --no-role-passwords > "$DRILL_WORK/roles.sql" || fail "pg_dumpall failed"
log "   dump size: $(wc -c < "$DRILL_WORK/db.dump") bytes, $total_rows rows in $tables_with_rows populated tables"

log "3/6 restore into a brand-new PostgreSQL server (timed)"
start_pg "$DST"
t0=$(date +%s%3N)
# Roles first (a database dump does not contain them). "already exists" for the bootstrap superuser is expected and ignored.
docker exec -i -e PGPASSWORD="$DRILL_PG_PASSWORD" "$DST" psql -h 127.0.0.1 -U postgres -X -q < "$DRILL_WORK/roles.sql" >/dev/null 2>"$DRILL_WORK/roles.err"
unexpected="$(grep -i 'error' "$DRILL_WORK/roles.err" | grep -vi 'already exists' || true)"
[ -z "$unexpected" ] || fail "roles restore: $unexpected"
psql_owner "$DST" postgres -c "CREATE DATABASE $DRILL_DB" >/dev/null || fail "create database failed"
docker exec -i -e PGPASSWORD="$DRILL_PG_PASSWORD" "$DST" pg_restore -h 127.0.0.1 -U postgres --exit-on-error --dbname="$DRILL_DB" < "$DRILL_WORK/db.dump" || fail "pg_restore failed"
# Role passwords are never in a backup: the operator re-applies the runtime secret from the secret store, as in a real recovery.
psql_owner "$DST" postgres -c "ALTER ROLE safry_runtime PASSWORD '$DRILL_RUNTIME_PASSWORD'" >/dev/null || fail "could not re-apply the runtime password"
t1=$(date +%s%3N)
restore_ms=$((t1 - t0))
log "   restore finished in ${restore_ms} ms (RTO evidence for this data size only)"

log "4/6 compare source and restored database"
fingerprint "$DST" > "$DRILL_WORK/dst.fp" || fail "fingerprint of the restored database failed"
if ! diff -u "$DRILL_WORK/src.fp" "$DRILL_WORK/dst.fp" > "$DRILL_WORK/fp.diff"; then
  cat "$DRILL_WORK/fp.diff" >&2
  fail "restored database differs from the source (diff above)"
fi
n_checks="$(wc -l < "$DRILL_WORK/dst.fp")"
n_forced="$(grep -c 'forced=true' "$DRILL_WORK/dst.fp")"
n_policies="$(grep -c '^policy ' "$DRILL_WORK/dst.fp")"
n_parts="$(grep -c '^partition ' "$DRILL_WORK/dst.fp")"
# Positive invariants (what must REMAIN), independent of the diff: the diff would pass if both sides lost the same thing.
[ "$n_forced" -ge 10 ] && [ "$n_policies" -ge 10 ] || fail "too few forced-RLS tables ($n_forced) or policies ($n_policies) after restore"
for t in tenants tenant_memberships bookings audit_events; do
  grep -q "^rls $t enabled=true forced=true" "$DRILL_WORK/dst.fp" || fail "RLS not enabled+forced on $t after restore"
done
grep -q '^role safry_runtime super=false bypassrls=false login=true' "$DRILL_WORK/dst.fp" || fail "safry_runtime lost or has wrong attributes"
grep -q '^role safry_app super=false bypassrls=false login=false' "$DRILL_WORK/dst.fp" || fail "safry_app lost or has wrong attributes"
grep -q '^partition audit_events_default' "$DRILL_WORK/dst.fp" || fail "audit_events_default partition missing after restore"
expected_mig="$(find "$ROOT/backend/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l)"
applied_mig="$(grep -c '^migration .* finished=true rolledback=false' "$DRILL_WORK/dst.fp")"
[ "$expected_mig" = "$applied_mig" ] || fail "migrations in repo=$expected_mig, finished in restored DB=$applied_mig"

log "5/6 RLS as the real runtime login on the restored database"
# rls_count <tenant-uuid-or-empty> <sql>: one number, as safry_runtime inside a transaction, the way the API sets its context.
rls_count() {
  docker exec -i -e PGPASSWORD="$DRILL_RUNTIME_PASSWORD" "$DST" psql -h 127.0.0.1 -U safry_runtime -d "$DRILL_DB" -X -v ON_ERROR_STOP=1 -qAt <<SQL | tail -n 1
BEGIN;
SELECT set_config('role','safry_app',true), set_config('app.tenant_id','$1',true), set_config('app.bypass_rls','off',true);
$2;
COMMIT;
SQL
}
expect() { [ "$1" = "$2" ] || fail "RLS check '$3': expected $2, got '$1'"; }
expect "$(rls_count "$tenant_a" 'SELECT count(*) FROM tenants')" 1 "tenant A sees exactly its own tenant row"
expect "$(rls_count "$tenant_a" 'SELECT count(*) FROM tenant_memberships')" "$a_members" "tenant A sees all of its memberships"
expect "$(rls_count "$tenant_a" "SELECT count(*) FROM tenant_memberships WHERE \"tenantId\"='$tenant_b'")" 0 "tenant A cannot read tenant B memberships"
expect "$(rls_count "$tenant_b" 'SELECT count(*) FROM tenant_memberships')" "$b_members" "tenant B sees all of its memberships"
expect "$(rls_count "$tenant_b" "SELECT count(*) FROM tenant_memberships WHERE \"tenantId\"='$tenant_a'")" 0 "tenant B cannot read tenant A memberships"
expect "$(rls_count "" 'SELECT count(*) FROM tenant_memberships')" 0 "no tenant context sees nothing (fail closed)"
expect "$(rls_count "$tenant_a" 'SELECT count(*) FROM audit_events')" "$(count_of "$DST" "SELECT count(*) FROM audit_events WHERE \"tenantId\"='$tenant_a'")" "tenant A audit events through the partitioned table"

log "6/6 prisma migrate status on the restored database"
status_out="$(run_migrate "$IMG" "$DST" migrate status 2>&1)" || { printf '%s\n' "$status_out" >&2; fail "migrate status failed on the restored database"; }
printf '%s\n' "$status_out" | grep -q 'Database schema is up to date' || { printf '%s\n' "$status_out" >&2; fail "restored database is not reported up to date"; }

cat <<SUMMARY

PASS backup-restore drill
  PostgreSQL image         : $PG_IMAGE (fresh server for the restore)
  data restored            : $total_rows rows, $tables_with_rows populated tables, 2 tenants
  compared lines identical : $n_checks (row count per table, indexes, constraints, RLS flags, policies, roles, grants, functions, migrations)
  forced-RLS tables        : $n_forced   policies: $n_policies   audit_events partitions: $n_parts
  RLS as safry_runtime     : tenant A / tenant B isolated, no tenant sees nothing
  migrate status           : up to date ($applied_mig migrations)
  restore time (RTO)       : ${restore_ms} ms for this data size
SUMMARY
