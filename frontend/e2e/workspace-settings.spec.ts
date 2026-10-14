import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { json, mockApi, tenantAdmin, tenantRecord, traveler } from "./mock-api";

// Fully mocked API: workspace settings.
test("saves only the changed keys and keeps branding whole", async ({ page }) => {
  let tenant = { ...tenantRecord, settings: { currency: "SAR", branding: { primaryColor: "#112233" } } };
  const { calls } = await mockApi(page, tenantAdmin, async (call, route) => {
    if (call.path === "/tenants/current" && call.method === "PATCH") {
      const body = call.body as { name?: string; settings?: Record<string, unknown> };
      tenant = { ...tenant, name: body.name ?? tenant.name, settings: { ...tenant.settings, ...(body.settings ?? {}) } };
      await json(route, 200, tenant);
      return true;
    }
    if (call.path === "/tenants/current") { await json(route, 200, tenant); return true; }
    return false;
  });
  await page.goto("/workspace/settings");
  await expect(page.getByLabel("Workspace name")).toHaveValue("Safry Test");
  await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled(); // nothing changed yet
  await page.getByLabel("Workspace name").fill("Safry Renamed");
  await page.getByLabel("Default language").selectOption("en-US");
  await page.getByLabel("Logo URL (https)").fill("https://cdn.example.test/logo.svg");
  await expect(page.getByText("This URL will not be displayed")).toBeVisible(); // cross-origin: CSP would block it
  await expect(page.getByText("The logo appears only when it is hosted on this app")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Workspace settings saved" })).toBeVisible();
  const patch = calls.find((c) => c.method === "PATCH")!;
  expect(patch.body).toEqual({
    name: "Safry Renamed",
    settings: { locale: "en-US", branding: { primaryColor: "#112233", logoUrl: "https://cdn.example.test/logo.svg" } }
  });
  expect(patch.body).not.toHaveProperty("settings.currency"); // unchanged keys are not resent
  expect(JSON.stringify(patch.body)).not.toContain("features");
  await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled();
});

test("shows the server's validation message and keeps the form", async ({ page }) => {
  await mockApi(page, tenantAdmin, async (call, route) => {
    if (call.path === "/tenants/current" && call.method === "PATCH") { await json(route, 400, { message: "settings is too large" }); return true; }
    return false;
  });
  await page.goto("/workspace/settings");
  await page.getByLabel("Workspace name").fill("Another name");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("alert")).toHaveText("settings is too large");
  await expect(page.getByLabel("Workspace name")).toHaveValue("Another name");
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByLabel("Workspace name")).toHaveValue("Safry Test");
});

test("the entry shows only with tenant.update and a direct URL is redirected otherwise", async ({ page }) => {
  await mockApi(page, tenantAdmin, () => false);
  await page.goto("/workspace/overview");
  await expect(page.getByRole("link", { name: "Workspace settings" })).toBeVisible();
  await page.getByRole("link", { name: "Workspace settings" }).click();
  await expect(page).toHaveURL(/\/workspace\/settings$/);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mockApi(page, traveler, () => false);
  await page.goto("/workspace/settings");
  await expect(page).toHaveURL(/\/workspace\/overview$/);
});

test("the workspace currency becomes the default display currency", async ({ page }) => {
  await mockApi(page, tenantAdmin, async (call, route) => {
    if (call.path === "/tenants/current") { await json(route, 200, { ...tenantRecord, settings: { currency: "EUR" } }); return true; }
    return false;
  });
  await page.goto("/workspace/overview");
  await expect(page.getByLabel("Price display currency")).toHaveValue("EUR");
});
