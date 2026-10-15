import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, request as pwRequest, type Page } from "@playwright/test";
import { totp } from "./totp";

export const TENANT = "safry";
export const apiURL = process.env.E2E_API_URL ?? "http://127.0.0.1:55516";

export function secret(name: "E2E_DEMO_PASSWORD" | "E2E_ADMIN_PASSWORD"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to the password passed to the local seed (see frontend/README.md)`);
  return value;
}

/** Forces the English UI before the app loads, so selectors do not depend on the stored language. */
export async function useEnglish(page: Page): Promise<void> {
  await page.addInitScript(() => { try { window.localStorage.setItem("safry.language", "en"); } catch { /* ignore */ } });
}

export async function signIn(page: Page, portal: "customer" | "provider" | "admin", email: string, password: string): Promise<void> {
  await page.goto(`/login/${portal}`);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The refresh cookie (HttpOnly: invisible to page script, readable by the test runner). Name differs in production (__Secure- prefix). */
export async function refreshCookie(page: Page): Promise<{ name: string; value: string; httpOnly: boolean; sameSite: string; path: string } | undefined> {
  return (await page.context().cookies()).find((cookie) => /safry_rt$/.test(cookie.name));
}

/** Marks a mocked-API page as "has a cookie session": the app then resumes it through /auth/refresh on load. */
export async function seedSessionHint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("safry.hasSession", "1");
      sessionStorage.setItem("seeded", "1");
    }
  });
}

/** Makes the API see the access token the page currently holds as expired, without touching the page (it is memory-only). */
export async function expireAccessToken(page: Page): Promise<void> {
  let original: string | undefined;
  await page.route("**/api/v1/**", async (route) => {
    const headers = route.request().headers();
    const auth = headers["authorization"];
    if (!auth || /\/auth\/(login|refresh|logout)$/.test(route.request().url())) return route.fallback();
    original ??= auth;
    return route.fallback({ headers: auth === original ? { ...headers, authorization: "Bearer expired.invalid.token" } : headers });
  });
}

export async function expectSignedOut(page: Page, options: { cookieCleared?: boolean } = {}): Promise<void> {
  await expect(page).toHaveURL(/\/login\//);
  const stored = await page.evaluate(() => ({
    session: sessionStorage.getItem("safry.session"),
    hint: localStorage.getItem("safry.hasSession"),
    activity: sessionStorage.getItem("safry.lastActivityAt")
  }));
  expect(stored.session).toBeNull();
  expect(stored.hint).toBeNull();
  expect(stored.activity).toBeNull();
  if (options.cookieCleared !== false) expect(await refreshCookie(page)).toBeUndefined();
}

// Platform administrators must have two-factor enrolled (otherwise every platform route answers 403
// mfa_enrollment_required). The seeded admin is enrolled once per run through the real API; the generated secret and the
// last used time step live only in this git-ignored file (test-results/ is cleaned at the start of each run).
const ADMIN_MFA_FILE = "test-results/.admin-mfa.json";
const ADMIN_EMAIL = "admin@safry.local";
type AdminMfa = { secret: string; lastStep: number };
const readAdminMfa = (): AdminMfa | undefined => { try { return JSON.parse(readFileSync(ADMIN_MFA_FILE, "utf8")) as AdminMfa; } catch { return undefined; } };
const saveAdminMfa = (state: AdminMfa): void => { mkdirSync("test-results", { recursive: true }); writeFileSync(ADMIN_MFA_FILE, JSON.stringify(state)); };

async function ensureAdminMfa(password: string): Promise<AdminMfa> {
  const known = readAdminMfa();
  if (known) return known;
  const api = await pwRequest.newContext({ baseURL: apiURL });
  try {
    const login = await api.post("/api/v1/auth/login", { headers: { "x-client": "mobile" }, data: { email: ADMIN_EMAIL, password, tenantCode: TENANT } });
    const body = (await login.json()) as { accessToken?: string; mfaRequired?: boolean; user?: { tenantId: string } };
    if (!body.accessToken || !body.user) throw new Error(`seeded admin already has MFA but test-results/.admin-mfa.json is missing (reseed the database): HTTP ${login.status()}`);
    const headers = { authorization: `Bearer ${body.accessToken}`, "x-tenant-id": body.user.tenantId };
    const setup = await api.post("/api/v1/auth/mfa/setup", { headers, data: { password } });
    const secretKey = ((await setup.json()) as { secret: string }).secret;
    const step = Math.floor(Date.now() / 30_000);
    const enable = await api.post("/api/v1/auth/mfa/enable", { headers, data: { code: totp(secretKey, 0) } });
    expect(enable.status(), "enabling MFA for the seeded admin").toBe(200);
    const state = { secret: secretKey, lastStep: step };
    saveAdminMfa(state);
    return state;
  } finally {
    await api.dispose();
  }
}

/** Signs the seeded platform administrator in through the UI, enrolling and answering two-factor as needed. */
export async function signInAdmin(page: Page): Promise<void> {
  const password = secret("E2E_ADMIN_PASSWORD");
  const state = await ensureAdminMfa(password);
  await signIn(page, "admin", ADMIN_EMAIL, password);
  const code = page.getByLabel("Verification code");
  await code.waitFor({ state: "visible", timeout: 15_000 });
  // A code is single use: take a time step after the last one used (the server accepts one step either side).
  for (let tries = 0; tries < 40; tries++) {
    const now = Math.floor(Date.now() / 30_000);
    const step = [now - 1, now, now + 1].find((candidate) => candidate > state.lastStep);
    if (step !== undefined) {
      state.lastStep = step;
      saveAdminMfa(state);
      await code.fill(totp(state.secret, step - now));
      await page.getByRole("button", { name: /Verify|Sign in|Continue/ }).first().click();
      return;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error("no unused TOTP step available");
}
