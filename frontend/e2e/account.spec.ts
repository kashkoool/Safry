import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { seedSessionHint, useEnglish } from "./helpers";

// Fully mocked API (no backend needed): the account area (profile, password, two-factor, sign-ins).
const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
const traveler = { userId: "u1", tenantId: "t1", membershipId: "m1", email: "t@example.test", roles: ["traveler"], permissions: ["tenant.read", "catalog.service.read", "booking.create", "booking.read"] };
const session = { accessToken: "AT", expiresIn: 900, idleTimeoutSeconds: 900, user: traveler };
const profile = { id: "u1", email: "t@example.test", displayName: "Test Traveler", phone: null, locale: "en-US", status: "ACTIVE", emailVerifiedAt: null, mfaEnabledAt: null, createdAt: "2030-01-01T00:00:00.000Z" };
const SECRET = "JBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/Safry:t%40example.test?secret=${SECRET}&issuer=Safry`;
const CODES = ["AAAA-1111-BBBB-2222", "CCCC-3333-DDDD-4444"];

interface Mock {
  calls: Array<{ method: string; path: string; body: Record<string, unknown> }>;
  refreshes: () => number;
  mfa: { enabled: boolean; pendingSetup: boolean; recoveryCodesRemaining: number; recoveryCodesRegenerationRequired: boolean };
  handlers: Map<string, (route: Route, body: Record<string, unknown>) => Promise<void> | void>;
}

async function setup(page: Page): Promise<Mock> {
  await useEnglish(page);
  await seedSessionHint(page);
  let refreshes = 0;
  const mock: Mock = {
    calls: [],
    refreshes: () => refreshes,
    mfa: { enabled: false, pendingSetup: false, recoveryCodesRemaining: 0, recoveryCodesRegenerationRequired: false },
    handlers: new Map()
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const body = (request.method() === "GET" ? {} : request.postDataJSON() ?? {}) as Record<string, unknown>;
    if (path === "/auth/refresh") { refreshes += 1; return json(route, 200, session); }
    if (request.method() !== "GET" && path !== "/auth/activity") mock.calls.push({ method: request.method(), path, body });
    const handler = mock.handlers.get(`${request.method()} ${path}`);
    if (handler) return handler(route, body);
    if (path === "/auth/mfa") return json(route, 200, mock.mfa);
    if (path === "/users/me") return json(route, 200, profile);
    if (path === "/auth/sessions") return json(route, 200, [
      { id: "s1", userAgent: "Browser A", ipAddress: "203.0.113.5", signedInAt: "2030-01-01T10:00:00.000Z", lastUsedAt: "2030-01-01T11:00:00.000Z", tenantId: "t1" }
    ]);
    return json(route, 200, []);
  });
  return mock;
}

test.describe("profile", () => {
  test("loads the profile, saves only the changed fields and reports success", async ({ page }) => {
    const mock = await setup(page);
    mock.handlers.set("PATCH /users/me", (route, body) => json(route, 200, { ...profile, ...body }));
    await page.goto("/account/profile");
    await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeVisible();
    const name = page.getByLabel("Display name");
    await expect(name).toHaveValue("Test Traveler");
    await expect(page.getByLabel("E-mail address")).toHaveAttribute("readonly", "");
    await expect(page.getByText("Your e-mail address is not verified yet")).toBeVisible();
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled(); // nothing changed yet
    await name.fill("New Name");
    await page.getByLabel("Phone number (optional)").fill("+966 50 123 4567");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByRole("status").filter({ hasText: "Your profile was saved." })).toBeVisible();
    expect(mock.calls).toEqual([{ method: "PATCH", path: "/users/me", body: { displayName: "New Name", phone: "+966 50 123 4567" } }]);
    await expect(save).toBeDisabled();
  });

  test("a phone number that breaks the server rule is stopped in the browser, a server refusal is shown", async ({ page }) => {
    const mock = await setup(page);
    mock.handlers.set("PATCH /users/me", (route) => json(route, 400, { message: "رقم الهاتف غير صالح" }));
    await page.goto("/account/profile");
    const phone = page.getByLabel("Phone number (optional)");
    await phone.fill("abc");
    await page.getByRole("button", { name: "Save changes" }).click();
    expect(mock.calls).toHaveLength(0);
    expect(await phone.evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(true);
    await phone.fill("123456");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled(); // not stuck busy: the user can retry
  });

  test("choosing another language saves the locale and switches the page", async ({ page }) => {
    const mock = await setup(page);
    mock.handlers.set("PATCH /users/me", (route, body) => json(route, 200, { ...profile, ...body }));
    await page.goto("/account/profile");
    await page.getByLabel("Interface language").selectOption("ar-SA");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    expect(mock.calls[0]?.body).toEqual({ locale: "ar-SA" });
  });

  test("a failed load can be retried", async ({ page }) => {
    const mock = await setup(page);
    let failures = 1;
    mock.handlers.set("GET /users/me", (route) => failures-- > 0 ? json(route, 500, { message: "boom" }) : json(route, 200, profile));
    await page.goto("/account/profile");
    await expect(page.getByRole("alert")).toContainText("Something went wrong on our side");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByLabel("Display name")).toHaveValue("Test Traveler");
  });

  test("has no serious accessibility violations", async ({ page }) => {
    await setup(page);
    await page.goto("/account/profile");
    await expect(page.getByLabel("Display name")).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
});

const passwordPanel = (page: Page) => page.getByRole("article", { name: "Change password" });
const mfaPanel = (page: Page) => page.getByRole("article", { name: "Two-factor sign-in" });

test.describe("change password", () => {
  const open = async (page: Page) => {
    const mock = await setup(page);
    await page.goto("/account/security");
    await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
    return mock;
  };
  const fill = async (page: Page, current: string, next: string, confirm: string) => {
    await passwordPanel(page).getByLabel("Current password", { exact: true }).first().fill(current);
    await passwordPanel(page).getByLabel("New password", { exact: true }).fill(next);
    await passwordPanel(page).getByLabel("Confirm new password").fill(confirm);
  };

  test("inputs carry the right autocomplete hints", async ({ page }) => {
    await open(page);
    await expect(passwordPanel(page).getByLabel("Current password", { exact: true }).first()).toHaveAttribute("autocomplete", "current-password");
    await expect(passwordPanel(page).getByLabel("New password", { exact: true })).toHaveAttribute("autocomplete", "new-password");
    await expect(passwordPanel(page).getByLabel("Confirm new password")).toHaveAttribute("autocomplete", "new-password");
  });

  test("a mismatch or an unchanged password is explained next to the field and nothing is sent", async ({ page }) => {
    const mock = await open(page);
    await fill(page, "old-password-123", "new-password-4567", "new-password-0000");
    await passwordPanel(page).getByRole("button", { name: "Change password" }).click();
    const confirm = passwordPanel(page).getByLabel("Confirm new password");
    await expect(confirm).toHaveAttribute("aria-invalid", "true");
    await expect(passwordPanel(page).getByRole("alert").filter({ hasText: "does not match" })).toBeVisible();
    await expect(confirm).toHaveAttribute("aria-describedby", /.+/);
    await fill(page, "same-password-123", "same-password-123", "same-password-123");
    await passwordPanel(page).getByRole("button", { name: "Change password" }).click();
    await expect(passwordPanel(page).getByRole("alert").filter({ hasText: "must be different" })).toBeVisible();
    expect(mock.calls).toHaveLength(0);
  });

  test("a wrong current password is reported, is not replayed through a session refresh and clears every field", async ({ page }) => {
    const mock = await open(page);
    mock.handlers.set("POST /auth/password", (route) => json(route, 401, { message: "كلمة المرور الحالية غير صحيحة" }));
    const before = mock.refreshes();
    await fill(page, "wrong-password-1", "new-password-4567", "new-password-4567");
    await passwordPanel(page).getByRole("button", { name: "Change password" }).click();
    await expect(passwordPanel(page).getByRole("alert")).toHaveText("The current password is incorrect.");
    await expect(passwordPanel(page).getByLabel("New password", { exact: true })).toHaveValue("");
    await expect(passwordPanel(page).getByLabel("Confirm new password")).toHaveValue("");
    expect(mock.calls.filter((c) => c.path === "/auth/password")).toHaveLength(1);
    expect(mock.refreshes()).toBe(before);
  });

  test("success tells the user other devices were signed out and clears the fields", async ({ page }) => {
    const mock = await open(page);
    mock.handlers.set("POST /auth/password", (route) => route.fulfill({ status: 204 }));
    await fill(page, "old-password-123", "new-password-4567", "new-password-4567");
    await passwordPanel(page).getByRole("button", { name: "Change password" }).click();
    await expect(passwordPanel(page).getByRole("status").filter({ hasText: "other devices were signed out" })).toBeVisible();
    expect(mock.calls[0]).toEqual({ method: "POST", path: "/auth/password", body: { currentPassword: "old-password-123", newPassword: "new-password-4567" } });
    await expect(passwordPanel(page).getByLabel("New password", { exact: true })).toHaveValue("");
    const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    expect(stored).not.toContain("new-password-4567");
  });

  test("a throttled attempt shows how long to wait and the button comes back", async ({ page }) => {
    const mock = await open(page);
    mock.handlers.set("POST /auth/password", (route) => json(route, 429, { message: "ThrottlerException: Too Many Requests" }, { "retry-after": "2" }));
    await fill(page, "old-password-123", "new-password-4567", "new-password-4567");
    await passwordPanel(page).getByRole("button", { name: "Change password" }).click();
    await expect(passwordPanel(page).getByRole("alert")).toContainText("Too many attempts");
    await expect(passwordPanel(page).getByRole("button", { name: /Try again in \d s/ })).toBeDisabled();
    await expect(passwordPanel(page).getByRole("button", { name: "Change password" })).toBeEnabled({ timeout: 8000 });
  });
});

test.describe("two-factor sign-in", () => {
  test("turning it on: password, QR plus manual key, code, recovery codes shown once", async ({ page }) => {
    const mock = await setup(page);
    mock.handlers.set("POST /auth/mfa/setup", (route, body) =>
      body.password === "right-password-123" ? json(route, 200, { secret: SECRET, otpauthUri: URI }) : json(route, 401, { message: "كلمة المرور غير صحيحة" }));
    mock.handlers.set("POST /auth/mfa/enable", (route, body) => {
      if (body.code !== "123456") return json(route, 400, { message: "رمز التحقق غير صحيح" });
      mock.mfa = { enabled: true, pendingSetup: false, recoveryCodesRemaining: 2, recoveryCodesRegenerationRequired: false };
      return json(route, 200, { recoveryCodes: CODES });
    });
    await page.goto("/account/security");
    await expect(mfaPanel(page).getByText("Two-factor sign-in: off")).toBeVisible();
    await mfaPanel(page).getByRole("button", { name: "Turn on two-factor sign-in" }).click();

    const step1 = mfaPanel(page).getByRole("heading", { name: /Step 1 of 3/ });
    await expect(step1).toBeFocused(); // focus moves to the new step
    await mfaPanel(page).getByLabel("Current password").fill("wrong-password-1");
    await mfaPanel(page).getByRole("button", { name: "Continue" }).click();
    await expect(mfaPanel(page).getByRole("alert")).toHaveText("The password or verification code is incorrect.");
    await expect(mfaPanel(page).getByLabel("Current password")).toHaveValue("");
    await mfaPanel(page).getByLabel("Current password").fill("right-password-123");
    await mfaPanel(page).getByRole("button", { name: "Continue" }).click();

    await expect(mfaPanel(page).getByRole("heading", { name: /Step 2 of 3/ })).toBeVisible();
    const qr = mfaPanel(page).getByRole("img", { name: /QR code/ });
    await expect(qr).toBeVisible();
    expect(await qr.locator("path").getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
    const key = mfaPanel(page).getByText("JBSW Y3DP EHPK 3PXP");
    await expect(key).toBeVisible();
    await expect(key).toHaveAttribute("dir", "ltr");
    const code = mfaPanel(page).getByLabel("Authenticator app code (6 digits)");
    await expect(code).toHaveAttribute("autocomplete", "one-time-code");
    await code.fill("12ab34"); // letters are dropped as typed
    await expect(code).toHaveValue("1234");
    await code.fill("000000");
    await mfaPanel(page).getByRole("button", { name: "Turn on" }).click();
    await expect(mfaPanel(page).getByRole("alert")).toContainText("verification code");
    await expect(mfaPanel(page).getByRole("heading", { name: /Step 2 of 3/ })).toBeVisible(); // stays on the same step
    await code.fill("123456");
    await mfaPanel(page).getByRole("button", { name: "Turn on" }).click();

    await expect(mfaPanel(page).getByRole("heading", { name: /Step 3 of 3/ })).toBeVisible();
    for (const value of CODES) await expect(mfaPanel(page).getByText(value)).toBeVisible();
    const done = mfaPanel(page).getByRole("button", { name: "Done" });
    await expect(done).toBeDisabled();
    await mfaPanel(page).getByLabel("I have saved these codes").check();
    await done.click();
    await expect(mfaPanel(page).getByText("Two-factor sign-in: on")).toBeVisible();
    await expect(mfaPanel(page).getByText("Two-factor sign-in is on.")).toBeVisible();
    // the shared key and the recovery codes are gone from the page and never reached web storage
    await expect(mfaPanel(page).getByText(CODES[0]!)).toHaveCount(0);
    await expect(mfaPanel(page).getByText("JBSW")).toHaveCount(0);
    const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain("AAAA-1111");
    expect(mock.calls.map((c) => c.path)).toEqual(["/auth/mfa/setup", "/auth/mfa/setup", "/auth/mfa/enable", "/auth/mfa/enable"]);
  });

  test("an unfinished setup is offered again and cancelling drops the key", async ({ page }) => {
    const mock = await setup(page);
    mock.mfa.pendingSetup = true;
    mock.handlers.set("POST /auth/mfa/setup", (route) => json(route, 200, { secret: SECRET, otpauthUri: URI }));
    await page.goto("/account/security");
    await expect(mfaPanel(page).getByText("You started setting this up but did not finish")).toBeVisible();
    await mfaPanel(page).getByRole("button", { name: "Start setup again" }).click();
    await mfaPanel(page).getByLabel("Current password").fill("right-password-123");
    await mfaPanel(page).getByRole("button", { name: "Continue" }).click();
    await expect(mfaPanel(page).getByText("JBSW Y3DP EHPK 3PXP")).toBeVisible();
    await mfaPanel(page).getByRole("button", { name: "Cancel" }).click();
    await expect(mfaPanel(page).getByText("JBSW")).toHaveCount(0);
    await expect(mfaPanel(page).getByRole("button", { name: "Start setup again" })).toBeVisible();
  });

  test("when it is already on the server answers 409 and the message is shown", async ({ page }) => {
    const mock = await setup(page);
    mock.handlers.set("POST /auth/mfa/setup", (route) => json(route, 409, { message: "المصادقة متعددة العوامل مفعّلة بالفعل" }));
    await page.goto("/account/security");
    await mfaPanel(page).getByRole("button", { name: "Turn on two-factor sign-in" }).click();
    await mfaPanel(page).getByLabel("Current password").fill("right-password-123");
    await mfaPanel(page).getByRole("button", { name: "Continue" }).click();
    await expect(mfaPanel(page).getByRole("alert")).toContainText("already");
  });

  test("a throttled setup call disables the button with a visible countdown", async ({ page }) => {
    const mock = await setup(page);
    mock.handlers.set("POST /auth/mfa/setup", (route) => json(route, 429, { message: "ThrottlerException: Too Many Requests" }, { "retry-after": "2" }));
    await page.goto("/account/security");
    await mfaPanel(page).getByRole("button", { name: "Turn on two-factor sign-in" }).click();
    await mfaPanel(page).getByLabel("Current password").fill("right-password-123");
    await mfaPanel(page).getByRole("button", { name: "Continue" }).click();
    await expect(mfaPanel(page).getByRole("button", { name: /Try again in \d s/ })).toBeDisabled();
    await expect(mfaPanel(page).getByRole("button", { name: "Continue" })).toBeEnabled({ timeout: 8000 });
  });

  test("turning it off asks for password and code, reports a wrong one, then confirms and mentions other devices", async ({ page }) => {
    const mock = await setup(page);
    mock.mfa = { enabled: true, pendingSetup: false, recoveryCodesRemaining: 5, recoveryCodesRegenerationRequired: false };
    mock.handlers.set("POST /auth/mfa/disable", (route, body) => {
      if (body.code !== "654321") return json(route, 401, { message: "رمز التحقق غير صحيح" });
      mock.mfa = { ...mock.mfa, enabled: false };
      return route.fulfill({ status: 204 });
    });
    await page.goto("/account/security");
    await expect(mfaPanel(page).getByText("Recovery codes left:")).toContainText("5");
    await mfaPanel(page).getByRole("button", { name: "Turn off two-factor sign-in" }).click();
    await mfaPanel(page).getByLabel("Current password").fill("right-password-123");
    await mfaPanel(page).getByLabel("App code or recovery code").fill("111111");
    await mfaPanel(page).getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(mfaPanel(page).getByRole("alert")).toHaveText("The password or verification code is incorrect.");
    await expect(mfaPanel(page).getByLabel("App code or recovery code")).toHaveValue("");
    await mfaPanel(page).getByLabel("Current password").fill("right-password-123");
    await mfaPanel(page).getByLabel("App code or recovery code").fill("654321");
    await mfaPanel(page).getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(mfaPanel(page).getByRole("status").filter({ hasText: "Your other devices were signed out" })).toBeVisible();
    await expect(mfaPanel(page).getByText("Two-factor sign-in: off")).toBeVisible();
  });

  test("creating new recovery codes on demand shows them once", async ({ page }) => {
    const mock = await setup(page);
    mock.mfa = { enabled: true, pendingSetup: false, recoveryCodesRemaining: 1, recoveryCodesRegenerationRequired: false };
    mock.handlers.set("POST /auth/mfa/recovery-codes", (route) => json(route, 200, { recoveryCodes: CODES }));
    await page.goto("/account/security");
    await mfaPanel(page).getByRole("button", { name: "Create new recovery codes" }).click();
    await mfaPanel(page).getByLabel("Current password").fill("right-password-123");
    await mfaPanel(page).getByLabel("Authenticator app code (6 digits)").fill("123456");
    await mfaPanel(page).getByRole("button", { name: "Create codes" }).click();
    for (const value of CODES) await expect(mfaPanel(page).getByText(value)).toBeVisible();
    expect(mock.calls[0]).toMatchObject({ path: "/auth/mfa/recovery-codes", body: { password: "right-password-123", code: "123456" } });
    await mfaPanel(page).getByLabel("I have saved these codes").check();
    await mfaPanel(page).getByRole("button", { name: "Done" }).click();
    await expect(mfaPanel(page).getByText(CODES[0]!)).toHaveCount(0);
  });

  test("the security page has no serious accessibility violations", async ({ page }) => {
    const mock = await setup(page);
    mock.handlers.set("POST /auth/mfa/setup", (route) => json(route, 200, { secret: SECRET, otpauthUri: URI }));
    await page.goto("/account/security");
    await mfaPanel(page).getByRole("button", { name: "Turn on two-factor sign-in" }).click();
    await mfaPanel(page).getByLabel("Current password").fill("right-password-123");
    await mfaPanel(page).getByRole("button", { name: "Continue" }).click();
    await expect(mfaPanel(page).getByRole("img", { name: /QR code/ })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
});

test.describe("sign-ins", () => {
  test("lists sign-ins and 'sign out of all devices' needs a confirmation, then ends everything and leaves", async ({ page }) => {
    const mock = await setup(page);
    mock.handlers.set("POST /auth/logout-all", (route) => route.fulfill({ status: 204 }));
    await page.goto("/account/sessions");
    await expect(page.getByText("Browser A")).toBeVisible();
    await page.getByRole("button", { name: "Sign out of all devices" }).click();
    const dialog = page.getByRole("dialog", { name: "Sign out of all devices?" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(mock.calls.filter((c) => c.path === "/auth/logout-all")).toHaveLength(0); // Esc cancelled it
    await page.getByRole("button", { name: "Sign out of all devices" }).focus(); // focus returned to a sensible place
    await page.getByRole("button", { name: "Sign out of all devices" }).click();
    await page.getByRole("button", { name: "Sign out of all", exact: true }).click();
    await expect(page).toHaveURL(/\/login\/customer$/);
    expect(mock.calls.filter((c) => c.path === "/auth/logout-all")).toHaveLength(1);
    const stored = await page.evaluate(() => ({ hint: localStorage.getItem("safry.hasSession"), activity: sessionStorage.getItem("safry.lastActivityAt") }));
    expect(stored).toEqual({ hint: null, activity: null });
  });

  test("a failed 'sign out everywhere' keeps the user signed in and shows why", async ({ page }) => {
    const mock = await setup(page);
    mock.handlers.set("POST /auth/logout-all", (route) => json(route, 500, { message: "boom" }));
    await page.goto("/account/sessions");
    await page.getByRole("button", { name: "Sign out of all devices" }).click();
    await page.getByRole("button", { name: "Sign out of all", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Something went wrong on our side");
    await expect(page).toHaveURL(/\/account\/sessions$/);
    await expect(page.getByRole("button", { name: "Sign out of all", exact: true })).toBeEnabled();
  });
});

test("the account area is reachable from the workspace and unknown sections fall back to the profile", async ({ page }) => {
  await setup(page);
  await page.goto("/workspace/overview");
  await page.getByRole("link", { name: "Open account" }).click();
  await expect(page).toHaveURL(/\/account\/profile$/);
  await page.goto("/account/nothing");
  await expect(page).toHaveURL(/\/account\/profile$/);
  await expect(page.getByRole("navigation", { name: "Account sections" }).getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "page");
});
