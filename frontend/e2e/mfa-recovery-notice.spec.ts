import { expect, test, type Page, type Route } from "@playwright/test";
import { seedSessionHint, useEnglish } from "./helpers";

// Fully mocked API (no backend needed). users whose recovery codes were invalidated are told and walked through regeneration.
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const admin = { userId: "adm", tenantId: "t1", membershipId: "m1", email: "a@example.test", isPlatformAdmin: true, roles: ["platform-admin"], permissions: [] };
const NEW_CODES = ["AAAA-BBBB-CCCC-DDDD", "EEEE-FFFF-GGGG-HHHH"];

async function setup(page: Page, required: boolean) {
  await useEnglish(page);
  await seedSessionHint(page);
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let flagged = required;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/auth/refresh") return json(route, 200, { accessToken: "AT", expiresIn: 900, idleTimeoutSeconds: 900, user: admin });
    if (path === "/auth/me") return json(route, 200, admin);
    if (path === "/auth/mfa") return json(route, 200, { enabled: true, pendingSetup: false, recoveryCodesRemaining: 0, recoveryCodesRegenerationRequired: flagged });
    if (path === "/auth/mfa/recovery-codes") {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      calls.push({ path, body });
      if (body.password !== "right-password-123") return json(route, 401, { message: "The password or verification code is incorrect." });
      flagged = false;
      return json(route, 200, { recoveryCodes: NEW_CODES });
    }
    if (path === "/platform/overview") return json(route, 200, {});
    if (path === "/platform/references") return json(route, 200, { tenants: [], roles: [], permissions: [], organizations: [] });
    if (path.startsWith("/platform/records/")) return json(route, 200, { items: [], total: 0, page: 1, pageSize: 25 });
    return json(route, 200, []);
  });
  return calls;
}

test("flagged MFA user gets a notice that Esc cannot close, creates codes, sees them once, and it does not return", async ({ page }) => {
  const calls = await setup(page, true);
  await page.goto("/admin/accounts-permissions");
  const dialog = page.getByRole("dialog", { name: "Create new recovery codes" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Current password").fill("wrong-password-123");
  await dialog.getByLabel("Authenticator app code").fill("123456");
  await dialog.getByRole("button", { name: "Create codes" }).click();
  await expect(dialog.getByText("The password or verification code is incorrect.")).toBeVisible();
  await expect(dialog.getByLabel("Current password")).toHaveValue(""); // never kept around

  await dialog.getByLabel("Current password").fill("right-password-123");
  await dialog.getByLabel("Authenticator app code").fill("123456");
  await dialog.getByRole("button", { name: "Create codes" }).click();
  for (const c of NEW_CODES) await expect(dialog.getByText(c)).toBeVisible();
  expect(calls[1]).toMatchObject({ path: "/auth/mfa/recovery-codes", body: { password: "right-password-123", code: "123456" } });
  await expect(dialog.getByRole("button", { name: "Download" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Done" })).toBeDisabled();
  await dialog.getByLabel("I have saved these codes").check();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
  expect(stored).not.toContain("AAAA-BBBB");

  await page.reload();
  await expect(page.getByRole("dialog", { name: "Create new recovery codes" })).toHaveCount(0);
});

test("a user whose codes are fine sees no notice", async ({ page }) => {
  await setup(page, false);
  await page.goto("/admin/accounts-permissions");
  await expect(page.locator("main")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
