# Contributing

## Branching

- `main` is protected and always releasable. Work on a short-lived branch: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`.
- Open a pull request into `main`. The required checks listed in [docs/CI.md](docs/CI.md) must pass (backend, frontend, migrate image, secret scan, E2E, image scan, Lighthouse and the others marked required there). CodeQL and the other non-required workflows run when their triggers match (see the trigger table in docs/CI.md); look at their results, but they do not block the merge. No approval count is enforced by branch protection, and linear history is required.

## Commits

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.
- Commits carry the human author only. Do not add `Co-Authored-By` trailers or any "generated with" / AI attribution lines to commits, PR titles or PR descriptions. CI (`no-ai-attribution`) rejects them.
- Never commit secrets, passwords, tokens or personal data. Use environment variables; copy `backend/.env.example` and `docker.env.example` and replace every `CHANGE_ME` value.

## Running checks locally

Requires Node 22.12 or newer (`engines` in `backend/package.json`) and pnpm 11 (the version CI uses). Each of `backend/` and `frontend/` has its own lockfile.

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
