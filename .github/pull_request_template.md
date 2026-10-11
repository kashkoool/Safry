## What and why

<!-- One or two sentences. Link the issue or requirement ID. -->

## How it was verified

- [ ] `pnpm lint`, `pnpm build` (and `pnpm typecheck` for backend) pass locally
- [ ] Unit and integration tests added or updated for the change
- [ ] Exercised the changed path (not only a health check)

## Safety checklist

- [ ] No secrets, passwords, tokens or personal data in the diff
- [ ] Authorization and tenant scoping checked for any new endpoint or query
- [ ] Database changes ship as a migration; existing data stays valid
- [ ] Commit messages follow Conventional Commits and carry no AI attribution lines
