import { expect, test, type Page } from "@playwright/test";
import { json, mockApi, platformAdmin, traveler } from "./mock-api";

// Visual regression: fully mocked API, fixed data, fixed viewport (1280x800). Not part of the normal suite:
// run with E2E_PROJECTS=visual (see docs/CI.md, "Visual regression"). Snapshots are generated on Linux only.
const profile = { id: "u-trav", email: "trav@example.test", displayName: "Test Traveler", phone: null, locale: "en-US", status: "ACTIVE", emailVerifiedAt: "2030-01-01T00:00:00.000Z", mfaEnabledAt: null, createdAt: "2030-01-01T00:00:00.000Z" };
const account = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${id}@example.test`, displayName: name, status: "ACTIVE", isPlatformAdmin: false, deletedAt: null,
  createdAt: "2030-01-01T00:00:00.000Z", memberships: [], lockedUntil: null, emailVerifiedAt: "2030-01-01T00:00:00.000Z", ...extra
});

async function arabic(page: Page) {
  await page.addInitScript(() => { try { window.localStorage.setItem("safry.language", "ar"); } catch { /* ignore */ } });
}
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
}

const accountsHandler = async (call: { path: string }, route: import("@playwright/test").Route) => {
  if (call.path === "/platform/overview") { await json(route, 200, {}); return true; }
  if (call.path === "/platform/references") { await json(route, 200, { tenants: [], roles: [], permissions: [], organizations: [] }); return true; }
  if (call.path === "/platform/records/users") {
    const items = [
      account("locked1", "Locked Lena", { lockedUntil: "2099-01-01T00:00:00.000Z" }),
      account("unver1", "Unverified Umar", { emailVerifiedAt: null }),
      account("fine1", "Fine Fatima")
    ];
    await json(route, 200, { items, total: 3, page: 1, pageSize: 30 });
    return true;
  }
  return false;
};
const accountHandler = async (call: { path: string }, route: import("@playwright/test").Route) => {
  if (call.path === "/users/me") { await json(route, 200, profile); return true; }
  if (call.path === "/auth/sessions") {
    await json(route, 200, [{ id: "s1", userAgent: "Browser A", ipAddress: "203.0.113.5", signedInAt: "2030-01-01T10:00:00.000Z", lastUsedAt: "2030-01-01T11:00:00.000Z", tenantId: "t1" }]);
    return true;
  }
  return false;
};

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2030-06-01T10:00:00Z"));
});

for (const lang of ["en", "ar"] as const) {
  test.describe(`language ${lang}`, () => {
    test(`login page (${lang})`, async ({ page }) => {
      await mockApi(page, traveler, () => false);
      if (lang === "ar") await arabic(page);
      await page.route("**/api/v1/auth/refresh", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Unauthorized" }) }));
      await page.goto("/login/customer");
      await settle(page);
      await expect(page).toHaveScreenshot(`login-${lang}.png`);
    });

    test(`account profile (${lang})`, async ({ page }) => {
      await mockApi(page, traveler, accountHandler);
      if (lang === "ar") await arabic(page);
      await page.goto("/account/profile");
      await expect(page.locator("main h1")).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`account-${lang}.png`);
    });

    test(`platform accounts list (${lang})`, async ({ page }) => {
      await mockApi(page, platformAdmin, accountsHandler);
      if (lang === "ar") await arabic(page);
      await page.goto("/admin/accounts-permissions");
      await expect(page.getByRole("table").first()).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`platform-accounts-${lang}.png`, { fullPage: true });
    });
  });
}
