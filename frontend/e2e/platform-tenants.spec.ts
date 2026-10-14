import { expect, test } from "@playwright/test";
import { json, mockApi, platformAdmin } from "./mock-api";

// Fully mocked API: platform workspaces tab (create, status, activity) and sign-in unlock.
const tenants = [
  { id: "t1", code: "safry", name: "Home Workspace", status: "ACTIVE", createdAt: "2030-01-01T00:00:00.000Z", _count: { memberships: 3, providers: 1, bookings: 0 } },
  { id: "t2", code: "acme", name: "Acme Travel", status: "ACTIVE", createdAt: "2030-01-02T00:00:00.000Z", _count: { memberships: 1, providers: 0, bookings: 0 } },
  { id: "t3", code: "old", name: "Old Co", status: "ARCHIVED", createdAt: "2030-01-03T00:00:00.000Z", _count: { memberships: 0, providers: 0, bookings: 0 } }
];
const handler = (record: { current: typeof tenants }) => async (call: { method: string; path: string; body: Record<string, unknown> }, route: import("@playwright/test").Route) => {
  if (call.path === "/platform/overview") { await json(route, 200, {}); return true; }
  if (call.path === "/platform/references") { await json(route, 200, { tenants: [], roles: [], permissions: [], organizations: [] }); return true; }
  if (call.path === "/platform/records/tenants") { await json(route, 200, { items: record.current, total: record.current.length, page: 1, pageSize: 30 }); return true; }
  if (call.method === "POST" && call.path === "/platform/tenants") { await json(route, 201, { id: "t9", code: call.body.code, name: call.body.name, status: "ACTIVE" }); return true; }
  if (call.method === "POST" && call.path === "/platform/tenants/t2/status") { await json(route, 200, { id: "t2", status: call.body.status }); return true; }
  if (call.path === "/platform/tenants/t2/activity") {
    await json(route, 200, [{ id: "a1", action: "platform.tenant.suspended", entityType: "tenant", entityId: "t2", actorUserId: "u-admin", metadata: { before: "ACTIVE", after: "SUSPENDED", reason: "Non payment" }, occurredAt: "2030-03-01T08:00:00.000Z" }]);
    return true;
  }
  if (call.method === "POST" && call.path === "/auth/login-throttle/unlock") { await route.fulfill({ status: 204 }); return true; }
  return false;
};

test("creates a workspace, changes status with a reason and reads the activity", async ({ page }) => {
  const record = { current: tenants };
  const { calls } = await mockApi(page, platformAdmin, handler(record));
  await page.goto("/admin/tenants");
  await expect(page.getByRole("link", { name: "My account" })).toHaveAttribute("href", "/account/profile");

  await page.getByRole("button", { name: "New workspace" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Workspace code").fill("Bad Code");
  await dialog.getByLabel("Workspace name").fill("Fresh Travel");
  await dialog.getByRole("button", { name: "Create" }).click();
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(0); // invalid code blocked in the browser
  await dialog.getByLabel("Workspace code").fill("fresh-travel");
  await dialog.getByLabel("Default currency").selectOption("EUR");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  expect(calls.find((c) => c.method === "POST")!.body).toEqual({ code: "fresh-travel", name: "Fresh Travel", settings: { currency: "EUR" } });

  const acme = page.getByRole("row", { name: /Acme Travel/ });
  await acme.getByRole("button", { name: "Change status" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("New status").selectOption("ARCHIVED");
  await dialog.getByLabel("Reason (required)").fill("Closed down");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled(); // archiving is final: needs the explicit acknowledgement
  await dialog.getByRole("checkbox", { name: /archiving is final/ }).check();
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls.find((c) => c.path === "/platform/tenants/t2/status")!.body).toEqual({ status: "ARCHIVED", reason: "Closed down" });

  await acme.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("dialog").getByText("Suspend workspace")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Non payment")).toBeVisible();
});

test("protects the own workspace and archived workspaces", async ({ page }) => {
  await mockApi(page, platformAdmin, handler({ current: tenants }));
  await page.goto("/admin/tenants");
  await page.getByRole("row", { name: /Home Workspace/ }).getByRole("button", { name: "Change status" }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByText("you cannot suspend or archive it")).toBeVisible();
  await expect(dialog.getByRole("option")).toHaveCount(0); // ACTIVE is already its status: nothing to choose
  await page.keyboard.press("Escape");
  await page.getByRole("row", { name: /Old Co/ }).getByRole("button", { name: "Change status" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByText("archived and its status cannot be changed")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
});

test("unlocks a blocked sign-in and shows the result", async ({ page }) => {
  const { calls } = await mockApi(page, platformAdmin, async (call, route) => {
    if (call.path.startsWith("/platform/records/")) { await json(route, 200, { items: [], total: 0, page: 1, pageSize: 30 }); return true; }
    return handler({ current: tenants })(call, route);
  });
  await page.goto("/admin/accounts-permissions");
  await page.getByRole("button", { name: "Unlock sign-in" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Account email").fill("blocked@example.test");
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Unlock requested for blocked@example.test" })).toBeVisible();
  expect(calls.find((c) => c.path === "/auth/login-throttle/unlock")!.body).toEqual({ email: "blocked@example.test" });
});
