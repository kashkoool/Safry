# Continuous integration

Every workflow lives in `.github/workflows/`. Actions are pinned by full commit SHA, the default token is read-only
(`contents: read`), and exactly one workflow uses `pull_request_target`: `dependabot-security-auto-merge.yml`. It gets a
write token (`contents: write`, `pull-requests: write`, granted to its single job only), so it never checks out or runs pull request
code. It runs only when the pull request author is `dependabot[bot]`, reads Dependabot's metadata with `dependabot/fetch-metadata`
(pinned by SHA) and only calls `gh pr merge --auto`. It queues a merge only for patch or minor updates labelled `security`, and
skips Docker, Docker Compose and GitHub Actions updates; untrusted values reach the shell through environment variables, not
inline expansion. The queued merge still waits for the required checks on `main`.

| Workflow | Check name | Runs | Required for merge | What it does |
|---|---|---|---|---|
| `ci.yml` | Backend (lint, typecheck, unit, integration, route gate, build) | PR, push to main | yes | Lint, build, typecheck, unit and integration suites on PostgreSQL 17 (also as the restricted runtime login), route-coverage gate, production dependency audit |
| `ci.yml` | Frontend (lint, typecheck, build, i18n) | PR, push to main | yes | Lint, `tsc -b` + Vite build, i18n inventory |
| `ci.yml` | Migrate image (hardened run against PostgreSQL 17) | PR, push to main | yes | Builds the `migrate` image and runs it read-only, without capabilities; checks every migration is applied |
| `ci.yml` | Secret scan (gitleaks) | PR, push to main | yes | Scans the full git history |
| `ci.yml` | E2E (Playwright against the real stack) | PR, push to main | yes | Real API + PostgreSQL + the production nginx image (strict CSP), full Playwright suite in Chromium; report and traces are uploaded only on failure |
| `image-scan.yml` | Image scan (api / migrate / web) | every pull request; push to main; weekly | yes | Builds the three images, Trivy scan (HIGH/CRITICAL, fixable only), SARIF to code scanning, CycloneDX SBOM artifact. Reviewed exceptions in `.trivyignore`, each with an expiry date |
| `lighthouse.yml` | Lighthouse (performance, accessibility, best practices) | every pull request; weekly | yes | Median of 3 runs; budgets in `frontend/lighthouserc.json` (performance 0.9, accessibility 0.95, best practices 0.9) |
| `load-test.yml` | Load test (reduced dataset) | manual and weekly only | no | autocannon and virtual-user scenarios against the real API with a `profile` input (smoke, standard, soak, see below); fails on error rate above 0.5 % or a latency above the limit in `backend/test/load/thresholds.json`; results tables in the job summary |
| `codeql.yml` | Analyze (javascript-typescript) | PR, push, weekly | no | CodeQL static analysis |
| `dependency-review.yml` | dependency-review | PR | no | Fails on newly introduced high-severity dependency advisories |
| `docker-size-budget.yml` | Docker image-size budget | PR touching image inputs, push | no | Fails when an image grows past its size cap |
| `prisma-migrate-status.yml` | prisma-migrate-status | PR touching Prisma files, push, manual | no | Applies all migrations to a fresh database and fails on schema drift |
| `no-ai-attribution.yml` | No AI attribution | PR | no | Blocks AI co-author trailers and footers in commits and PR text |
| `fuzz.yml` | Property-based fuzzing | PRs touching `backend/src/common`, `backend/src/config` or `backend/src/modules/mail`; weekly | no | fast-check property tests (`backend/src/common/fuzz.spec.ts`) over cursor decoding, money arithmetic, base32/TOTP, mail rendering and environment validation, 20000 cases per property; the same file runs with 300 cases in the normal unit suite |
| `dast.yml` | DAST (ZAP baseline) | PRs touching nginx/headers/auth code; weekly; manual | no | OWASP ZAP baseline (passive) against a throwaway stack built in the job; fails on any Medium or higher alert; report uploaded as an artifact |
| `e2e-browsers.yml` | Cross-browser E2E | weekly and manual | no | The mocked Playwright specs in Firefox and WebKit |
| `visual.yml` | Visual regression | PRs touching `frontend/src`; manual | no | Playwright screenshots of key pages (English and Arabic) in the pinned Playwright image |
| `soak.yml` | Soak test | manual only | no | 30 minutes at 20 requests/s against the real API; fails on p95 drift, memory growth or errors |
| `recovery-drills.yml` | Backup and restore drill; Rollback drill | PR touching migrations, Dockerfile or `scripts/drills`; weekly; manual | no | Throwaway-Docker recovery drills, see "Recovery drills" below |
| `alerts.yml` | Alert rules (promtool) | PR touching `deploy/alerts`, `scripts/alerts-test.sh` or the metrics code; manual | no | Checks and unit-tests the Prometheus alert rules in the pinned official image; see [ALERTING.md](ALERTING.md) |
| `scorecard.yml` | Scorecard analysis | push, weekly | no | OpenSSF Scorecard results to code scanning |

Dependabot (`.github/dependabot.yml`) opens weekly minor and patch updates. Major versions are never proposed automatically: they
are planned upgrades.

## Running the checks locally

| Check | Command |
|---|---|
| Backend | `cd backend && pnpm install --frozen-lockfile && pnpm prisma:generate && pnpm lint && pnpm build && pnpm typecheck`; tests: `pnpm test:int` starts its own embedded PostgreSQL (UTF-8 encoding and the C locale, which avoids the Windows code-page failure); `TEST_DATABASE_URL=<postgres url> pnpm test:int:all` runs build, unit, integration and the route gate against a throwaway PostgreSQL 17 you provide (never a real database), as CI does |
| Frontend | `cd frontend && pnpm install --frozen-lockfile && pnpm lint && pnpm build && pnpm check:i18n` |
| Migrate image | `docker build --target migrate -t safry-migrate:ci backend`, then run it as in `ci.yml` |
| Secret scan | `gitleaks git --no-banner .` |
| E2E | Follow "Browser end-to-end tests" in [frontend/README.md](../frontend/README.md) and the compose variant in [DEPLOYMENT.md](DEPLOYMENT.md); the CI job builds the API, migrates, creates the runtime login (`backend/scripts/db/create-runtime-role.sql`), seeds with generated passwords, starts the API on port 3000, runs the `frontend` image with `--add-host api:host-gateway`, then `E2E_NO_SERVER=1 pnpm e2e` |
| Image scan | `docker build --target runtime -t safry-api:scan backend` (also `--target migrate`, and `docker build -t safry-web:scan frontend`), then `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.75.0 image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --ignorefile /ignore/.trivyignore safry-api:scan` (mount `.trivyignore` at `/ignore`) |
| Lighthouse | `cd frontend && pnpm lighthouse` (set `CHROME_PATH` if Chrome is not found) |
| Load test | `backend/test/load/README.md`: seed a throwaway database (reduced size through the `LOAD_*` variables), start the API with `backend/test/load/start-api.sh`, `node run.mjs --duration 12 --label ci`, then `node check.mjs --label ci` |
| Alert rules | `bash scripts/alerts-test.sh` (rule tests); `bash scripts/alerts-fire-test.sh` (full local stack, proves the alerts fire; see [ALERTING.md](ALERTING.md)) |
| Recovery drills | `bash scripts/drills/backup-restore.sh` and `bash scripts/drills/rollback.sh [previous-git-ref]` (docker, bash, git and curl only; Git Bash works) |

## Extra test types (not required checks)

**DAST.** `.github/workflows/dast.yml` runs the ZAP baseline (passive: it spiders and reads responses) against the API, PostgreSQL and the production nginx image, seeded with per-run passwords. The image is pinned by version and digest. `scripts/dast-check.mjs` fails on any alert of risk Medium or higher; `.zap/rules.tsv` lists ignored rules, each with a reason. Locally: start the stack, then `scripts/dast-local.sh [url]` (reports in `.zap-report/`; `DAST_NETWORK=<network>` to reach a container by name). The ZAP **active** scan (`zap-full-scan.py`) sends attack traffic and creates junk data: run it only against a staging copy, never in CI and never against production.

**Cross-browser.** Pull-request CI runs Chromium only. `E2E_PROJECTS=browsers pnpm exec playwright test` (or the weekly `e2e-browsers.yml`) runs every spec that mocks the API in Firefox and WebKit; specs that need the real stack are listed in `needsRealStack` in `frontend/playwright.config.ts`.

**Visual regression.** `frontend/e2e/visual.shot.ts` (fixed viewport, fixed clock, mocked data) compares six screenshots (login, account, platform accounts list; English and Arabic) with `frontend/e2e/__screenshots__/`. They must be produced on Linux in the Playwright image CI uses, so run `frontend/scripts/visual-snapshots.sh` to compare and `frontend/scripts/visual-snapshots.sh --update` after an intended UI change; review the PNG diff and commit it. When `@playwright/test` is upgraded, change the image tag in that script and in `visual.yml` and regenerate.

**Load profiles and capacity scenarios.** `load-test.yml` takes a `profile` input. `smoke`: the ten read and write scenarios with the rate limiter off (the old behaviour). `standard` (the weekly default): smoke, then the API is restarted with the rate limiter on (`LOAD_LIMITER=on`: `NODE_ENV=development`, `TRUST_PROXY=1`, every simulated client has its own address in `X-Forwarded-For`) and runs the login storm, registration storm, booking contention (500 travelers for the last 200 seats, SQL check that nothing is oversold), the single-address 429 path, and a 200-user mixed workload (2 minutes). `soak`: standard plus a sustained 200-user run (`soak_minutes`, default 10) that also checks p95 drift and API memory growth. Run any scenario locally with the commands in `backend/test/load/README.md` ("Capacity scenarios"): knobs are `--connections`, `--steps` (find the knee by stepping connections), `--users`, `--think`, `--seconds`; read the result as described there. Limits in `thresholds.json` are regression guards; the capacity targets for a small product (200 concurrent mixed users with p95 under 500 ms and errors under 0.5 %, 20 sign-ins per second, 5 registrations per second, no oversold seat) are proposals in the README for the owner to adjust. Numbers measured on Docker Desktop are not production numbers: rerun on the real deployment.

**Soak.** `backend/test/load/soak.mjs` holds a low constant rate (default 20 requests/s, 30 minutes) and samples latency and the API's memory every minute; limits are in the `soak` block of `thresholds.json`. Start it from the Actions tab (`soak.yml`, inputs: minutes, rate) or follow `backend/test/load/README.md`. Shared runners are noisy: treat a failure as a reason to re-run on quiet hardware before concluding there is a leak.

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
