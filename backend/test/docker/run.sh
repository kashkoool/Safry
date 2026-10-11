#!/usr/bin/env bash
# Runs the integration + route-coverage suites in Docker against a throw-away Linux PostgreSQL.
# The backend sources are copied into the container (host node_modules/dist are never used); everything
# is removed afterwards. The password is generated per run.
set -u
cd "$(dirname "$0")"
export TEST_PG_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
export TEST_PG_PORT="${TEST_PG_PORT:-55501}"
export MSYS_NO_PATHCONV=1
docker compose -f compose.yml up --abort-on-container-exit --exit-code-from runner
code=$?
docker compose -f compose.yml down -v --remove-orphans
exit $code
