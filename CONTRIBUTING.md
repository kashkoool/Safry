# Contributing

## Branching

- `main` is protected and always releasable. Work on a short-lived branch: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`.
- Open a pull request into `main`. CI (lint, typecheck, tests, build, secret scan, CodeQL) must be green and the owner must approve.

## Commits

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.
- Commits carry the human author only. Do not add `Co-Authored-By` trailers or any "generated with" / AI attribution lines to commits, PR titles or PR descriptions. CI (`no-ai-attribution`) rejects them.
- Never commit secrets, passwords, tokens or personal data. Use environment variables; copy `backend/.env.example` and `docker.env.example` and replace every `CHANGE_ME` value.

## Running checks locally

Requires Node 22 and pnpm 11. Each of `backend/` and `frontend/` has its own lockfile.

```bash
cd backend
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm lint
pnpm build
pnpm typecheck      # needs the build output
pnpm test           # unit tests
pnpm test:int       # integration tests (start their own throwaway PostgreSQL)

cd ../frontend
pnpm install --frozen-lockfile
pnpm lint
pnpm build          # runs tsc -b first
```

Demo data: see the local-setup section of the README. Seeding is opt-in and needs passwords you generate yourself (`openssl rand -base64 18`).
