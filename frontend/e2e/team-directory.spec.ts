import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { json, mockApi, tenantAdmin, traveler } from "./mock-api";

// Fully mocked API: the team directory (search, filters, status change, roles, history, protections).
const member = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id: `m-${id}`, status: "ACTIVE", awaitingOwnerConsent: false, jobTitle: null, createdAt: "2030-01-01T00:00:00.000Z",
  user: { id: `u-${id}`, email: `${id}@example.test`, displayName: name, phone: null, status: "ACTIVE" },
  roles: [{ role: { code: "traveler", name: "Traveler" } }], ...over
});
const rows = [
  member("admin", "Self Admin", { user: { id: tenantAdmin.userId, email: "admin@example.test", displayName: "Self Admin", phone: null, status: "ACTIVE" }, roles: [{ role: { code: "tenant-admin", name: "Tenant admin" } }] }),
  member("ali", "Ali Traveler"),
  member("invited", "Invited Person", { status: "INVITED", awaitingOwnerConsent: true }),
  member("susp", "Suspended Person", { status: "SUSPENDED" })
];

test("lists members, searches on the server and filters by status", async ({ page }) => {
  const { calls } = await mockApi(page, tenantAdmin, (call, route) => {
    if (call.path === "/tenants/members") {
      const q = new URLSearchParams(call.search).get("q");
      return json(route, 200, q ? rows.filter((r) => r.user.email.includes(q.toLowerCase())) : rows).then(() => true);
    }
    return false;
  });
  await page.goto("/workspace/people");
  const table = page.getByRole("table", { name: "Workspace users" });
  await expect(table.getByRole("row")).toHaveCount(5); // header + 4 members
  await expect(table.getByRole("columnheader", { name: "Member" })).toBeVisible();
  await expect(table.getByText("Awaiting acceptance")).toBeVisible();
  await page.getByLabel("Status").selectOption("SUSPENDED");
  await expect(table.getByRole("row")).toHaveCount(2);
  await page.getByLabel("Status").selectOption("");
  await page.getByLabel("Search by name or email").fill("ali");
  await expect(table.getByRole("row")).toHaveCount(2);
  expect(calls.some((c) => c.path === "/tenants/members" && c.search === "?q=ali")).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});

test("protects the own account; an invitation awaiting its owner can only be withdrawn; failures are shown", async ({ page }) => {
  const { calls } = await mockApi(page, tenantAdmin, async (call, route) => {
    if (call.path === "/tenants/members") { await json(route, 200, rows); return true; }
    if (call.method === "PATCH" && call.path === "/tenants/members/m-susp/status") { await json(route, 409, { message: "Membership already changed" }); return true; }
    if (call.method === "PATCH" && call.path === "/tenants/members/m-invited/status") { await json(route, 200, rows[2]); return true; }
    return false;
  });
  await page.goto("/workspace/people");
  const own = page.getByRole("row", { name: /Self Admin/ });
  await expect(own.getByText("Your own account")).toBeVisible();
  await expect(own.getByRole("button", { name: "Change status" })).toHaveCount(0);

  const invited = page.getByRole("row", { name: /Invited Person/ });
  await expect(invited.getByRole("button", { name: "Roles" })).toHaveCount(0);
  await invited.getByRole("button", { name: "Change status" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("option", { name: "Revoke membership" })).toBeAttached();
  await dialog.getByLabel(/Reason/).fill("ab"); // below the 3-character minimum: the browser blocks the submit
  await dialog.getByRole("button", { name: "Confirm" }).click();
  expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  await dialog.getByLabel(/Reason/).fill("Left the company");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Member status updated" })).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ status: "REVOKED", reason: "Left the company" });

  const suspended = page.getByRole("row", { name: /Suspended Person/ });
  const opener = suspended.getByRole("button", { name: "Change status" });
  await opener.click();
  await page.getByRole("dialog").getByLabel("New status").selectOption("ACTIVE");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Membership already changed");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused(); // focus returns to the control that opened the dialog
});

test("assigns roles and shows a member's history", async ({ page }) => {
  const roles = [
    { id: "r-trav", code: "traveler", name: "Traveler", description: null, isSystem: true, permissions: [], members: 1 },
    { id: "r-custom", code: "support", name: "Support staff", description: null, isSystem: false, permissions: [], members: 0 }
  ];
  const { calls } = await mockApi(page, tenantAdmin, async (call, route) => {
    if (call.path === "/tenants/members") { await json(route, 200, rows); return true; }
    if (call.path === "/roles") { await json(route, 200, roles); return true; }
    if (call.method === "PUT" && call.path === "/memberships/m-ali/roles") { await json(route, 200, { membershipId: "m-ali", roles: [] }); return true; }
    if (call.path === "/tenants/members/m-ali/history") {
      await json(route, 200, [{ id: "e1", action: "identity.membership.status", entityType: "membership", entityId: "m-ali", actorUserId: tenantAdmin.userId, metadata: { before: "ACTIVE", after: "SUSPENDED", reason: "Policy" }, occurredAt: "2030-02-01T10:00:00.000Z" }]);
      return true;
    }
    return false;
  });
  await page.goto("/workspace/people");
  const row = page.getByRole("row", { name: /Ali Traveler/ });
  await row.getByRole("button", { name: "History" }).click();
  const history = page.getByRole("dialog");
  await expect(history.getByText("Change member status")).toBeVisible(); // readable action label, not the raw code
  await expect(history.getByText("Self Admin")).toBeVisible(); // actor resolved from the member list
  await expect(history.getByText("Policy")).toBeVisible();
  await page.keyboard.press("Escape");

  await row.getByRole("button", { name: "Roles" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox", { name: /Traveler/ })).toBeChecked();
  await dialog.getByRole("checkbox", { name: /Support staff/ }).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Member roles updated" })).toBeVisible();
  expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ roleIds: ["r-trav", "r-custom"] });
});

test("a user without the permission sees no actions on members", async ({ page }) => {
  const limited = { ...tenantAdmin, permissions: ["tenant.read", "identity.user.read"] };
  await mockApi(page, limited, async (call, route) => {
    if (call.path === "/tenants/members") { await json(route, 200, rows); return true; }
    return false;
  });
  await page.goto("/workspace/people");
  const row = page.getByRole("row", { name: /Ali Traveler/ });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button")).toHaveCount(0);
});

test("a traveler cannot open the users view", async ({ page }) => {
  await mockApi(page, traveler, () => false);
  await page.goto("/workspace/people");
  await expect(page).toHaveURL(/\/workspace\/overview$/);
});
