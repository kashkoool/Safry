# Safry frontend

React 19 + Vite SPA. Pages are lazy-loaded per route; the English dictionary is a separate chunk loaded on demand.

```bash
pnpm install --frozen-lockfile
pnpm dev            # http://127.0.0.1:3001, proxies /api to VITE_PROXY_TARGET (default http://localhost:3000)
pnpm build          # tsc -b + vite build
pnpm lint
pnpm check:i18n     # every backend Arabic message needs an English entry in src/i18n/messages.json
```

## Browser end-to-end tests (Playwright)

Journeys covered: login per portal, wrong password, HttpOnly refresh cookie (no credential in web storage, reload resumes the
session), logout (server revoke, cleared cookie and state, back button, cross-tab), expired access token, single-flight refresh,
two-tab rotation race, session expiry, MFA login (TOTP, wrong code, recovery code), language
switch RTL/LTR, booking creation, error sanitisation, failed activity ping. Any Content-Security-Policy violation
printed to the browser console fails the test that caused it.

Needs a running API with the local seed (demo accounts) and its passwords:

```bash
# 1. throwaway database + API (see backend/README.md); seed with your own generated passwords
# 2. install the browser once
npx playwright install chromium
# 3. run (starts `vite preview` on E2E_BASE_URL's port unless E2E_NO_SERVER=1)
E2E_DEMO_PASSWORD=<DEMO_SEED_PASSWORD> E2E_ADMIN_PASSWORD=<BOOTSTRAP_ADMIN_PASSWORD> \
E2E_API_URL=http://127.0.0.1:55516 E2E_BASE_URL=http://127.0.0.1:55526 pnpm e2e
```

To test against the production image (nginx with the real CSP), build `frontend/Dockerfile`, run it on the
`E2E_BASE_URL` port with `/api` proxied to your API, and set `E2E_NO_SERVER=1`.

Session model: the refresh token is an HttpOnly cookie set by the API (`safry_rt`; `__Secure-safry_rt` when the API runs with
`NODE_ENV=production` — set `E2E_COOKIE_NAME` accordingly); the access token is kept in memory only and re-obtained through
`/auth/refresh` on page load. `vite dev`/`preview` proxy `/api` without rewriting `Host`, so the API's same-origin check passes.

The MFA tests enable MFA on `visa@safry.local` and switch it off again at the end of the run.

## Lighthouse CI

```bash
pnpm lighthouse     # builds, serves `vite preview` on 55563, 3 runs on /login/customer
```

Budget in `lighthouserc.json`: performance >= 0.9, accessibility >= 0.95, best-practices >= 0.9 (errors, median of 3 runs); TBT < 300 ms, CLS < 0.1 (warnings).
Set `CHROME_PATH` if Chrome is not found. Reports go to `.lighthouseci/` (git-ignored).
