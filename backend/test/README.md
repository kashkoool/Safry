# Backend tests

| Suite | Files | Needs | Command (from `backend/`) |
|---|---|---|---|
| Unit | `src/**/*.spec.ts` | nothing | `pnpm test` |
| Integration + API | `test/*.int.spec.ts` | compiled app (`dist/`) and a PostgreSQL 17 server | `pnpm test:int` |
| Route-coverage gate | `scripts/route-coverage.ts` | hits recorded by the integration run | `pnpm test:routes` |
| Everything | all of the above | PostgreSQL | `pnpm test:int:all` |
| Everything in Docker | all of the above | Docker only | `pnpm test:docker` |

## Run everything in Docker (recommended, same as CI)

```bash
cd backend
pnpm test:docker
```

`test/docker/run.sh` starts a throw-away `postgres:17-alpine` (port `55501`, random password per run) and a `node:22` runner
that copies the sources (host `node_modules`/`dist` are never used), runs `pnpm install --frozen-lockfile`,
`prisma generate`, `nest build`, the unit tests, the integration tests and the route-coverage gate, then removes both
containers and the volume. After `test:int:all` it runs the integration suite a second time as the restricted runtime login (below). Exit code is the runner's. Override the port with `TEST_PG_PORT=55xxx pnpm test:docker`.

## Run against your own container

```bash
docker run -d --name safry-test-pg -e POSTGRES_PASSWORD=<pick-one> -p 55501:5432 postgres:17-alpine
cd backend
pnpm install --frozen-lockfile && pnpm exec prisma generate
export TEST_DATABASE_URL=postgresql://postgres:<pick-one>@127.0.0.1:55501/postgres
pnpm test:int:all                       # build, unit, integration, route-coverage
npx vitest run -c vitest.int.config.ts test/api-matrix.int.spec.ts   # one file (run `pnpm exec nest build` first)
docker rm -f safry-test-pg
```

`TEST_DATABASE_URL` points at the server, not a database: every run creates a randomly named database there, applies all
migrations and drops it afterwards. Without it the suite starts an embedded PostgreSQL (fine on Linux/macOS, flaky on
Windows: use Docker there). Integration tests run the **compiled** app, so run `nest build` after every source change.

## Run the suite as the restricted production login

By default the app under test connects as the superuser that the test Postgres starts with, and row-level security is only
exercised through the per-transaction `SET ROLE safry_app`. Production uses a restricted login (`safry_runtime`: NOSUPERUSER,
NOBYPASSRLS, member of `safry_app`), and some defects only appear there (a superuser login hides row-level-security defects).
Set `TEST_APP_AS_RUNTIME=1` and global setup creates such a login (random name and password, dropped afterwards) and points
only the application at it; fixtures and assertions keep the superuser. CI and `pnpm test:docker` run both modes.

```bash
TEST_APP_AS_RUNTIME=1 TEST_DATABASE_URL=postgresql://postgres:<pick-one>@127.0.0.1:55501/postgres   npx vitest run -c vitest.int.config.ts      # after `pnpm exec nest build`
```

A spec that creates a role the app must switch to has to `GRANT` it to the app login in this mode (see the runtime-role boot test in
`authz-extras.int.spec.ts`). `test/support/owner-db.ts` builds a database owned by a CREATEROLE, non-superuser, non-BYPASSRLS
role, used to prove migrations and `db:bootstrap`/`db:seed`/`admin:bootstrap` work for a managed-Postgres owner.

## What each integration file proves

| File | Scope |
|---|---|
| `api-matrix.int.spec.ts` | Every route the running app serves (read from the Express router): 401 without credentials, 403 for a role-less member and for a tenant admin on platform routes, 400 for unknown fields / wrong JSON types / malformed ids, bounded pagination, public probes. |
| `api-success.int.spec.ts` | Success, duplicate, boundary and cross-tenant cases for routes the other suites do not reach (services, organization roles/departments/specialties, provider registration, platform administration). |
| `api-extras.int.spec.ts` | Production boot refuses a privileged DB login (real roles), logout scope, refresh-token reuse and races, cursor pagination across tenants and with tampered cursors, the invitation consent state machine. |
| `api-throttle*.int.spec.ts` | Account throttle keyed e-mail + address over real HTTP (trusted and untrusted proxy), Redis outage degrades to in-process limits. Booted as `NODE_ENV=development` because rate limiting is off in `test`. |
| `auth-*.int.spec.ts`, `authorization`, `bookings`, `identity-management`, `tenant-isolation`, `migrations`, `perf` | Earlier suites per feature area. |

## Route-coverage gate

`World.api` appends every request to `test/.coverage/hits-<pid>.jsonl` (git-ignored). `pnpm test:routes` compares those
hits with the routes registered in `dist/` and fails when a route was never called, never answered 2xx, was never called
without credentials (or never answered 401), or never answered a 4xx. A new controller method therefore fails the gate
until a test exercises it. `pnpm test:int:all` clears the hit files first so stale hits cannot satisfy it.

## Conventions

- Fixtures come from `support/world.ts` (`createTenant`, `createUser`, `createOrganization`, `createService`, `session`).
  Passwords are fixtures, never real credentials; database passwords are generated per run.
- No application code changes for a test, except hooks that do not alter behaviour.
