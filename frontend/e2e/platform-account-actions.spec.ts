import { expect, test, type Route } from "@playwright/test";
import { json, mockApi, platformAdmin } from "./mock-api";

// Fully mocked API: per-account sign-in block and verification state in the platform accounts list.
const future = new Date(Date.now() + 3_600_000).toISOString();
const account = (id: string, name: string, extra: Record<string, unknown>) => ({
  id, email: `${id}@example.test`, displayName: name, status: "ACTIVE", isPlatformAdmin: false, deletedAt: null,
  createdAt: "2030-01-01T00:00:00.000Z", memberships: [], lockedUntil: null, emailVerifiedAt: "2030-01-01T00:00:00.000Z", ...extra
});

function handler(state: { locked: boolean; resend: "ok" | "limited" }) {
  return async (call: { method: string; path: string; body: Record<string, unknown> }, route: Route) => {
    if (call.path === "/platform/overview") { await json(route, 200, {}); return true; }
    if (call.path === "/platform/references") { await json(route, 200, { tenants: [], roles: [], permissions: [], organizations: [] }); return true; }
    if (call.path === "/platform/records/users") {
      const items = [
        account("locked1", "Locked Lena", { lockedUntil: state.locked ? future : null }),
        account("unver1", "Unverified Umar", { emailVerifiedAt: null }),
        account("fine1", "Fine Fatima", {})
      ];
      await json(route, 200, { items, total: 3, page: 1, pageSize: 30 });
      return true;
    }
    if (call.method === "POST" && call.path === "/auth/login-throttle/unlock") { state.locked = false; await route.fulfill({ status: 204 }); return true; }
    if (call.method === "POST" && call.path === "/auth/email/resend") {
      if (state.resend === "limited") { await route.fulfill({ status: 429, headers: { "retry-after": "30", "content-type": "application/json" }, body: JSON.stringify({ statusCode: 429, message: "Too many requests" }) }); return true; }
      await json(route, 202, { accepted: true });
      return true;
    }
    return false;
  };
}

test("locked account shows a chip and Unlock, which clears it", async ({ page }) => {
  const state = { locked: true, resend: "ok" as const };
  const { calls } = await mockApi(page, platformAdmin, handler(state));
  await page.goto("/admin/accounts-permissions");
  const row = page.getByRole("row", { name: /Locked Lena/ });
  await expect(row.getByText(/Locked until/)).toBeVisible();
  await expect(row.getByRole("button", { name: "Resend verification email" })).toHaveCount(0);
  await row.getByRole("button", { name: "Unlock sign-in" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("locked1@example.test")).toBeVisible();
  expect(calls.filter((c) => c.path === "/auth/login-throttle/unlock")).toHaveLength(0); // confirmation first
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sign-in unlocked for locked1@example.test" })).toBeVisible();
  expect(calls.find((c) => c.path === "/auth/login-throttle/unlock")!.body).toEqual({ email: "locked1@example.test" });
  await expect(row.getByText(/Locked until/)).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Unlock sign-in" })).toHaveCount(0);
});

test("unverified account: resend shows a neutral success message", async ({ page }) => {
  const { calls } = await mockApi(page, platformAdmin, handler({ locked: false, resend: "ok" }));
  await page.goto("/admin/accounts-permissions");
  const row = page.getByRole("row", { name: /Unverified Umar/ });
  await expect(row.getByText("Email not verified")).toBeVisible();
  await expect(row.getByRole("button", { name: "Unlock sign-in" })).toHaveCount(0);
  await row.getByRole("button", { name: "Resend verification email" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "If a confirmation was needed" })).toBeVisible();
  expect(calls.find((c) => c.path === "/auth/email/resend")!.body).toEqual({ email: "unver1@example.test" });
});

test("resend rate limit shows a retry countdown and disables the button", async ({ page }) => {
  await mockApi(page, platformAdmin, handler({ locked: false, resend: "limited" }));
  await page.goto("/admin/accounts-permissions");
  await page.getByRole("row", { name: /Unverified Umar/ }).getByRole("button", { name: "Resend verification email" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Send link" }).click();
  await expect(dialog.getByText(/Try again in \d+ s/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send link" })).toBeDisabled();
});

test("verified and unlocked account shows neither chip nor action", async ({ page }) => {
  await mockApi(page, platformAdmin, handler({ locked: false, resend: "ok" }));
  await page.goto("/admin/accounts-permissions");
  const row = page.getByRole("row", { name: /Fine Fatima/ });
  await expect(row).toBeVisible();
  await expect(row.getByText(/Locked until|Email not verified/)).toHaveCount(0);
  await expect(row.getByRole("button", { name: /Unlock sign-in|Resend verification email/ })).toHaveCount(0);
});
