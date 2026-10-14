import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { json, mockApi, tenantAdmin } from "./mock-api";

// Fully mocked API: the permission audit viewer.
const events = Array.from({ length: 30 }, (_, i) => ({
  id: `e${i}`,
  action: i % 3 === 0 ? "identity.role.create" : i % 3 === 1 ? "identity.membership.roles.update" : "identity.role.delete",
  entityType: "role", entityId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  actorUserId: i % 2 === 0 ? tenantAdmin.userId : "u-other",
  metadata: { code: `role-${i}` },
  occurredAt: new Date(Date.UTC(2030, 0, 30 - i, 12)).toISOString()
}));

test("shows a readable, filterable audit trail with an honest cap", async ({ page }) => {
  const { calls } = await mockApi(page, tenantAdmin, async (call, route) => {
    if (call.path === "/access/audit") { await json(route, 200, events); return true; }
    if (call.path === "/tenants/members") {
      await json(route, 200, [{ id: "m1", status: "ACTIVE", awaitingOwnerConsent: false, createdAt: "2030-01-01T00:00:00.000Z", user: { id: tenantAdmin.userId, email: "a@example.test", displayName: "Self Admin", status: "ACTIVE" }, roles: [] }]);
      return true;
    }
    return false;
  });
  await page.goto("/workspace/access/audit");
  const table = page.getByRole("table", { name: "Permission change history" });
  await expect(table.getByRole("row")).toHaveCount(26); // header + first 25
  expect(calls.some((c) => c.path === "/access/audit" && c.search === "?limit=100")).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "Showing:" })).toContainText("25 / 30");
  await expect(table.getByText("Create role").first()).toBeVisible(); // label, never the raw action code
  await expect(table.getByText("identity.role.create")).toHaveCount(0);
  await expect(table.getByText("Self Admin").first()).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(table.getByRole("row")).toHaveCount(31);

  await page.getByLabel("Action").selectOption("identity.role.delete");
  await expect(table.getByRole("row")).toHaveCount(11);
  await page.getByLabel("Action").selectOption("");
  await page.getByLabel("Actor").selectOption("u-other");
  await expect(page.getByRole("status").filter({ hasText: "Showing:" })).toContainText("15");
  await page.getByLabel("Actor").selectOption("");
  await page.getByLabel("From date").fill("2030-01-28");
  await expect(table.getByRole("row")).toHaveCount(4); // Jan 28, 29, 30
  await page.getByLabel("To date").fill("2030-01-29");
  await expect(table.getByRole("row")).toHaveCount(3);

  await page.getByLabel("Records to load").selectOption("200");
  await expect.poll(() => calls.some((c) => c.path === "/access/audit" && c.search === "?limit=200")).toBe(true);
  await expect(page.getByText("Filters apply to the loaded records")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});

test("shows empty and error states", async ({ page }) => {
  let fail = true;
  await mockApi(page, tenantAdmin, async (call, route) => {
    if (call.path === "/access/audit") { await (fail ? json(route, 403, { message: "Forbidden resource" }) : json(route, 200, [])); return true; }
    return false;
  });
  await page.goto("/workspace/access/audit");
  await expect(page.getByRole("alert").filter({ hasText: "You do not have permission" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("No matching events.")).toBeVisible();
});
