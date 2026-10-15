# Continuous integration

Every workflow lives in `.github/workflows/`. Actions are pinned by full commit SHA, the default token is read-only
(`contents: read`), and no workflow uses `pull_request_target`.

| Workflow | Check name | Runs | Required for merge | What it does |
|---|---|---|---|---|
| `ci.yml` | Backend (lint, typecheck, unit, integration, route gate, build) | PR, push to main | yes | Lint, build, typecheck, unit and integration suites on PostgreSQL 17 (also as the restricted runtime login), route-coverage gate, production dependency audit |
| `ci.yml` | Frontend (lint, typecheck, build, i18n) | PR, push to main | yes | Lint, `tsc -b` + Vite build, i18n inventory |
| `ci.yml` | Migrate image (hardened run against PostgreSQL 17) | PR, push to main | yes | Builds the `migrate` image and runs it read-only, without capabilities; checks every migration is applied |
| `ci.yml` | Secret scan (gitleaks) | PR, push to main | yes | Scans the full git history |
| `ci.yml` | E2E (Playwright against the real stack) | PR, push to main | yes | Real API + PostgreSQL + the production nginx image (strict CSP), full Playwright suite in Chromium; report and traces are uploaded only on failure |
| `image-scan.yml` | Image scan (api / migrate / web) | every pull request; push to main; weekly | yes | Builds the three images, Trivy scan (HIGH/CRITICAL, fixable only), SARIF to code scanning, CycloneDX SBOM artifact. Reviewed exceptions in `.trivyignore`, each with an expiry date |
| `lighthouse.yml` | Lighthouse (performance, accessibility, best practices) | every pull request; weekly | yes | Median of 3 runs; budgets in `frontend/lighthouserc.json` (performance 0.9, accessibility 0.95, best practices 0.9) |
| `load-test.yml` | Load test (reduced dataset) | manual and weekly only | no | autocannon scenarios against the real API; fails on error rate above 0.5 % or p99 above the limit in `backend/test/load/thresholds.json`; results table in the job summary |
| `codeql.yml` | Analyze (javascript-typescript) | PR, push, weekly | no | CodeQL static analysis |
| `dependency-review.yml` | dependency-review | PR | no | Fails on newly introduced high-severity dependency advisories |
| `docker-size-budget.yml` | Docker image-size budget | PR touching image inputs, push | no | Fails when an image grows past its size cap |
| `prisma-migrate-status.yml` | prisma-migrate-status | PR touching Prisma files, push, manual | no | Applies all migrations to a fresh database and fails on schema drift |
| `no-ai-attribution.yml` | No AI attribution | PR | no | Blocks AI co-author trailers and footers in commits and PR text |
| `fuzz.yml` | Property-based fuzzing | PRs touching `backend/src/common`, `backend/src/config` or `backend/src/modules/mail`; weekly | no | fast-check property tests (`backend/src/common/fuzz.spec.ts`) over cursor decoding, money arithmetic, base32/TOTP, mail rendering and environment validation, 20000 cases per property; the same file runs with 300 cases in the normal unit suite |
| `recovery-drills.yml` | Backup and restore drill; Rollback drill | PR touching migrations, Dockerfile or `scripts/drills`; weekly; manual | no | Throwaway-Docker recovery drills, see "Recovery drills" below |
| `scorecard.yml` | Scorecard analysis | push, weekly | no | OpenSSF Scorecard results to code scanning |

Dependabot (`.github/dependabot.yml`) opens weekly minor and patch updates. Major versions are never proposed automatically: they
are planned upgrades.

## Running the checks locally

| Check | Command |
|---|---|
| Backend | `cd backend && pnpm install --frozen-lockfile && pnpm prisma:generate && pnpm lint && pnpm build && pnpm typecheck`; tests: `TEST_DATABASE_URL=<postgres url> pnpm test:int:all` (a throwaway PostgreSQL 17, never a real database) |
| Frontend | `cd frontend && pnpm install --frozen-lockfile && pnpm lint && pnpm build && pnpm check:i18n` |
| Migrate image | `docker build --target migrate -t safry-migrate:ci backend`, then run it as in `ci.yml` |
| Secret scan | `gitleaks git --no-banner .` |
| E2E | Follow "Browser end-to-end tests" in [frontend/README.md](../frontend/README.md) and the compose variant in [DEPLOYMENT.md](DEPLOYMENT.md); the CI job builds the API, migrates, creates the runtime login (`backend/scripts/db/create-runtime-role.sql`), seeds with generated passwords, starts the API on port 3000, runs the `frontend` image with `--add-host api:host-gateway`, then `E2E_NO_SERVER=1 pnpm e2e` |
| Image scan | `docker build --target runtime -t safry-api:scan backend` (also `--target migrate`, and `docker build -t safry-web:scan frontend`), then `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.75.0 image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --ignorefile /ignore/.trivyignore safry-api:scan` (mount `.trivyignore` at `/ignore`) |
| Lighthouse | `cd frontend && pnpm lighthouse` (set `CHROME_PATH` if Chrome is not found) |
| Load test | `backend/test/load/README.md`: seed a throwaway database (reduced size through the `LOAD_*` variables), start the API with `start-api.sh`, `node run.mjs --duration 12 --label ci`, then `node check.mjs --label ci` |
| Recovery drills | `bash scripts/drills/backup-restore.sh` and `bash scripts/drills/rollback.sh [previous-git-ref]` (docker, bash, git and curl only; Git Bash works) |

## Dependency updates: what merges itself and what never does

Dependabot only opens pull requests. Nothing is merged automatically except the narrow case below.

| Update | Policy |
|---|---|
| Major versions (any ecosystem) | Never proposed. Major upgrades are planned work: changelog read, migration done, tests adjusted. |
| Docker base images | One pull request per image, never grouped, never auto-merged. Read the version before merging. |
| Auth, session, validation, database and HTTP-hardening libraries (`argon2`, `helmet`, `@nestjs/jwt`, `@nestjs/passport`, `passport*`, `@nestjs/throttler`, `class-validator`, `class-transformer`, `@prisma/*`, `prisma`, `pg`, `ioredis`) | One pull request each, reviewed by hand. |
| Other minor and patch version updates | Grouped per project, reviewed by hand. |
| GitHub Actions | Grouped, reviewed by hand. |
| **Security-advisory pull requests** (label `security`) that are a **patch or minor** update and are **not** a Docker image or GitHub Action | Merged automatically by `dependabot-security-auto-merge.yml`, but only after every required check passes. A failing check keeps the pull request open. |

Rules for whoever merges by hand: open the pull request, read which packages and versions change, and check for a major version, a Dockerfile `FROM` line, or a runtime or database version change. A passing CI run alone is not a review. A test (`backend/src/dockerfile.spec.ts`) fails the build when the Node version in the Dockerfiles, `engines` or `@types/node` drifts from the version CI uses.

## Recovery drills

Both drills use only throwaway Docker containers (`safry-drill-*`, removed on exit, `DRILL_KEEP=1` keeps them for debugging) and per-run generated passwords. They are not required checks.

| Drill | Proves | Does not prove |
|---|---|---|
| `scripts/drills/backup-restore.sh` | Migrate + seed two tenants, `pg_dump` (custom format) and roles, restore into a brand-new PostgreSQL server with `pg_restore --exit-on-error`. Then: row count of every table (each audit partition included), indexes, constraints and whether validated, enabled and forced row-level security, policies, `audit_events` partitions, role attributes, grants, functions and applied migrations are identical; the restricted runtime login sees only its own tenant (and nothing without a tenant); `prisma migrate status` says up to date. Prints the restore time. A tampered restore fails the drill (checked by dropping a policy and a FORCE flag after restore). | The managed cloud backup service, point-in-time restore, cross-region restore, off-site or encrypted copies, restore time at production data volume (the printed time is for a small dataset) |
| `scripts/drills/rollback.sh [ref]` | The previous release's API image (built from `ref`, default: merge-base with `origin/main`, or `HEAD~1` on main) starts and serves `/health/ready`, login, `GET /services` and `GET /bookings` against a database that already has this release's migrations applied. Lists the new migrations; on failure names them and the ones with contract-style statements. `STRICT=1` also fails on those statements even when the smoke path passes. The header of the script classifies today's migrations as expand-only or contract-style. | Rollback in the real hosting (image tag redeploy), every write path of the previous release, data that the seed does not contain |

The workflow checks out the full history for the rollback drill (`fetch-depth: 0`); a shallow clone cannot resolve the previous release.
