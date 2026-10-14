import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { json, mockApi, tenantAdmin, traveler } from "./mock-api";

// Fully mocked API: the roles and permissions manager.
const catalog = [
  { code: "audit.read", description: "x" }, { code: "booking.read", description: "x" }, { code: "tenant.read", description: "x" },
  { code: "tenant.update", description: "x" }, { code: "identity.role.manage", description: "x" }
];
const baseRoles = () => [
  { id: "r-sys", code: "traveler", name: "Traveler", description: null, isSystem: true, permissions: ["tenant.read"], members: 3 },
  { id: "r-1", code: "support", name: "Support agent", description: "Front desk", isSystem: false, permissions: ["booking.read"], members: 0 },
  { id: "r-2", code: "ops", name: "Operations", description: null, isSystem: false, permissions: ["booking.read"], members: 2 }
];

test("lists roles, protects system roles and groups permissions by domain when creating", async ({ page }) => {
  let roles = baseRoles();
  const { calls } = await mockApi(page, { ...tenantAdmin, permissions: tenantAdmin.permissions.filter((p) => p !== "tenant.update") }, async (call, route) => {
    if (call.path === "/roles" && call.method === "GET") { await json(route, 200, roles); return true; }
    if (call.path === "/permissions") { await json(route, 200, catalog); return true; }
    if (call.path === "/roles" && call.method === "POST") {
      roles = [...roles, { id: "r-new", code: String(call.body.code), name: String(call.body.name), description: null, isSystem: false, permissions: call.body.permissions as string[], members: 0 }];
      await json(route, 201, roles[roles.length - 1]);
      return true;
    }
    return false;
  });
  await page.goto("/workspace/access/roles");
  const table = page.getByRole("table", { name: "Workspace roles" });
  const system = table.getByRole("row", { name: /Traveler/ });
  await expect(system.getByText("System role")).toBeVisible();
  await expect(system.getByRole("button", { name: "Edit" })).toBeDisabled();
  await expect(system.getByRole("button", { name: "Delete" })).toBeDisabled();
  await expect(page.getByText("System roles cannot be edited or deleted")).toBeVisible(); // the reason is visible text, not only a tooltip
  await expect(table.getByRole("row", { name: /Operations/ }).getByRole("button", { name: "Delete" })).toBeDisabled(); // in use by 2 members
  expect((await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

  await page.getByRole("button", { name: "New role" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("group", { name: "Audit" })).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Workspace" })).toBeVisible();
  // The caller lacks tenant.update, so it cannot be granted and is disabled with the reason.
  await expect(dialog.getByRole("checkbox", { name: /Edit workspace/ })).toBeDisabled();
  await dialog.getByLabel("Role code").fill("Bad Code");
  await dialog.getByLabel("Role name").fill("Auditor");
  await dialog.getByRole("button", { name: "Save" }).click();
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(0); // pattern blocks an invalid code
  await dialog.getByLabel("Role code").fill("auditor");
  await dialog.getByRole("checkbox", { name: /Read the audit trail/ }).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Role created" })).toBeVisible();
  expect(calls.find((c) => c.method === "POST")!.body).toEqual({ code: "auditor", name: "Auditor", permissions: ["audit.read"] });
  await expect(table.getByRole("row", { name: /Auditor/ })).toBeVisible();
});

test("editing detects a concurrent change and deleting handles a conflict", async ({ page }) => {
  let roles = baseRoles();
  const { calls } = await mockApi(page, tenantAdmin, async (call, route) => {
    if (call.path === "/roles" && call.method === "GET") { await json(route, 200, roles); return true; }
    if (call.path === "/permissions") { await json(route, 200, catalog); return true; }
    if (call.path === "/roles/r-1" && call.method === "PATCH") { await json(route, 200, roles[1]); return true; }
    if (call.path === "/roles/r-1" && call.method === "DELETE") { await json(route, 409, { message: "Role is assigned to members" }); return true; }
    return false;
  });
  await page.goto("/workspace/access/roles");
  const row = page.getByRole("row", { name: /Support agent/ });
  await row.getByRole("button", { name: "Edit" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Role name").fill("Support lead");
  // Someone else changes the role while the dialog is open.
  roles = roles.map((r) => (r.id === "r-1" ? { ...r, permissions: ["booking.read", "tenant.read"] } : r));
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "Someone else changed this role" })).toBeVisible();
  expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Load the latest version" }).click();
  await expect(dialog.getByLabel("Role name")).toHaveValue("Support agent");
  await expect(dialog.getByRole("checkbox", { name: /View workspace/ })).toBeChecked();
  await dialog.getByLabel("Role name").fill("Support lead");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Role saved" })).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ name: "Support lead", description: "Front desk", permissions: ["booking.read", "tenant.read"] });

  await page.getByRole("row", { name: /Support agent/ }).getByRole("button", { name: "Delete" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByText("permanently deleted")).toBeVisible();
  await dialog.getByRole("button", { name: "Delete role" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Role is assigned to members");
});

test("without the permission the entry is hidden and a direct URL is redirected", async ({ page }) => {
  await mockApi(page, traveler, () => false);
  await page.goto("/workspace/overview");
  await expect(page.getByRole("link", { name: "Roles and permissions" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Workspace settings" })).toHaveCount(0);
  await page.goto("/workspace/access/roles");
  await expect(page).toHaveURL(/\/workspace\/overview$/);
  await page.goto("/workspace/access/audit");
  await expect(page).toHaveURL(/\/workspace\/overview$/);
});

test("a user who may only read the audit is sent from roles to the audit tab", async ({ page }) => {
  await mockApi(page, { ...tenantAdmin, permissions: ["tenant.read", "audit.read"] }, () => false);
  await page.goto("/workspace/access/roles");
  await expect(page).toHaveURL(/\/workspace\/access\/audit$/);
  await expect(page.getByRole("heading", { name: "Permission audit" })).toBeVisible();
});
