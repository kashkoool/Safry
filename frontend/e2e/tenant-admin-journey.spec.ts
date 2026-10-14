import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { secret, signIn, useEnglish } from "./helpers";

// Real backend: the seeded administrator (tenant administrator and platform administrator of the demo workspace).
// Every change is undone (role deleted, member re-activated, name restored); the created workspace is archived.
test.describe.configure({ mode: "serial" });

test("workspace administration against the real API", async ({ page }) => {
  await useEnglish(page);
  const suffix = randomBytes(4).toString("hex");
  await signIn(page, "admin", "admin@safry.local", secret("E2E_ADMIN_PASSWORD"));
  await expect(page).toHaveURL(/\/admin\//);
  await page.goto("/workspace/overview");

  // Roles: create, see it, audit it, delete it.
  await page.getByRole("link", { name: "Roles and permissions" }).click();
  await expect(page.getByRole("table", { name: "Workspace roles" })).toBeVisible();
  await page.getByRole("button", { name: "New role" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Role code").fill(`e2e-${suffix}`);
  await dialog.getByLabel("Role name").fill(`E2E role ${suffix}`);
  await dialog.getByRole("checkbox", { name: /Browse services/ }).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  const roleRow = page.getByRole("row", { name: new RegExp(`E2E role ${suffix}`) });
  await expect(roleRow).toBeVisible();
  await page.getByRole("link", { name: "Permission audit" }).click();
  await expect(page.getByRole("row", { name: new RegExp(`e2e-${suffix}`) }).first()).toBeVisible();
  await page.getByRole("link", { name: "Roles and permissions" }).click();
  await page.getByRole("row", { name: new RegExp(`E2E role ${suffix}`) }).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete role" }).click();
  await expect(page.getByRole("row", { name: new RegExp(`E2E role ${suffix}`) })).toHaveCount(0);

  // Team: server-side search, suspend with a reason, history, re-activate.
  await page.goto("/workspace/people");
  await page.getByLabel("Search by name or email").fill("airline@safry");
  const member = page.getByRole("row", { name: /airline@safry\.local/ });
  await expect(member).toBeVisible();
  await expect(page.getByRole("row", { name: /traveler@safry\.local/ })).toHaveCount(0);
  await member.getByRole("button", { name: "Change status" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("New status").selectOption("SUSPENDED");
  await dialog.getByLabel(/Reason/).fill("End-to-end check");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(member.getByText("Suspended")).toBeVisible();
  await member.getByRole("button", { name: "History" }).click();
  await expect(page.getByRole("dialog").getByText("Change member status")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("End-to-end check")).toBeVisible();
  await page.keyboard.press("Escape");
  await member.getByRole("button", { name: "Change status" }).click();
  await page.getByRole("dialog").getByLabel("New status").selectOption("ACTIVE");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(member.getByText("Active")).toBeVisible();

  // Settings: rename, then restore.
  await page.goto("/workspace/settings");
  const nameField = page.getByLabel("Workspace name");
  await expect(nameField).not.toHaveValue("");
  const original = await nameField.inputValue();
  await nameField.fill(`${original} ${suffix}`);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Workspace settings saved" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Workspace name")).toHaveValue(`${original} ${suffix}`);
  await page.getByLabel("Workspace name").fill(original);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Workspace settings saved" })).toBeVisible();

  // Platform: unlock a sign-in, create a workspace, read its activity, archive it.
  await page.goto("/admin/accounts-permissions");
  await page.getByRole("button", { name: "Unlock sign-in" }).click();
  await page.getByRole("dialog").getByLabel("Account email").fill("traveler@safry.local");
  await page.getByRole("dialog").getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Unlock requested for traveler@safry.local" })).toBeVisible();
  await page.goto("/admin/tenants");
  await page.getByRole("button", { name: "New workspace" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Workspace code").fill(`e2e-${suffix}`);
  await dialog.getByLabel("Workspace name").fill(`E2E workspace ${suffix}`);
  await dialog.getByRole("button", { name: "Create" }).click();
  const tenantRow = page.getByRole("row", { name: new RegExp(`E2E workspace ${suffix}`) });
  await expect(tenantRow).toBeVisible();
  await tenantRow.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("dialog").getByText("Create workspace")).toBeVisible();
  await page.keyboard.press("Escape");
  await tenantRow.getByRole("button", { name: "Change status" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("New status").selectOption("ARCHIVED");
  await dialog.getByLabel("Reason (required)").fill("End-to-end cleanup");
  await dialog.getByRole("checkbox", { name: /archiving is final/ }).check();
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("row", { name: new RegExp(`E2E workspace ${suffix}`) }).getByText("Archived")).toBeVisible();
});
