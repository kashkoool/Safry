#!/usr/bin/env bash
# Rollback drill (throwaway Docker only; nothing cloud, no secrets).
#
# Question answered: after the NEW release's migrations have been applied, can the PREVIOUS release's API
# image still run against that schema? (Rollback here means "redeploy the previous image tag"; migrations are
# forward-only, see docs/DEPLOYMENT.md.)
#
#   1. build the previous release (git ref PREV_REF) migrate + runtime images, and the current migrate image
#   2. start PostgreSQL, apply the PREVIOUS migrations, create the runtime login, seed demo data (previous code)
#   3. apply the CURRENT release's migrations on top (what production sees when the new release deploys)
#   4. start the PREVIOUS API image against that schema, as the restricted runtime login
#   5. prove it works: /health/ready is OK, then the smoke path: login + list services + list bookings
# If a step fails the drill exits non-zero, prints the API log tail and names the migrations that are new in
# this release together with the ones containing contract-style statements (the likely culprits).
#
# Usage: scripts/drills/rollback.sh [PREV_REF]
#   PREV_REF  git ref of the previous release. Default: the merge-base of HEAD and origin/main when that is not
#             HEAD itself (a pull request), otherwise HEAD~1 (a push to main). Needs enough git history (fetch-depth: 0).
#   STRICT=1  also fail when a new migration contains contract-style statements even though the smoke path passed
#             (default: warn, because the smoke path does not exercise every write).
#   PG_IMAGE  PostgreSQL image (default postgres:17.11-alpine, as ci.yml)
#
# Migration compatibility, by name, for the migrations existing today (expand = old code keeps working):
#   expand-only (add table/column/index/enum value/constraint NOT VALID, or idempotent backfill):
#     0001, 0002, 0004, 0005, 0006, 0008, 0009, 0010, 0011, 20261007_authz_*, 20261007_db_audit_immutability_retention,
#     20261007_db_constraints, 20261007_db_missing_indexes, 20261008_*, 20261010_*, 20261011_db_validate_constraints,
#     20261012_auth_invalidate_legacy_recovery_codes, 20261014_auth_backfill_email_verified, 20261014_auth_credential_tokens
#   contract-style (old code can break on writes or on the changed shape; the previous release must be one that
#   already tolerates it, or the change must ship in two releases):
#     0003 (enum values added: old code ignores them, safe for reads), 0020_auth_session_hardening (SET NOT NULL on
#     session columns), 20261007_db_schema_drift_fix (drops a default, renames a constraint),
#     20261012_db_audit_partitioning (audit_events replaced by a partitioned table), 20261012_db_bookings_service_date_required
#     (SET NOT NULL: an old release creating bookings without serviceDate fails), 20261014_db_money_bigint (int -> bigint:
#     reads are fine, values above 2^31-1 break an old release).
#
# NOT proven here: a rollback in the real cloud environment (image tag redeploy, App Service settings), a
# data-dependent failure that the seed data does not contain, or every write path of the previous release.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && { pwd -W 2>/dev/null || pwd; })"   # Windows form under Git Bash so native git/docker accept it
# shellcheck source=scripts/drills/lib.sh
. "$HERE/lib.sh"

command -v git >/dev/null 2>&1 || fail "git is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"

PREV_REF="${1:-}"
if [ -z "$PREV_REF" ]; then
  if base="$(git -C "$ROOT" merge-base HEAD origin/main 2>/dev/null)" && [ "$base" != "$(git -C "$ROOT" rev-parse HEAD)" ]; then
    PREV_REF="$base"
  else
    PREV_REF="HEAD~1"
  fi
fi
PREV_SHA="$(git -C "$ROOT" rev-parse --verify "$PREV_REF^{commit}" 2>/dev/null)" || fail "cannot resolve previous ref '$PREV_REF' (shallow clone? use fetch-depth: 0)"
CUR_SHA="$(git -C "$ROOT" rev-parse HEAD)"
log "previous release: ${PREV_SHA:0:12}   current: ${CUR_SHA:0:12}"

drill_init
PREV_TREE="$DRILL_WORK/prev"
mkdir -p "$PREV_TREE"
git -C "$ROOT" archive "$PREV_SHA" backend | tar -x -C "$PREV_TREE" || fail "git archive of $PREV_SHA failed"
[ -f "$PREV_TREE/backend/Dockerfile" ] || fail "previous release has no backend/Dockerfile"

# Migrations that exist in the current release but not in the previous one.
git -C "$ROOT" ls-tree --name-only "$PREV_SHA:backend/prisma/migrations/" | grep -v '\.toml$' | sort > "$DRILL_WORK/prev.mig"
find "$ROOT/backend/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort > "$DRILL_WORK/cur.mig"
comm -13 "$DRILL_WORK/prev.mig" "$DRILL_WORK/cur.mig" > "$DRILL_WORK/new.mig"
comm -23 "$DRILL_WORK/prev.mig" "$DRILL_WORK/cur.mig" > "$DRILL_WORK/removed.mig"
[ ! -s "$DRILL_WORK/removed.mig" ] || fail "migrations exist in the previous release but not in this one (history rewritten?): $(tr '\n' ' ' < "$DRILL_WORK/removed.mig")"
n_new="$(wc -l < "$DRILL_WORK/new.mig" | tr -d ' ')"
log "new migrations in this release: $n_new"
sed 's/^/   + /' "$DRILL_WORK/new.mig"

# Contract-style statements in the new migrations (comments stripped). Heuristic: a warning, never a proof.
: > "$DRILL_WORK/risky.txt"
while read -r m; do
  [ -n "$m" ] || continue
  hits="$(sed 's/--.*$//' "$ROOT/backend/prisma/migrations/$m/migration.sql" \
    | grep -inE 'drop[[:space:]]+(table|column|type|constraint)|rename[[:space:]]|set[[:space:]]+not[[:space:]]+null|alter[[:space:]]+column.*[[:space:]]type[[:space:]]|add[[:space:]]+column[^;]*not[[:space:]]+null' \
    | grep -viE 'default|if exists' | cut -c1-110 || true)"
  [ -z "$hits" ] || printf '%s\n%s\n' "$m" "$hits" >> "$DRILL_WORK/risky.txt"
done < "$DRILL_WORK/new.mig"

PREV_MIG="safry-drill-prev-migrate:$DRILL_ID"; PREV_API="safry-drill-prev-api:$DRILL_ID"; CUR_MIG="safry-drill-cur-migrate:$DRILL_ID"
DRILL_IMAGES+=("$PREV_MIG" "$PREV_API" "$CUR_MIG")
build_migrate_image "$PREV_TREE" "$PREV_MIG"
log "building previous API image (target runtime)"
docker build -q --target runtime -t "$PREV_API" "$(native_path "$PREV_TREE/backend")" >/dev/null || fail "previous API image build failed"
build_migrate_image "$ROOT" "$CUR_MIG"

PG="safry-drill-pg-$DRILL_ID"; API="safry-drill-api-$DRILL_ID"
log "starting PostgreSQL, applying the PREVIOUS release's migrations and seed"
start_pg "$PG"
psql_owner "$PG" postgres -c "CREATE DATABASE $DRILL_DB" >/dev/null
run_migrate "$PREV_MIG" "$PG" >/dev/null || fail "previous migrate deploy failed"
ROLE_SQL="$PREV_TREE/backend/scripts/db/create-runtime-role.sql"; [ -f "$ROLE_SQL" ] || ROLE_SQL="$ROOT/backend/scripts/db/create-runtime-role.sql"
create_runtime_role "$PG" "$ROLE_SQL" || fail "runtime role creation failed"
run_seed "$PREV_MIG" "$PG" safry admin@drill.invalid || fail "previous seed failed"

log "applying the CURRENT release's migrations on top ($n_new new)"
run_migrate "$CUR_MIG" "$PG" >/dev/null || fail "current migrate deploy failed on top of the previous schema"

log "starting the PREVIOUS API image against the migrated schema (restricted runtime login)"
DRILL_CONTAINERS+=("$API")
docker run -d --name "$API" --network "$DRILL_NET" -p 127.0.0.1::3000 \
  -e NODE_ENV=development -e PORT=3000 -e API_PREFIX=api/v1 -e MAIL_TRANSPORT=console \
  -e CORS_ORIGINS=http://127.0.0.1:8080 -e APP_BASE_URL=http://127.0.0.1:8080 \
  -e JWT_ACCESS_SECRET="$DRILL_JWT_SECRET" \
  -e DATABASE_URL="postgresql://safry_runtime:${DRILL_RUNTIME_PASSWORD}@${PG}:5432/${DRILL_DB}?schema=public" \
  -e DATABASE_MIGRATE_URL="$(owner_url "$PG")" \
  "$PREV_API" >/dev/null || fail "could not start the previous API image"
PORT_MAP="$(docker port "$API" 3000/tcp | head -n 1)"
BASE="http://127.0.0.1:${PORT_MAP##*:}/api/v1"

diagnose() {
  echo "---- previous API log (last 40 lines) ----" >&2
  docker logs --tail 40 "$API" >&2 2>&1 || true
  echo "---- migrations new in this release ----" >&2
  sed 's/^/   /' "$DRILL_WORK/new.mig" >&2
  if [ -s "$DRILL_WORK/risky.txt" ]; then
    echo "---- likely culprits: new migrations with contract-style statements ----" >&2
    cat "$DRILL_WORK/risky.txt" >&2
  else
    echo "(no contract-style statement detected in the new migrations; look at the log above)" >&2
  fi
}
stop() { diagnose; fail "$1"; }

wait_http "$BASE/health/ready" 45 || stop "previous API did not become ready (/health/ready) on the new schema"
log "previous API is ready on the new schema"

http_code() { curl -s -o "$DRILL_WORK/body" -w '%{http_code}' "$@"; }
code="$(http_code "$BASE/health/ready")"; [ "$code" = 200 ] || stop "/health/ready returned $code"
code="$(http_code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -H 'X-Client: mobile' \
  -d "{\"email\":\"traveler@safry.local\",\"password\":\"${DRILL_SEED_PASSWORD}\",\"tenantCode\":\"safry\"}")"
[ "$code" = 200 ] || stop "login returned $code: $(head -c 300 "$DRILL_WORK/body")"
TOKEN="$(sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p' "$DRILL_WORK/body")"
[ -n "$TOKEN" ] || stop "login succeeded without an access token (MFA challenge?): $(head -c 300 "$DRILL_WORK/body")"
for path in services bookings; do
  code="$(http_code "$BASE/$path" -H "Authorization: Bearer $TOKEN")"
  [ "$code" = 200 ] || stop "GET /$path returned $code: $(head -c 300 "$DRILL_WORK/body")"
done
code="$(http_code "$BASE/services" -H "Authorization: Bearer $TOKEN")"
grep -q '"' "$DRILL_WORK/body" || stop "GET /services returned an empty body"

if [ -s "$DRILL_WORK/risky.txt" ]; then
  echo "WARN: smoke path passed, but these new migrations contain contract-style statements; the previous release may still break on paths the smoke does not cover:" >&2
  cat "$DRILL_WORK/risky.txt" >&2
  [ "${STRICT:-0}" != 1 ] || fail "STRICT=1 and contract-style statements found"
fi

cat <<SUMMARY

PASS rollback drill
  previous release         : ${PREV_SHA:0:12}   current: ${CUR_SHA:0:12}
  new migrations applied   : $n_new (previous API image ran against the migrated schema)
  /health/ready            : 200
  smoke path               : login, GET /services, GET /bookings all 200 as the restricted runtime login
SUMMARY
