import { expect, type Page } from "@playwright/test";

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
