import { randomBytes } from "node:crypto";
import { expect, test, request as pwRequest, type Page } from "@playwright/test";
import { apiURL, expectSignedOut, refreshCookie, secret, signIn, TENANT, useEnglish } from "./helpers";
import { totp } from "./totp";

// Real backend. One sacrificial account (`hotel@`) goes through every account screen; everything it changes is put
// back at the end (also when a step fails half way), so the other journeys keep working.
const DEMO = () => secret("E2E_DEMO_PASSWORD");
const email = "hotel@safry.local";
const portal = "provider";
/** Signs in through the UI and waits until the workspace is up (navigating earlier would abort the sign-in). */
async function enter(page: Page): Promise<void> {
  await signIn(page, portal, email, DEMO());
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
}
const fresh = `Pw-${randomBytes(9).toString("hex")}`;

type Api = Awaited<ReturnType<typeof pwRequest.newContext>>;

async function login(api: Api, password: string, mfaCode?: string) {
  const first = await api.post("/api/v1/auth/login", { data: { email, password, tenantCode: TENANT, portal } });
  if (first.status() !== 200 && first.status() !== 201) return null;
  const body = await first.json();
  if (!body.mfaToken) return body as { accessToken: string; user: { tenantId: string } };
  if (!mfaCode) return null;
  const verified = await api.post("/api/v1/auth/mfa/verify", { data: { mfaToken: body.mfaToken, code: mfaCode } });
  return verified.ok() ? await verified.json() as { accessToken: string; user: { tenantId: string } } : null;
}

// What the two-factor test needs to undo itself when it stops half way.
let spareCodes: string[] = [];

test.afterAll(async () => {
  const api = await pwRequest.newContext({ baseURL: apiURL });
  const attempt = async (password: string) => {
    const first = await api.post("/api/v1/auth/login", { data: { email, password, tenantCode: TENANT, portal } });
    if (!first.ok()) return null;
    const body = await first.json();
    if (!body.mfaToken) return body as { accessToken: string; user: { tenantId: string } };
    const code = spareCodes.pop();
    if (!code) return null;
    const verified = await api.post("/api/v1/auth/mfa/verify", { data: { mfaToken: body.mfaToken, code } });
    const session = verified.ok() ? await verified.json() as { accessToken: string; user: { tenantId: string } } : null;
    const off = spareCodes.pop();
    if (session && off) {
      await api.post("/api/v1/auth/mfa/disable", {
        headers: { authorization: `Bearer ${session.accessToken}`, "x-tenant-id": session.user.tenantId },
        data: { password, code: off }
      });
    }
    return session;
  };
  // Whichever password is current, put the seeded one back and make sure two-factor is off.
  if (await attempt(DEMO())) return;
  const session = await attempt(fresh);
  if (!session) return;
  await api.post("/api/v1/auth/password", {
    headers: { authorization: `Bearer ${session.accessToken}`, "x-tenant-id": session.user.tenantId },
    data: { currentPassword: fresh, newPassword: DEMO() }
  });
});

test.beforeEach(async ({ page }) => { await useEnglish(page); });

test("profile: edit, persist across reload, clear the phone number, restore", async ({ page }) => {
  await enter(page);
  await page.getByRole("link", { name: "Open account" }).click();
  await expect(page).toHaveURL(/\/account\/profile$/);
  const name = page.getByLabel("Display name");
  const phone = page.getByLabel("Phone number (optional)");
  await expect(name).not.toHaveValue("");
  const original = { name: await name.inputValue(), phone: await phone.inputValue() };
  await name.fill("E2E Account Name");
  await phone.fill("+90 555 000 11 22");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your profile was saved." })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Display name")).toHaveValue("E2E Account Name");
  await expect(page.getByLabel("Phone number (optional)")).toHaveValue("+90 555 000 11 22");
  await page.getByLabel("Phone number (optional)").fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your profile was saved." })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Phone number (optional)")).toHaveValue("");
  await page.getByLabel("Display name").fill(original.name);
  if (original.phone) await page.getByLabel("Phone number (optional)").fill(original.phone);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your profile was saved." })).toBeVisible();
});

test("password: a wrong current password is refused, a change ends other sessions, the new password signs in", async ({ page, browser }) => {
  // a second device signed in first: it must be ended by the change
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await useEnglish(otherPage);
  await signIn(otherPage, portal, email, DEMO());
  await expect(otherPage.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });

  await enter(page);
  await page.goto("/account/security");
  const form = page.getByRole("article", { name: "Change password" });
  await form.getByLabel("Current password").fill("definitely-not-it-123");
  await form.getByLabel("New password", { exact: true }).fill(fresh);
  await form.getByLabel("Confirm new password").fill(fresh);
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form.getByRole("alert")).toHaveText("The current password is incorrect.");
  await expect(page).toHaveURL(/\/account\/security$/); // still signed in: a wrong secret does not log the user out

  await form.getByLabel("Current password").fill(DEMO());
  await form.getByLabel("New password", { exact: true }).fill(fresh);
  await form.getByLabel("Confirm new password").fill(fresh);
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form.getByRole("status")).toContainText("other devices were signed out");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible(); // this device stays signed in

  await otherPage.reload();
  await expectSignedOut(otherPage, { cookieCleared: false });
  await other.close();

  const api = await pwRequest.newContext({ baseURL: apiURL });
  expect(await login(api, DEMO())).toBeNull();
  expect(await login(api, fresh)).not.toBeNull();

  // put the seeded password back through the UI as well
  await form.getByLabel("Current password").fill(fresh);
  await form.getByLabel("New password", { exact: true }).fill(DEMO());
  await form.getByLabel("Confirm new password").fill(DEMO());
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form.getByRole("status")).toContainText("other devices were signed out");
  expect(await login(api, DEMO())).not.toBeNull();
});

test("two-factor: turn on with a real authenticator code, sign in with it, create new codes, turn off", async ({ page, browser }) => {
  await enter(page);
  await page.goto("/account/security");
  const panel = page.getByRole("article", { name: "Two-factor sign-in" });
  await expect(panel.getByText("Two-factor sign-in: off")).toBeVisible();
  await panel.getByRole("button", { name: "Turn on two-factor sign-in" }).click();
  await panel.getByLabel("Current password").fill(DEMO());
  await panel.getByRole("button", { name: "Continue" }).click();
  await expect(panel.getByRole("img", { name: /QR code/ })).toBeVisible();
  const key = ((await panel.locator(".account-key").textContent()) ?? "").replace(/\s+/g, "");
  expect(key).toMatch(/^[A-Z2-7]{16,}$/);
  await panel.getByLabel("Authenticator app code (6 digits)").fill(totp(key));
  await panel.getByRole("button", { name: "Turn on" }).click();
  await expect(panel.getByRole("heading", { name: /Step 3 of 3/ })).toBeVisible();
  await expect(panel.locator(".account-codes code").first()).toBeVisible();
  const codes = (await panel.locator(".account-codes code").allTextContents()).map((text) => text.trim());
  expect(codes.length).toBeGreaterThanOrEqual(8);
  spareCodes = [...codes].reverse().slice(0, 4); // never the first (used below) or second (replaced below)
  await panel.getByLabel("I have saved these codes").check();
  await panel.getByRole("button", { name: "Done" }).click();
  await expect(panel.getByText("Two-factor sign-in: on")).toBeVisible();

  // a fresh sign-in now needs the second step, and the first recovery code works
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await useEnglish(otherPage);
  await signIn(otherPage, portal, email, DEMO());
  await otherPage.getByLabel("Verification code").fill(codes[0]!);
  await otherPage.getByRole("button", { name: "Verify" }).click();
  await expect(otherPage.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  await other.close();

  // voluntary regeneration (next time window: a code is single-use)
  await panel.getByRole("button", { name: "Create new recovery codes" }).click();
  await panel.getByLabel("Current password").fill(DEMO());
  await panel.getByLabel("Authenticator app code (6 digits)").fill(totp(key, 1));
  await panel.getByRole("button", { name: "Create codes" }).click();
  await expect(panel.locator(".account-codes code").first()).toBeVisible();
  const fresher = (await panel.locator(".account-codes code").allTextContents()).map((text) => text.trim());
  expect(fresher.length).toBeGreaterThanOrEqual(8);
  spareCodes = [...fresher].reverse().slice(0, 4);
  expect(fresher).not.toContain(codes[1]);
  await panel.getByLabel("I have saved these codes").check();
  await panel.getByRole("button", { name: "Done" }).click();

  // turn off with a recovery code
  await panel.getByRole("button", { name: "Turn off two-factor sign-in" }).click();
  await panel.getByLabel("Current password").fill(DEMO());
  await panel.getByLabel("App code or recovery code").fill(fresher[0]!);
  await panel.getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(panel.getByText("Two-factor sign-in: off")).toBeVisible();
  const api = await pwRequest.newContext({ baseURL: apiURL });
  expect(await login(api, DEMO())).not.toBeNull(); // no second step any more
});

test("sessions: sign out of all devices ends this sign-in and the cookie can no longer refresh", async ({ page }) => {
  await enter(page);
  await page.goto("/account/sessions");
  await expect(page.getByRole("heading", { name: "Active sign-ins" })).toBeVisible();
  expect(await refreshCookie(page)).toBeDefined();
  await page.getByRole("button", { name: "Sign out of all devices" }).click();
  await page.getByRole("button", { name: "Sign out of all", exact: true }).click();
  await expect(page).toHaveURL(/\/login\/provider$/);
  await expectSignedOut(page, { cookieCleared: false });
  await page.goto("/workspace/overview");
  await expect(page).toHaveURL(/\/login\//); // the old cookie no longer resumes a session
});

test("paging contract: the API sends X-Next-Cursor and the cursor leads to a different page", async () => {
  const api = await pwRequest.newContext({ baseURL: apiURL });
  const session = await login(api, DEMO());
  expect(session).not.toBeNull();
  const headers = { authorization: `Bearer ${session!.accessToken}`, "x-tenant-id": session!.user.tenantId };
  const first = await api.get("/api/v1/services/marketplace?limit=1", { headers });
  expect(first.ok()).toBe(true);
  const cursor = first.headers()["x-next-cursor"];
  expect(cursor, "more than one active service is seeded").toBeTruthy();
  const second = await api.get(`/api/v1/services/marketplace?limit=1&cursor=${encodeURIComponent(cursor!)}`, { headers });
  expect((await second.json())[0].id).not.toBe((await first.json())[0].id);
});
