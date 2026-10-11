# Safry Platform - contributor guide

Bilingual (Arabic/English, RTL/LTR) travel-services marketplace. Early development version; see `README.md` for status.

## Stack

- `backend/`: NestJS modular monolith (TypeScript), Prisma, PostgreSQL 17 with row-level security (RLS). Modules live in `backend/src/modules`.
- `frontend/`: React + Vite single-page app, React Router, Playwright for end-to-end tests.
- pnpm everywhere; `backend/` and `frontend/` each have their own lockfile. Node >= 22.12.

## Commands

```bash
pnpm install && pnpm --dir backend install && pnpm --dir frontend install
pnpm db:start                          # local Prisma Postgres (no Docker)
pnpm dev                               # API + web together
pnpm build                             # backend + frontend build

pnpm --dir backend test                # unit tests
pnpm --dir backend test:docker         # unit + integration + route coverage in Docker (same as CI)
pnpm --dir backend lint && pnpm --dir backend typecheck
pnpm --dir frontend lint && pnpm --dir frontend build
pnpm --dir frontend check:i18n         # translation keys
pnpm --dir frontend e2e                # Playwright
```

Integration tests need PostgreSQL 17 (`TEST_DATABASE_URL`) and run the compiled app: run `nest build` after every source change. Details: `backend/test/README.md`.

## Conventions

- Every tenant-owned record carries `tenantId`; the tenant comes from the verified token, never from a request header. RLS is the second layer: new tenant tables need a policy and a test.
- Schema changes go through Prisma migrations; migrations that remove things must be backward compatible (see `backend/docs/database-operations.md`).
- No default or real secrets in the repo. Generate your own in the git-ignored `backend/.env`; placeholders are rejected at startup.
- Commit messages: conventional style (`feat:`, `fix:`, `docs:`, `chore:`).
- Do not add features to docs before they exist in code: keep the README status table accurate.

## Verifying a change

Run lint, typecheck and the relevant tests above; for backend behaviour changes add or update an integration test. Report what you ran and the result.
