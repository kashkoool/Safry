import { expect, test, request as pwRequest } from "@playwright/test";
import { apiURL, expectSignedOut, expireAccessToken, refreshCookie, secret, signIn, TENANT, useEnglish } from "./helpers";
import { totp } from "./totp";

const DEMO = () => secret("E2E_DEMO_PASSWORD");
const COOKIE_NAME = process.env.E2E_COOKIE_NAME ?? "safry_rt"; // "__Secure-safry_rt" when the API runs with NODE_ENV=production


// Against the nginx image (E2E_BASE_URL on the container) the strict CSP is live: any violation fails the test.
const violations = new WeakMap<object, string[]>();
test.beforeEach(async ({ page }) => {
  await useEnglish(page);
  const list: string[] = [];
  violations.set(page, list);
  page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) list.push(message.text()); });
  page.on("pageerror", (error) => { if (/Content Security Policy/i.test(error.message)) list.push(error.message); });
});
test.afterEach(async ({ page }) => { expect(violations.get(page) ?? []).toEqual([]); });

test.describe("login per portal", () => {
  const cases = [
    { portal: "customer" as const, email: "traveler@safry.local", password: DEMO },
    { portal: "provider" as const, email: "provider@safry.local", password: DEMO },
    { portal: "admin" as const, email: "admin@safry.local", password: () => secret("E2E_ADMIN_PASSWORD") }
  ];
  for (const item of cases) {
    test(`${item.portal} portal signs in and reaches the workspace`, async ({ page }) => {
      await signIn(page, item.portal, item.email, item.password());
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
      await expect(page).not.toHaveURL(/\/login\//);
    });
  }

  test("wrong password shows an error and stores nothing", async ({ page }) => {
    await signIn(page, "customer", "traveler@safry.local", "definitely-wrong-password");
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("safry.hasSession"))).toBeNull();
    expect(await refreshCookie(page)).toBeUndefined();
  });
});

test("the refresh token is an HttpOnly cookie; no web storage or script-visible cookie holds a credential; a reload resumes the session", async ({ page }) => {
  await signIn(page, "customer", "traveler@safry.local", DEMO());
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  const cookie = await refreshCookie(page);
  expect(cookie, "refresh cookie set by login").toBeDefined();
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api/v1/auth" });
  const visible = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
  expect(visible).not.toContain(cookie!.value);
  expect(visible).not.toMatch(/eyJ/); // no access token (JWT) in any web storage either: it is memory-only
  const resumed = page.waitForResponse((r) => r.url().endsWith("/auth/refresh") && r.request().method() === "POST");
  await page.reload();
  expect((await resumed).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  expect((await refreshCookie(page))!.value).not.toBe(cookie!.value); // rotated on resume
});

test("logout calls the server, clears client state and is back-button safe", async ({ page }) => {
  await signIn(page, "customer", "traveler@safry.local", DEMO());
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  const oldCookie = (await refreshCookie(page))!.value;
  const logoutCall = page.waitForResponse((r) => r.url().endsWith("/auth/logout") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign out" }).click();
  expect((await logoutCall).status()).toBeLessThan(300);
  await expectSignedOut(page);
  // The revoked refresh token must be dead on the server, not just forgotten by the browser.
  const api = await pwRequest.newContext();
  const reuse = await api.post(`${apiURL}/api/v1/auth/refresh`, {
    headers: { cookie: `${COOKIE_NAME}=${oldCookie}`, "x-requested-with": "XMLHttpRequest" }
  });
  expect(reuse.status()).toBe(401);
  // Back button: the protected page must not render again.
  await page.goBack().catch(() => undefined);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
});

test("sign-out in one tab ends the session in a second tab of the same user", async ({ context }) => {
  const first = await context.newPage();
  await useEnglish(first);
  await signIn(first, "customer", "traveler@safry.local", DEMO());
  await expect(first.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  // Tabs share the cookie: the second tab resumes the same login through it.
  const second = await context.newPage();
  await useEnglish(second);
  await second.goto("/workspace/overview");
  await expect(second.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  await first.getByRole("button", { name: "Sign out" }).click();
  await expectSignedOut(first);
  await expect(second.getByRole("button", { name: "Sign out" })).toHaveCount(0, { timeout: 10_000 });
});

test("language switch flips direction", async ({ page }) => {
  await page.goto("/login/customer");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await page.getByRole("button", { name: "التبديل إلى العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await page.getByRole("button", { name: "Switch to English" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("traveler creates a booking from the marketplace", async ({ page }) => {
  await signIn(page, "customer", "traveler@safry.local", DEMO());
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  await page.goto("/workspace/marketplace");
  const book = page.getByRole("button", { name: /Book now/ }).first();
  await expect(book).toBeVisible({ timeout: 20_000 });
  await book.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const created = page.waitForResponse((r) => /\/bookings$/.test(r.url()) && r.request().method() === "POST");
  await dialog.locator("form .primary-button").click();
  expect((await created).status()).toBe(201);
  await page.goto("/workspace/bookings");
  await expect(page.locator(".booking-row").first()).toBeVisible({ timeout: 20_000 });
});

test("session expiry: rejected access and refresh tokens send the user to sign in", async ({ page }) => {
  await signIn(page, "customer", "traveler@safry.local", DEMO());
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "expired" }) }));
  await page.getByRole("button", { name: /Refresh/ }).click();
  await expect(page).toHaveURL(/\/login\/customer\?expired=1/, { timeout: 15_000 });
  await expectSignedOut(page, { cookieCleared: false }); // every API answer is mocked 401 here, so the server never gets to clear the cookie
});

test("expired access token: logout still revokes the server session", async ({ page }) => {
  await signIn(page, "customer", "traveler@safry.local", DEMO());
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  const original = (await refreshCookie(page))!.value;
  await expireAccessToken(page);
  const statuses: number[] = [];
  page.on("response", (r) => { if (/\/auth\/(logout|refresh)$/.test(r.url())) statuses.push(r.status()); });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expectSignedOut(page);
  // The API logout needs only the refresh token, so it succeeds although the access token is dead.
  expect(statuses).toEqual([204]);
  const api = await pwRequest.newContext();
  const replay = await api.post(`${apiURL}/api/v1/auth/refresh`, { headers: { cookie: `${COOKIE_NAME}=${original}`, "x-requested-with": "XMLHttpRequest" } });
  expect(replay.status()).toBe(401);
});

test("many parallel 401s trigger exactly one refresh and the user stays signed in", async ({ page }) => {
  await signIn(page, "customer", "traveler@safry.local", DEMO());
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  await expireAccessToken(page);
  let refreshes = 0;
  page.on("request", (r) => { if (r.url().endsWith("/auth/refresh")) refreshes += 1; });
  await page.getByRole("button", { name: /Refresh/ }).click(); // the dashboard reloads several resources at once, all with the dead token
  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(1500);
  expect(refreshes).toBe(1);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login\//);
});

test("two tabs sharing one cookie both survive an access-token expiry at the same instant (rotation race)", async ({ context }) => {
  const first = await context.newPage();
  await useEnglish(first);
  await signIn(first, "customer", "traveler@safry.local", DEMO());
  await expect(first.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  const second = await context.newPage();
  await useEnglish(second);
  await second.goto("/workspace/overview");
  await expect(second.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  await expireAccessToken(first);
  await expireAccessToken(second);
  const statuses: number[] = [];
  for (const tab of [first, second]) tab.on("response", (r) => { if (r.url().endsWith("/auth/refresh")) statuses.push(r.status()); });
  await Promise.all([first.getByRole("button", { name: /Refresh/ }).click(), second.getByRole("button", { name: /Refresh/ }).click()]);
  await first.waitForTimeout(3000);
  await expect(first.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(second.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(2);
  expect(await refreshCookie(first)).toBeDefined(); // the family is alive: nobody was signed out by the race
});

test("server error details never reach the screen", async ({ page }) => {
  await signIn(page, "customer", "traveler@safry.local", DEMO());
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  await page.route("**/api/v1/services**", (route) => route.fulfill({
    status: 500, contentType: "application/json",
    body: JSON.stringify({ message: "PrismaClientKnownRequestError: SELECT * FROM users at /app/node_modules/x.js:10" })
  }));
  await page.goto("/workspace/marketplace");
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 20_000 });
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/Prisma|SELECT|node_modules/);
});

test("a failed activity ping does not sign the user out", async ({ page }) => {
  await signIn(page, "customer", "traveler@safry.local", DEMO());
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  await page.route("**/api/v1/auth/activity", (route) => route.abort());
  await page.mouse.click(300, 300);
  await page.waitForTimeout(1500);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test.describe("MFA login", () => {
  // Isolated user: enabling MFA must not affect the other journeys. MFA is turned off again at the end.
  const email = "visa@safry.local";
  let mfaSecret = "";
  let recovery: string[] = [];

  test.beforeAll(async () => {
    const api = await pwRequest.newContext({ baseURL: apiURL });
    const login = await api.post("/api/v1/auth/login", { data: { email, password: DEMO(), tenantCode: TENANT, portal: "provider" } });
    const session = await login.json();
    expect(session.accessToken, `${email} must not already have MFA enabled`).toBeTruthy();
    const headers = { authorization: `Bearer ${session.accessToken}`, "x-tenant-id": session.user.tenantId };
    const setup = await (await api.post("/api/v1/auth/mfa/setup", { headers, data: { password: DEMO() } })).json();
    mfaSecret = setup.secret;
    const enabled = await api.post("/api/v1/auth/mfa/enable", { headers, data: { code: totp(mfaSecret) } });
    expect(enabled.status()).toBe(200);
    recovery = (await enabled.json()).recoveryCodes;
  });

  test.afterAll(async () => {
    const api = await pwRequest.newContext({ baseURL: apiURL });
    const login = await (await api.post("/api/v1/auth/login", { data: { email, password: DEMO(), tenantCode: TENANT, portal: "provider" } })).json();
    if (!login.mfaToken) return;
    const verified = await (await api.post("/api/v1/auth/mfa/verify", { data: { mfaToken: login.mfaToken, code: recovery[1]! } })).json();
    await api.post("/api/v1/auth/mfa/disable", {
      headers: { authorization: `Bearer ${verified.accessToken}`, "x-tenant-id": verified.user.tenantId },
      data: { password: DEMO(), code: recovery[2]! }
    });
  });

  test("password alone stores no session; a valid TOTP completes sign-in", async ({ page }) => {
    await signIn(page, "provider", email, DEMO());
    await expect(page.getByLabel("Verification code")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("safry.hasSession"))).toBeNull();
    expect(await refreshCookie(page)).toBeUndefined(); // a password alone issues no cookie
    await page.getByLabel("Verification code").fill(totp(mfaSecret, 1));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  });

  test("a wrong code returns to the password step and stores no session", async ({ page }) => {
    await signIn(page, "provider", email, DEMO());
    await page.getByLabel("Verification code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByLabel("Email address")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("safry.hasSession"))).toBeNull();
    expect(await refreshCookie(page)).toBeUndefined();
  });

  test("a recovery code completes sign-in", async ({ page }) => {
    await signIn(page, "provider", email, DEMO());
    await page.getByLabel("Verification code").fill(recovery[0]!);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  });
});
