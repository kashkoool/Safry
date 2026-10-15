#!/usr/bin/env bash
# Shared helpers for the recovery drills (sourced, not executed). Docker only, nothing cloud, no secrets:
# every password is generated per run and every container/network is throwaway (name prefix safry-drill-).
# shellcheck shell=bash

export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'   # Git Bash on Windows: do not rewrite /paths passed to docker

PG_IMAGE="${PG_IMAGE:-postgres:17.11-alpine}"        # same pin as .github/workflows/ci.yml
DRILL_ID="${DRILL_ID:-$$}"
DRILL_NET="safry-drill-net-${DRILL_ID}"
DRILL_DB="safry_drill"
DRILL_PG_PASSWORD="$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')"
DRILL_RUNTIME_PASSWORD="$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')"
DRILL_SEED_PASSWORD="$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')"
DRILL_JWT_SECRET="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
DRILL_CONTAINERS=()
DRILL_IMAGES=()
DRILL_WORK="$(mktemp -d)"

log()  { printf '[drill] %s\n' "$*"; }
fail() { printf '[drill] FAIL: %s\n' "$*" >&2; exit 1; }

drill_cleanup() {
  local rc=$?
  local c
  for c in "${DRILL_CONTAINERS[@]:-}"; do [ -n "$c" ] && docker rm -fv "$c" >/dev/null 2>&1; done
  for c in "${DRILL_IMAGES[@]:-}"; do [ -n "$c" ] && docker rmi -f "$c" >/dev/null 2>&1; done
  docker network rm "$DRILL_NET" >/dev/null 2>&1
  rm -rf "$DRILL_WORK"
  return "$rc"
}

drill_init() {
  command -v docker >/dev/null 2>&1 || fail "docker is required"
  docker info >/dev/null 2>&1 || fail "docker daemon is not reachable"
  trap drill_cleanup EXIT
  trap 'exit 130' INT TERM
  docker network create "$DRILL_NET" >/dev/null
}

# start_pg <container>: throwaway PostgreSQL on the drill network, no published port.
start_pg() {
  local name="$1"
  DRILL_CONTAINERS+=("$name")
  docker run -d --name "$name" --network "$DRILL_NET" -e POSTGRES_PASSWORD="$DRILL_PG_PASSWORD" "$PG_IMAGE" >/dev/null
  local i=0
  # The official image restarts once after its init scripts: wait for two consecutive successful TCP-level answers.
  until docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 \
        && sleep 2 && docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 60 ] || fail "$name did not become ready"
    sleep 1
  done
}

# psql_owner <container> <db> [psql args...]: owner (superuser) session, SQL on stdin or via -c.
psql_owner() {
  local c="$1" db="$2"; shift 2
  docker exec -i -e PGPASSWORD="$DRILL_PG_PASSWORD" "$c" psql -h 127.0.0.1 -U postgres -d "$db" -X -v ON_ERROR_STOP=1 -qAt "$@"
}

owner_url() { printf 'postgresql://postgres:%s@%s:5432/%s?schema=public' "$DRILL_PG_PASSWORD" "$1" "$DRILL_DB"; }

# native_path <dir>: a path the docker CLI understands (Git Bash needs the Windows form, Linux the plain one).
native_path() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }

# build_migrate_image <git-tree-dir-containing-backend> <tag>
build_migrate_image() {
  log "building migrate image $2 from $1/backend"
  docker build -q --target migrate -t "$2" "$(native_path "$1/backend")" >/dev/null || fail "migrate image build failed ($1)"
}

# run_migrate <image> <pg-container> [prisma args...]: default is `migrate deploy`.
run_migrate() {
  local image="$1" host="$2"; shift 2
  local args=("$@"); [ "${#args[@]}" -gt 0 ] || args=(migrate deploy)
  docker run --rm --network "$DRILL_NET" -e NODE_ENV=production \
    -e DATABASE_URL="$(owner_url "$host")" -e DATABASE_MIGRATE_URL="$(owner_url "$host")" \
    "$image" node node_modules/prisma/build/index.js "${args[@]}"
}

# run_seed <image> <pg-container> <tenant-code> <admin-email>: demo seed (throwaway data, per-run passwords).
run_seed() {
  local image="$1" host="$2" code="$3" admin="$4"
  docker run --rm --network "$DRILL_NET" -e NODE_ENV=development \
    -e DATABASE_URL="$(owner_url "$host")" -e DATABASE_MIGRATE_URL="$(owner_url "$host")" \
    -e BOOTSTRAP_TENANT_CODE="$code" -e BOOTSTRAP_TENANT_NAME="Drill $code" -e BOOTSTRAP_ADMIN_EMAIL="$admin" \
    -e BOOTSTRAP_ADMIN_PASSWORD="${DRILL_SEED_PASSWORD}Aa1" -e DEMO_SEED_PASSWORD="$DRILL_SEED_PASSWORD" \
    "$image" node node_modules/tsx/dist/cli.mjs prisma/seed.ts >/dev/null
}

# run_bootstrap <image> <pg-container> <tenant-code> <admin-email>: a second, empty tenant with only its administrator
# (the demo seed owns fixed global demo e-mails, so it can populate one tenant only).
run_bootstrap() {
  local image="$1" host="$2" code="$3" admin="$4"
  docker run --rm --network "$DRILL_NET" -e NODE_ENV=development     -e DATABASE_URL="$(owner_url "$host")" -e DATABASE_MIGRATE_URL="$(owner_url "$host")"     -e BOOTSTRAP_TENANT_CODE="$code" -e BOOTSTRAP_TENANT_NAME="Drill $code" -e BOOTSTRAP_ADMIN_EMAIL="$admin"     -e BOOTSTRAP_ADMIN_PASSWORD="${DRILL_SEED_PASSWORD}Aa1"     "$image" node node_modules/tsx/dist/cli.mjs prisma/bootstrap.ts >/dev/null
}

# create_runtime_role <pg-container> <sql-file>: the restricted LOGIN the API uses (safry_runtime).
create_runtime_role() {
  psql_owner "$1" "$DRILL_DB" -v runtime_password="$DRILL_RUNTIME_PASSWORD" < "$2" >/dev/null
}

# Wait for an HTTP 200 on a URL.
wait_http() {
  local url="$1" tries="${2:-60}" i=0
  until curl -fsS -o /dev/null "$url" 2>/dev/null; do
    i=$((i + 1)); [ "$i" -lt "$tries" ] || return 1; sleep 2
  done
}
