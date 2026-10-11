import { expect, test, type Page, type Route } from "@playwright/test";
import { seedSessionHint, useEnglish } from "./helpers";

// Fully mocked API (no backend needed). Step-up on tenant-admin grants and admin-target state changes.
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const CORRECT = "right-password-123";
const WRONG = "wrong-password-123";
const NO_STEP_UP = new Set(["/platform/users/u3/state", "/platform/memberships/m3/access"]);
const admin = { userId: "adm", tenantId: "t1", membershipId: "m1", email: "a@example.test", isPlatformAdmin: true, roles: ["platform-admin"], permissions: [] };
const roles = [
  { id: "r-admin", code: "tenant-admin", name: "Tenant admin", tenantId: "t1", permissions: [] },
  { id: "r-trav", code: "traveler", name: "Traveler", tenantId: "t1", permissions: [] }
];
const references = { tenants: [{ id: "t1", name: "Safry", code: "safry" }], roles, permissions: [], organizations: [] };
const member = (id: string, roleId: string) => ({
  id, tenantId: "t1", status: "ACTIVE", providerOrganizationId: null, permissionOverrides: {},
  tenant: { name: "Safry", code: "safry" }, organization: null, roles: [{ role: roles.find((r) => r.id === roleId)! }]
});

async function setup(page: Page, users: unknown[]) {
  await useEnglish(page);
  const session = { accessToken: "AT", expiresIn: 900, idleTimeoutSeconds: 900, user: admin };
  await seedSessionHint(page); // memory-only access token: the page resumes through /auth/refresh (cookie) on load
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const counters = { refresh: 0 };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const method = route.request().method();
    if (path === "/auth/refresh") { counters.refresh++; return json(route, 200, session); }
    if (path === "/auth/me") return json(route, 200, admin);
    if (path === "/platform/overview") return json(route, 200, {});
    if (path === "/platform/references") return json(route, 200, references);
    if (path.startsWith("/platform/records/")) return json(route, 200, { items: users, total: users.length, page: 1, pageSize: 25 });
    if (method !== "GET" && path.startsWith("/platform/")) {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      calls.push({ method, path, body });
      // Like the API: a step-up route answers 401 unless the right password is present; others never need it.
      return NO_STEP_UP.has(path) || body.currentPassword === CORRECT ? json(route, 200, { id: "x" }) : json(route, 401, { message: "bad" });
    }
    return json(route, 200, []);
  });
  return { calls, counters };
}
const wrongText = "The password or verification code is incorrect.";

test("creating a tenant-admin account asks for step-up; a traveler does not", async ({ page }) => {
  const { calls, counters } = await setup(page, []);
  await page.goto("/admin/accounts-permissions");
  await page.getByRole("button", { name: "New account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input").first().fill("New Person");
  await dialog.locator("input[type=email]").fill("new@example.test");
  await dialog.locator("input[type=password]").fill("initial-password-123");
  await dialog.locator("select").nth(1).selectOption("r-trav");
  await expect(dialog.getByLabel("Your current password")).toHaveCount(0);
  await dialog.locator("select").nth(1).selectOption("r-admin");
  await dialog.getByLabel("Your current password").fill(WRONG);
  await dialog.getByLabel(/Verification code/).fill("123456");
  await dialog.locator("form button.primary-button").click();
  await expect(dialog.getByText(wrongText)).toBeVisible();
  expect(calls[0]).toMatchObject({ method: "POST", path: "/platform/users", body: { roleId: "r-admin", currentPassword: WRONG, mfaCode: "123456" } });
  expect(counters.refresh).toBe(1); // only the resume on page load; a wrong step-up guess must not trigger a token rotation/replay
  await expect(dialog.getByLabel("Your current password")).toHaveValue(""); // never kept around
  await dialog.getByLabel("Your current password").fill(CORRECT);
  await dialog.locator("form button.primary-button").click();
  await expect(dialog).toHaveCount(0);
  expect(calls[1]!.body).toMatchObject({ currentPassword: CORRECT });
  expect(calls[1]!.body).not.toHaveProperty("mfaCode");
});

test("granting tenant-admin on a membership needs step-up; re-saving an admin does not", async ({ page }) => {
  const { calls, counters } = await setup(page, [
    { id: "u2", displayName: "Second User", email: "second@example.test", status: "ACTIVE", isPlatformAdmin: false, memberships: [member("m2", "r-trav")] },
    { id: "u3", displayName: "Third Admin", email: "third@example.test", status: "ACTIVE", isPlatformAdmin: false, memberships: [member("m3", "r-admin")] }
  ]);
  await page.goto("/admin/accounts-permissions");
  const row = (name: string) => page.getByRole("row", { name: new RegExp(name) });
  const dialog = page.getByRole("dialog");
  await row("Second User").getByText("More").click();
  await row("Second User").getByRole("button", { name: "Roles and permissions" }).click();
  await expect(dialog.getByLabel("Your current password")).toHaveCount(0);
  await dialog.getByLabel("Tenant admin").check();
  await dialog.getByLabel("Your current password").fill(WRONG);
  await dialog.locator("form button.primary-button").click();
  await expect(dialog.getByText(wrongText)).toBeVisible();
  expect(calls[0]).toMatchObject({ method: "PATCH", path: "/platform/memberships/m2/access", body: { currentPassword: WRONG } });
  expect(counters.refresh).toBe(1);
  await expect(dialog.getByLabel("Your current password")).toHaveValue("");
  await dialog.getByLabel("Your current password").fill(CORRECT);
  await dialog.locator("form button.primary-button").click();
  await expect(dialog).toHaveCount(0);
  expect(calls).toHaveLength(2);
  // An account that already holds tenant-admin is re-saved without any extra prompt or credentials.
  await row("Third Admin").getByText("More").click();
  await row("Third Admin").getByRole("button", { name: "Roles and permissions" }).click();
  await expect(dialog.getByLabel("Your current password")).toHaveCount(0);
  await dialog.locator("form button.primary-button").click();
  await expect(dialog).toHaveCount(0);
  expect(calls[2]!.path).toBe("/platform/memberships/m3/access");
  expect(calls[2]!.body).not.toHaveProperty("currentPassword");
});

test("changing the state of a platform administrator needs step-up; an ordinary account does not", async ({ page }) => {
  const { calls, counters } = await setup(page, [
    { id: "u2", displayName: "Other Admin", email: "oadmin@example.test", status: "ACTIVE", isPlatformAdmin: true, memberships: [] },
    { id: "u3", displayName: "Plain User", email: "plain@example.test", status: "ACTIVE", isPlatformAdmin: false, memberships: [] }
  ]);
  await page.goto("/admin/accounts-permissions");
  const row = (name: string) => page.getByRole("row", { name: new RegExp(name) });
  const dialog = page.getByRole("dialog");
  await row("Other Admin").getByText("More").click();
  await row("Other Admin").locator(".admin-action-menu__content button.danger").first().click(); // close account
  await dialog.locator("textarea").fill("security incident");
  await dialog.getByLabel("Your current password").fill(WRONG);
  await dialog.getByLabel(/Verification code/).fill("654321");
  await dialog.locator("form button.primary-button").click();
  await expect(dialog.getByText(wrongText)).toBeVisible();
  expect(calls[0]).toMatchObject({ method: "POST", path: "/platform/users/u2/state", body: { action: "DISABLED", currentPassword: WRONG, mfaCode: "654321" } });
  expect(counters.refresh).toBe(1);
  await expect(dialog.getByLabel("Your current password")).toHaveValue("");
  await dialog.getByLabel("Your current password").fill(CORRECT);
  await dialog.locator("form button.primary-button").click();
  await expect(dialog).toHaveCount(0);
  expect(calls[1]!.body).toMatchObject({ currentPassword: CORRECT });
  await row("Plain User").getByText("More").click();
  await row("Plain User").locator(".admin-action-menu__content button.danger").first().click();
  await expect(dialog.getByLabel("Your current password")).toHaveCount(0);
  await dialog.locator("textarea").fill("routine support action");
  await dialog.locator("form button.primary-button").click();
  await expect(dialog).toHaveCount(0);
  expect(calls[2]!.path).toBe("/platform/users/u3/state");
  expect(calls[2]!.body).not.toHaveProperty("currentPassword");
});
