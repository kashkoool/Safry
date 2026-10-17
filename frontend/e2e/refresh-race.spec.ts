import { expect, test } from "@playwright/test";
import { seedSessionHint, useEnglish } from "./helpers";

// Fully mocked API (no backend needed): a refresh in flight while the user logs out must not bring the session back.
test("a refresh in flight during logout does not resurrect the session", async ({ page }) => {
  await useEnglish(page);
  const user = {
    userId: "u1", tenantId: "t1", membershipId: "m1", email: "a@example.test",
    roles: ["traveler"], permissions: []
  };
  const pair = (n: number) => ({ accessToken: `AT${n}`, expiresIn: 900, idleTimeoutSeconds: 900, user });
  await seedSessionHint(page);

  let logouts = 0;
  let refreshes = 0;
  let slowRefreshStarted = false;
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/v1", "");
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/auth/refresh") {
      refreshes += 1;
      if (refreshes === 1) return json(200, pair(1)); // resume on page load (cookie -> AT1)
      slowRefreshStarted = true;
      await new Promise((r) => setTimeout(r, 1500)); // server rotated the cookie, response slow
      return json(200, pair(2));
    }
    if (path === "/auth/logout") {
      logouts += 1;
      return route.fulfill({ status: 204 });
    }
    if (path === "/auth/me") return json(200, user);
    const bearer = route.request().headers()["authorization"];
    if (bearer === "Bearer AT1") return json(401, { message: "expired" });
    return json(200, []);
  });

  await page.goto("/");
  await expect.poll(() => slowRefreshStarted).toBe(true);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => logouts).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(2500); // let the slow refresh response arrive
  // Signed out stays signed out: no hint, no session, and the late refresh result did not bring the user back.
  expect(await page.evaluate(() => localStorage.getItem("safry.hasSession"))).toBeNull();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  // Logout waits for the in-flight refresh, so its single call carries the cookie that refresh rotated and ends that family.
  expect(logouts).toBe(1);
});
