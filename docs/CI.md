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
| `dast.yml` | DAST (ZAP baseline) | PRs touching nginx/headers/auth code; weekly; manual | no | OWASP ZAP baseline (passive) against a throwaway stack built in the job; fails on any Medium or higher alert; report uploaded as an artifact |
| `e2e-browsers.yml` | Cross-browser E2E | weekly and manual | no | The mocked Playwright specs in Firefox and WebKit |
| `visual.yml` | Visual regression | PRs touching `frontend/src`; manual | no | Playwright screenshots of key pages (English and Arabic) in the pinned Playwright image |
| `soak.yml` | Soak test | manual only | no | 30 minutes at 20 requests/s against the real API; fails on p95 drift, memory growth or errors |
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

## Extra test types (not required checks)

**DAST.** `.github/workflows/dast.yml` runs the ZAP baseline (passive: it spiders and reads responses) against the API, PostgreSQL and the production nginx image, seeded with per-run passwords. The image is pinned by version and digest. `scripts/dast-check.mjs` fails on any alert of risk Medium or higher; `.zap/rules.tsv` lists ignored rules, each with a reason. Locally: start the stack, then `scripts/dast-local.sh [url]` (reports in `.zap-report/`; `DAST_NETWORK=<network>` to reach a container by name). The ZAP **active** scan (`zap-full-scan.py`) sends attack traffic and creates junk data: run it only against a staging copy, never in CI and never against production.

**Cross-browser.** Pull-request CI runs Chromium only. `E2E_PROJECTS=browsers pnpm exec playwright test` (or the weekly `e2e-browsers.yml`) runs every spec that mocks the API in Firefox and WebKit; specs that need the real stack are listed in `needsRealStack` in `frontend/playwright.config.ts`.

**Visual regression.** `frontend/e2e/visual.shot.ts` (fixed viewport, fixed clock, mocked data) compares six screenshots (login, account, platform accounts list; English and Arabic) with `frontend/e2e/__screenshots__/`. They must be produced on Linux in the Playwright image CI uses, so run `frontend/scripts/visual-snapshots.sh` to compare and `frontend/scripts/visual-snapshots.sh --update` after an intended UI change; review the PNG diff and commit it. When `@playwright/test` is upgraded, change the image tag in that script and in `visual.yml` and regenerate.

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
