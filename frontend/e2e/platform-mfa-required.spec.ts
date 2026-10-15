import { expect, test, type Route } from "@playwright/test";
import { seedSessionHint, useEnglish } from "./helpers";

// Fully mocked API (no backend needed): a platform administrator without two-factor gets 403 mfa_enrollment_required.
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const admin = { userId: "adm", tenantId: "t1", membershipId: "m1", email: "a@example.test", isPlatformAdmin: true, mfaEnabled: false, roles: ["platform-admin"], permissions: [] };

test("a platform administrator without two-factor sees an enrolment notice with a link to the wizard", async ({ page }) => {
  await useEnglish(page);
  await seedSessionHint(page);
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/auth/refresh") return json(route, 200, { accessToken: "AT", expiresIn: 900, idleTimeoutSeconds: 900, user: admin });
    if (path === "/auth/me") return json(route, 200, admin);
    if (path.startsWith("/platform/"))
      return json(route, 403, { statusCode: 403, code: "mfa_enrollment_required", message: "enrol first" });
    return json(route, 200, []);
  });
  await page.goto("/admin/accounts-permissions");
  const notice = page.getByRole("alert");
  await expect(notice.getByRole("heading", { name: "Turn on two-factor sign-in to continue" })).toBeVisible();
  const link = notice.getByRole("link", { name: "Set up two-factor sign-in" });
  await expect(link).toHaveAttribute("href", "/account/security");
  // Not the generic error banner, and no platform table is rendered.
  await expect(page.getByText("Records")).toHaveCount(0);
});

test("any other 403 on the platform page keeps the generic error banner", async ({ page }) => {
  await useEnglish(page);
  await seedSessionHint(page);
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/auth/refresh") return json(route, 200, { accessToken: "AT", expiresIn: 900, idleTimeoutSeconds: 900, user: { ...admin, mfaEnabled: true } });
    if (path === "/auth/me") return json(route, 200, { ...admin, mfaEnabled: true });
    if (path.startsWith("/platform/")) return json(route, 403, { statusCode: 403, message: "forbidden" });
    return json(route, 200, []);
  });
  await page.goto("/admin/accounts-permissions");
  await expect(page.locator(".form-error")).toBeVisible();
  await expect(page.getByRole("link", { name: "Set up two-factor sign-in" })).toHaveCount(0);
});
