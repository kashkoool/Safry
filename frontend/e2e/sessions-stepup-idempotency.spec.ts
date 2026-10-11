import { expect, test, type Page, type Route } from "@playwright/test";
import { seedSessionHint, useEnglish } from "./helpers";

// Fully mocked API (no backend needed). Covers step-up, the Idempotency-Key header and the sessions screen.
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function seed(page: Page, user: Record<string, unknown>) {
  await useEnglish(page);
  await seedSessionHint(page); // the access token is memory-only: the page resumes through /auth/refresh (cookie) on load
  return { accessToken: "AT", expiresIn: 900, idleTimeoutSeconds: 900, user };
}
const traveler = { userId: "u1", tenantId: "t1", membershipId: "m1", email: "t@example.test", roles: ["traveler"], permissions: ["tenant.read", "catalog.service.read", "booking.create", "booking.read"] };
const def = { label: "L", unit: "u", dateLabel: "D", fields: [{ key: "x", label: "X" }] };
const service = {
  id: "s1", title: "Test hotel", description: "d", category: "HOTEL", city: "Riyadh", priceCents: 10000, currency: "SAR",
  status: "ACTIVE", capacity: 10, details: {}, components: [],
  organization: { id: "o1", name: "Org", type: "HOTEL", status: "ACTIVE" }
};
const workspace = {
  organization: null,
  providerDefinitions: Object.fromEntries(
    ["UMRAH_COMPANY", "TRAVEL_COMPANY", "HOTEL", "TRANSPORT", "RESTAURANT", "VISA"].map((k) => [k, { label: k, categories: [], role: "r" }])
  ),
  serviceDefinitions: Object.fromEntries(
    ["FLIGHT", "HOTEL", "TRANSPORT", "TOUR", "OTHER", "UMRAH", "PACKAGE", "RESTAURANT", "VISA", "VISIT"].map((k) => [k, def])
  )
};
const tenant = { id: "t1", code: "safry", name: "Safry", status: "ACTIVE", settings: {}, createdAt: "", updatedAt: "" };

test("booking sends one Idempotency-Key per action and reuses it on retry", async ({ page }) => {
  const session = await seed(page, traveler);
  const keys: Array<string | undefined> = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/bookings" && route.request().method() === "POST") {
      keys.push(route.request().headers()["idempotency-key"]);
      // first attempt: server error (response lost); second: created
      return keys.length === 1 ? json(route, 500, { message: "boom" }) : json(route, 201, { id: "b1" });
    }
    if (path === "/auth/refresh") return json(route, 200, session);
    if (path === "/auth/me") return json(route, 200, traveler);
    if (path === "/providers/workspace") return json(route, 200, workspace);
    if (path === "/tenants/current") return json(route, 200, tenant);
    if (path === "/services/marketplace" || path === "/services") return json(route, 200, [service]);
    if (path === "/services/exchange-rates") return json(route, 200, { base: "SAR", rates: { SAR: 1 }, updatedAt: "" });
    return json(route, 200, []);
  });
  await page.goto("/workspace/marketplace");
  await page.getByRole("button", { name: /Book now/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input[type=date]").first().fill("2030-01-10");
  await dialog.locator("input[type=date]").nth(1).fill("2030-01-12");
  const submit = dialog.locator("form button.primary-button");
  await submit.click();
  await expect.poll(() => keys.length).toBe(1);
  await submit.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys[1]).toBe(keys[0]);
});

test("sessions screen lists own sessions and revokes one", async ({ page }) => {
  const session = await seed(page, traveler);
  let rows = [
    { id: "11111111-1111-4111-8111-111111111111", userAgent: "Firefox on Linux", ipAddress: "203.0.113.5", signedInAt: "2030-01-01T10:00:00Z", lastUsedAt: "2030-01-02T10:00:00Z", tenantId: "t1" },
    { id: "22222222-2222-4222-8222-222222222222", userAgent: "Safari on iOS", ipAddress: "203.0.113.9", signedInAt: "2030-01-01T11:00:00Z", lastUsedAt: null, tenantId: "t1" }
  ];
  const deleted: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const method = route.request().method();
    if (path === "/auth/sessions" && method === "GET") return json(route, 200, rows);
    if (path.startsWith("/auth/sessions/") && method === "DELETE") {
      const id = path.split("/").pop()!;
      deleted.push(id);
      rows = rows.filter((r) => r.id !== id);
      return route.fulfill({ status: 204 });
    }
    if (path === "/auth/refresh") return json(route, 200, session);
    if (path === "/auth/me") return json(route, 200, traveler);
    if (path === "/providers/workspace") return json(route, 200, workspace);
    if (path === "/tenants/current") return json(route, 200, tenant);
    return json(route, 200, []);
  });
  await page.goto("/workspace/profile");
  await expect(page.getByText("Firefox on Linux")).toBeVisible();
  await expect(page.getByText("Safari on iOS")).toBeVisible();
  await page.getByRole("button", { name: "End session" }).nth(1).click();
  await expect(page.getByText("Safari on iOS")).toHaveCount(0);
  expect(deleted).toEqual(["22222222-2222-4222-8222-222222222222"]);
  await expect(page.getByText("Firefox on Linux")).toBeVisible();
});

test("promoting an administrator asks for the current password and MFA code", async ({ page }) => {
  const admin = { ...traveler, userId: "adm", email: "a@example.test", isPlatformAdmin: true, roles: ["platform-admin"] };
  const session = await seed(page, admin);
  const patches: Array<Record<string, unknown>> = [];
  let refreshed = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const method = route.request().method();
    if (path === "/auth/refresh") { refreshed++; return json(route, 200, session); }
    if (path.startsWith("/platform/users/") && method === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      patches.push(body);
      if (body.currentPassword !== "right-password-123") return json(route, 401, { message: "bad" });
      return json(route, 200, { id: "u2" });
    }
    if (path === "/platform/overview") return json(route, 200, {});
    if (path === "/platform/references") return json(route, 200, { tenants: [], roles: [], permissions: [], organizations: [] });
    if (path.startsWith("/platform/records/")) {
      return json(route, 200, { items: [{ id: "u2", displayName: "Second User", email: "second@example.test", phone: "", status: "ACTIVE", isPlatformAdmin: false }], total: 1, page: 1, pageSize: 25 });
    }
    if (path === "/auth/me") return json(route, 200, admin);
    return json(route, 200, []);
  });
  await page.goto("/admin/accounts-permissions");
  await expect(page.getByText("Second User").first()).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Your current password")).toHaveCount(0); // only when granting
  await dialog.getByRole("checkbox").check();
  await dialog.getByLabel("Your current password").fill("wrong-password-123");
  await dialog.getByLabel(/Verification code/).fill("123456");
  await dialog.locator("form button.primary-button").click();
  await expect(dialog.getByText("The password or verification code is incorrect.")).toBeVisible();
  expect(patches[0]).toMatchObject({ isPlatformAdmin: true, currentPassword: "wrong-password-123", mfaCode: "123456" });
  expect(refreshed).toBe(1); // only the resume on page load: a wrong step-up guess must not trigger a token rotation/replay
  expect(patches).toHaveLength(1);
  await expect(dialog.getByLabel("Your current password")).toHaveValue(""); // never kept around
  await dialog.getByLabel("Your current password").fill("right-password-123");
  await dialog.locator("form button.primary-button").click();
  await expect(dialog).toHaveCount(0);
  expect(patches[1]).toMatchObject({ currentPassword: "right-password-123" });
  expect(patches[1]).not.toHaveProperty("mfaCode");
});
