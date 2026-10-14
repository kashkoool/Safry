import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, request as pwRequest, test, type APIRequestContext } from "@playwright/test";
import { apiURL, TENANT, useEnglish } from "./helpers";

// Real-stack journeys for the credential flows (register -> verify -> sign in, forgot -> reset).
// The API runs with MAIL_TRANSPORT=console (the development default): every mail is logged as
// `to=<address> subject="..." link=<url>#token=<token>` by the MailConsole logger. Point E2E_API_LOG at the API's log file
// so the spec can read the emailed link. Only the `#token=` fragment is used; the host in the mailed link is ignored.
const LOG = process.env.E2E_API_LOG;
const HEADERS = { "x-requested-with": "XMLHttpRequest" };
const unique = () => randomBytes(5).toString("hex");
const generated = () => `pw-${randomBytes(12).toString("hex")}`;

/** Newest mailed token for `address` whose link path is `path` (`/verify-email` or `/reset-password`). */
async function mailedToken(address: string, path: "/verify-email" | "/reset-password"): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const lines = readFileSync(LOG as string, "utf8").split("\n").filter((line) => line.includes("MailConsole") && line.includes(`to=${address} `));
    for (const line of lines.reverse()) {
      const match = new RegExp(`link=\\S*${path}#token=([A-Za-z0-9_-]+)`).exec(line);
      if (match?.[1]) return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no ${path} mail logged for the test address`);
}

const login = (api: APIRequestContext, email: string, password: string) =>
  api.post("/api/v1/auth/login", { headers: HEADERS, data: { email, password, tenantCode: TENANT, portal: "customer" } });

test.describe("credential journeys on the real backend", () => {
  test.describe.configure({ mode: "serial" });
  const email = `fec-${unique()}@example.test`;
  const password = generated();
  const newPassword = generated();

  test.beforeAll(() => {
    // CI must exercise these for real: a missing log path there is a setup error, not a reason to skip.
    if (!LOG && process.env.CI) throw new Error("E2E_API_LOG must point at the API log file (see .github/workflows/ci.yml)");
    test.skip(!LOG, "E2E_API_LOG is not set: the emailed link cannot be read (point it at the API log; the API must use MAIL_TRANSPORT=console)");
  });
  test.beforeEach(async ({ page }) => { await useEnglish(page); });

  test("register, refused sign-in, verify through the emailed fragment link, then sign in", async ({ page }) => {
    await page.goto("/register/customer");
    await page.getByLabel("Full name").fill("Credential Journey");
    await page.getByLabel("Email address").fill(email);
    await page.locator('input[autocomplete="new-password"]').fill(password);
    await page.getByRole("button", { name: "Create my account" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Check your email" })).toBeFocused();

    // Unverified: refused with the generic message, and the resend action is offered.
    await page.goto("/login/customer");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText(/Invalid credentials/i);
    await expect(page).toHaveURL(/\/login\/customer/);
    await expect(page.getByRole("button", { name: "Resend verification email" })).toBeVisible();

    const token = await mailedToken(email, "/verify-email");
    await page.goto("about:blank");
    await page.goto(`/verify-email#token=${token}`);
    await expect(page.getByText("Your email address is confirmed")).toBeVisible();
    expect(page.url()).not.toContain("token");

    await page.getByRole("link", { name: "Continue to sign in" }).click();
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).not.toHaveURL(/\/login\//, { timeout: 15_000 });

    // The link is single use: the same token is now refused.
    await page.goto("about:blank");
    await page.goto(`/verify-email#token=${token}`);
    await expect(page.getByRole("alert")).toContainText("invalid or has expired");
  });

  test("forgot, reset through the emailed link: old password rejected, new works, other session ended", async ({ page }) => {
    const other = await pwRequest.newContext({ baseURL: apiURL });
    const first = await login(other, email, password);
    expect(first.status()).toBe(200);
    expect((await other.post("/api/v1/auth/refresh", { headers: HEADERS })).status()).toBe(200);

    await page.goto("/forgot-password");
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("If an account exists")).toBeVisible();

    const token = await mailedToken(email, "/reset-password");
    await page.goto("about:blank");
    await page.goto(`/reset-password#token=${token}`);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    expect(page.url()).not.toContain("token");
    await page.getByLabel("New password").fill(newPassword);
    await page.getByLabel("Confirm password").fill(newPassword);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Your new password is set")).toBeVisible();

    const api = await pwRequest.newContext({ baseURL: apiURL });
    expect((await login(api, email, password)).status(), "old password must be rejected").toBe(401);
    expect((await login(api, email, newPassword)).status(), "new password must work").toBe(200);
    expect((await other.post("/api/v1/auth/refresh", { headers: HEADERS })).status(), "the other session must be ended").toBe(401);
    await api.dispose();
    await other.dispose();

    // The reset link is single use: replaying it is refused by the real API and shows the invalid-link state.
    await page.goto("about:blank");
    await page.goto(`/reset-password#token=${token}`);
    const replay = generated();
    await page.getByLabel("New password").fill(replay);
    await page.getByLabel("Confirm password").fill(replay);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "invalid or has expired" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Request a new link" })).toBeVisible();
    expect((await login(await pwRequest.newContext({ baseURL: apiURL }), email, replay)).status()).toBe(401);
  });
});
