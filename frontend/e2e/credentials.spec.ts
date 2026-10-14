import { randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { useEnglish } from "./helpers";

// Fully mocked API (no backend needed): forgot password, reset password, verify email, resend, login and register hints.
const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
const TOKEN = "Tk3_mocked-Token-value-0123456789abcdefgh";
const NEW_PASSWORD = `pw-${randomBytes(12).toString("hex")}`; // generated per run
const ACCEPTED = { accepted: true };

interface Seen { method: string; path: string; body: Record<string, unknown> }
type Handler = (route: Route, body: Record<string, unknown>, seen: Seen[]) => Promise<void> | void;

async function setup(page: Page, handlers: Record<string, Handler> = {}) {
  await useEnglish(page);
  const seen: Seen[] = [];
  const consoleLines: string[] = [];
  const hosts = new Set<string>();
  page.on("console", (message) => consoleLines.push(message.text()));
  page.on("request", (request) => hosts.add(new URL(request.url()).host));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const body = (request.method() === "GET" ? {} : request.postDataJSON() ?? {}) as Record<string, unknown>;
    seen.push({ method: request.method(), path, body });
    const handler = handlers[`${request.method()} ${path}`];
    if (handler) return handler(route, body, seen);
    return json(route, 404, { message: "not found" });
  });
  return { seen, consoleLines, hosts };
}

const posts = (seen: Seen[], path: string) => seen.filter((call) => call.method === "POST" && call.path === path);
async function expectNoToken(page: Page, consoleLines: string[]) {
  expect(page.url()).not.toContain("token");
  expect(page.url()).not.toContain("#");
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
  expect(stored).not.toContain(TOKEN);
  expect(JSON.stringify(await page.context().cookies())).not.toContain(TOKEN);
  expect(consoleLines.join("\n")).not.toContain(TOKEN);
  expect(await page.evaluate(() => document.querySelectorAll("a[href*='token']").length)).toBe(0);
  expect(await page.evaluate(() => window.history.length > 0 && !String(window.history.state ?? "").includes("token"))).toBe(true);
}
async function axeClean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

test.describe("forgot password", () => {
  test("shows the same neutral confirmation for any address and moves focus to it", async ({ page }) => {
    const { seen } = await setup(page, { "POST /auth/password/forgot": (route) => json(route, 202, ACCEPTED) });
    await page.goto("/forgot-password");
    await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
    await axeClean(page);
    await page.getByLabel("Email address").fill("nobody@example.test");
    await page.getByRole("button", { name: "Send reset link" }).click();
    const message = page.getByRole("status").filter({ hasText: "If an account exists" });
    await expect(message).toBeVisible();
    await expect(message).toBeFocused();
    expect(posts(seen, "/auth/password/forgot")[0]?.body).toEqual({ email: "nobody@example.test" });
    // Resend cooldown: the button waits and states how long.
    await expect(page.getByRole("button", { name: /Send again in \d+ s/ })).toBeDisabled();
    await axeClean(page);
  });

  test("429 shows a countdown from Retry-After and disables the button; network and validation errors are announced", async ({ page }) => {
    let mode: "throttle" | "network" | "bad" = "throttle";
    await setup(page, {
      "POST /auth/password/forgot": (route) => mode === "network" ? route.abort("failed")
        : mode === "bad" ? json(route, 400, { message: ["email must be an email"] })
          : json(route, 429, { message: "ThrottlerException: Too Many Requests" }, { "retry-after": "7" })
    });
    await page.goto("/forgot-password");
    await page.getByLabel("Email address").fill("a@example.test");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("alert")).toContainText("Too many attempts");
    await expect(page.getByRole("button", { name: /Send again in [1-7] s/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Send reset link" })).toBeEnabled({ timeout: 12_000 });
    mode = "network";
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("alert")).toContainText("Could not reach the server");
    mode = "bad";
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByLabel("Email address")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Email address")).toHaveAttribute("aria-describedby", "forgot-error");
  });

  test("native validation blocks an empty or malformed email and a double click sends one request", async ({ page }) => {
    const { seen } = await setup(page, {
      "POST /auth/password/forgot": async (route) => { await new Promise((r) => setTimeout(r, 400)); return json(route, 202, ACCEPTED); }
    });
    await page.goto("/forgot-password");
    await page.getByRole("button", { name: "Send reset link" }).click();
    expect(posts(seen, "/auth/password/forgot")).toHaveLength(0);
    await page.getByLabel("Email address").fill("a@example.test");
    const button = page.getByRole("button", { name: "Send reset link" });
    await button.dblclick();
    await expect(page.getByText("If an account exists")).toBeVisible();
    expect(posts(seen, "/auth/password/forgot")).toHaveLength(1);
  });
});

test.describe("reset password", () => {
  test("removes the token from the address bar, keeps it out of storage, console and links, and resets", async ({ page }) => {
    const { seen, consoleLines, hosts } = await setup(page, { "POST /auth/password/reset": (route) => route.fulfill({ status: 204 }) });
    await page.goto(`/reset-password#token=${TOKEN}`);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await expectNoToken(page, consoleLines);
    await axeClean(page);
    await page.getByLabel("New password").fill("short");
    await page.getByLabel("Confirm password").fill("different");
    await expect(page.getByText("The two passwords do not match.")).toBeVisible();
    await expect(page.getByLabel("Confirm password")).toHaveAttribute("aria-invalid", "true");
    await page.getByLabel("New password").fill(NEW_PASSWORD);
    await expect(page.getByText(/Password strength: Strong/)).toBeVisible();
    await expect(page.getByLabel("New password")).toHaveAttribute("autocomplete", "new-password");
    await expect(page.getByLabel("New password")).toHaveAttribute("minlength", "12");
    await expect(page.getByLabel("New password")).toHaveAttribute("maxlength", "128");
    await page.getByLabel("Confirm password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(page.getByLabel("New password")).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide password" }).click();
    await page.getByRole("button", { name: "Change password" }).click();
    const done = page.getByRole("status").filter({ hasText: "Your new password is set" });
    await expect(done).toBeVisible();
    await expect(done).toBeFocused();
    await expect(done).toContainText("All other sessions");
    expect(posts(seen, "/auth/password/reset")).toEqual([{ method: "POST", path: "/auth/password/reset", body: { token: TOKEN, newPassword: NEW_PASSWORD } }]);
    await expect(page.getByRole("link", { name: "Continue to sign in" })).toHaveAttribute("href", /\/login\//);
    expect(await page.locator("input").count()).toBe(0);
    expect(await page.content()).not.toContain(NEW_PASSWORD);
    await expectNoToken(page, consoleLines);
    expect(consoleLines.join("\n")).not.toContain(NEW_PASSWORD);
    expect([...hosts].filter((host) => !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))).toEqual([]);
    await axeClean(page);
  });

  test("an expired or used link (400) shows the invalid state with a link to request a new one", async ({ page }) => {
    await setup(page, { "POST /auth/password/reset": (route) => json(route, 400, { message: "Reset link is invalid or expired" }) });
    await page.goto(`/reset-password#token=${TOKEN}`);
    await page.getByLabel("New password").fill(NEW_PASSWORD);
    await page.getByLabel("Confirm password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    const message = page.getByRole("alert").filter({ hasText: "invalid or has expired" });
    await expect(message).toBeFocused();
    await expect(page.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/forgot-password");
    await axeClean(page);
  });

  test("no token or a malformed fragment is the invalid state and sends nothing", async ({ page }) => {
    const { seen } = await setup(page);
    await page.goto("/reset-password");
    await expect(page.getByRole("alert")).toContainText("invalid or has expired");
    await page.goto("about:blank");
    await page.goto("/reset-password#token=short");
    await expect(page.getByRole("alert")).toContainText("invalid or has expired");
    expect(page.url()).not.toContain("#");
    expect(seen).toHaveLength(0);
  });

  test("a password-policy 400 keeps the token so the user can fix it; short passwords never reach the API", async ({ page }) => {
    let calls = 0;
    const { seen } = await setup(page, {
      "POST /auth/password/reset": (route) => { calls += 1; return calls === 1 ? json(route, 400, { message: "newPassword must not be blank" }) : route.fulfill({ status: 204 }); }
    });
    await page.goto(`/reset-password#token=${TOKEN}`);
    await page.getByLabel("New password").fill("a".repeat(8));
    await page.getByLabel("Confirm password").fill("a".repeat(8));
    // Native minlength stops the submit; the page-level check is the backstop, so bypass the browser check to prove it.
    await page.locator("form").evaluate((form) => form.setAttribute("novalidate", ""));
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("alert")).toContainText("between 12 and 128");
    expect(posts(seen, "/auth/password/reset")).toHaveLength(0);
    await page.getByLabel("New password").fill(NEW_PASSWORD);
    await page.getByLabel("Confirm password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByLabel("New password")).toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Your new password is set")).toBeVisible();
    expect(posts(seen, "/auth/password/reset").map((c) => c.body.token)).toEqual([TOKEN, TOKEN]);
  });

  test("429 counts down, network error is announced, and a double click sends one request", async ({ page }) => {
    let mode: "throttle" | "network" | "ok" = "throttle";
    const { seen } = await setup(page, {
      "POST /auth/password/reset": async (route) => {
        if (mode === "network") return route.abort("failed");
        if (mode === "throttle") return json(route, 429, { message: "x" }, { "retry-after": "6" });
        await new Promise((r) => setTimeout(r, 300));
        return route.fulfill({ status: 204 });
      }
    });
    await page.goto(`/reset-password#token=${TOKEN}`);
    await page.getByLabel("New password").fill(NEW_PASSWORD);
    await page.getByLabel("Confirm password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("alert")).toContainText("Too many attempts");
    await expect(page.getByRole("button", { name: /Try again in [1-6] s/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Change password" })).toBeEnabled({ timeout: 12_000 });
    mode = "network";
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("alert")).toContainText("Could not reach the server");
    mode = "ok";
    await page.getByRole("button", { name: "Change password" }).dblclick();
    await expect(page.getByText("Your new password is set")).toBeVisible();
    expect(posts(seen, "/auth/password/reset")).toHaveLength(3);
  });
});

test.describe("verify email", () => {
  test("verifies once on load with a visible verifying state, then offers sign in", async ({ page }) => {
    const { seen, consoleLines, hosts } = await setup(page, {
      "POST /auth/email/verify": async (route) => { await new Promise((r) => setTimeout(r, 500)); return route.fulfill({ status: 204 }); }
    });
    await page.goto(`/verify-email#token=${TOKEN}`);
    await expect(page.getByRole("status").filter({ hasText: "Checking your link" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "confirmed" })).toBeFocused();
    expect(posts(seen, "/auth/email/verify")).toEqual([{ method: "POST", path: "/auth/email/verify", body: { token: TOKEN } }]);
    await expect(page.getByRole("link", { name: "Continue to sign in" })).toBeVisible();
    await expectNoToken(page, consoleLines);
    expect([...hosts].filter((host) => !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))).toEqual([]);
    await axeClean(page);
  });

  test("an invalid or expired link shows the error and a resend form with a neutral answer", async ({ page }) => {
    const { seen } = await setup(page, {
      "POST /auth/email/verify": (route) => json(route, 400, { message: "Verification link is invalid or expired" }),
      "POST /auth/email/resend": (route) => json(route, 202, ACCEPTED)
    });
    await page.goto(`/verify-email#token=${TOKEN}`);
    await expect(page.getByRole("alert").filter({ hasText: "invalid or has expired" })).toBeVisible();
    await axeClean(page);
    await page.getByLabel("Email address").fill("someone@example.test");
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    const sent = page.getByRole("status").filter({ hasText: "If this address has an account" });
    await expect(sent).toBeFocused();
    expect(posts(seen, "/auth/email/resend")[0]?.body).toEqual({ email: "someone@example.test" });
    await expect(page.getByRole("button", { name: /Send again in \d+ s/ })).toBeDisabled();
    await axeClean(page);
  });

  test("no token is the invalid state; a network failure keeps the link usable and retries; 429 counts down", async ({ page }) => {
    await setup(page);
    await page.goto("/verify-email");
    await expect(page.getByRole("alert")).toContainText("invalid or has expired");
    await page.goto("about:blank");

    let mode: "network" | "throttle" | "ok" = "network";
    await page.unroute("**/api/v1/**");
    const { seen } = await setup(page, {
      "POST /auth/email/verify": (route) => mode === "network" ? route.abort("failed")
        : mode === "throttle" ? json(route, 429, { message: "x" }, { "retry-after": "4" }) : route.fulfill({ status: 204 })
    });
    await page.goto(`/verify-email#token=${TOKEN}`);
    await expect(page.getByRole("alert")).toContainText("Could not reach the server");
    mode = "throttle";
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("alert")).toContainText("Too many attempts");
    await expect(page.getByRole("button", { name: /Try again in [1-4] s/ })).toBeDisabled();
    mode = "ok";
    await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled({ timeout: 10_000 });
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Your email address is confirmed")).toBeVisible();
    expect(posts(seen, "/auth/email/verify").every((c) => c.body.token === TOKEN)).toBe(true);
  });
});

test.describe("sign in and registration hints", () => {
  test("login links to forgot password and offers a resend after a refused sign-in only", async ({ page }) => {
    const { seen } = await setup(page, {
      "POST /auth/login": (route) => json(route, 401, { message: "Invalid credentials or tenant" }),
      "POST /auth/email/resend": (route) => json(route, 202, ACCEPTED)
    });
    await page.goto("/login/customer");
    await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveAttribute("href", "/forgot-password");
    await expect(page.getByRole("button", { name: "Resend verification email" })).toHaveCount(0);
    await page.getByLabel("Email address").fill("new@example.test");
    await page.getByLabel("Password", { exact: true }).fill("whatever-password-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Invalid credentials" })).toBeVisible();
    await expect(page.getByText("If your account is new")).toBeVisible();
    await page.getByRole("button", { name: "Resend verification email" }).click();
    await expect(page.locator(".credential-resend input[type=email]")).toHaveValue("new@example.test");
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    await expect(page.getByRole("status").filter({ hasText: "If this address has an account" })).toBeVisible();
    expect(posts(seen, "/auth/email/resend")[0]?.body).toEqual({ email: "new@example.test" });
    await axeClean(page);
  });

  test("a network failure at sign-in does not show the resend hint", async ({ page }) => {
    await setup(page, { "POST /auth/login": (route) => route.abort("failed") });
    await page.goto("/login/customer");
    await page.getByLabel("Email address").fill("a@example.test");
    await page.getByLabel("Password", { exact: true }).fill("whatever-password-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("Could not reach the server");
    await expect(page.getByRole("button", { name: "Resend verification email" })).toHaveCount(0);
  });

  test("registration ends in a check-your-email state with a resend action, not a signed-in session", async ({ page }) => {
    const { seen } = await setup(page, {
      "POST /auth/register/customer": (route) => json(route, 201, { message: "any server text is not shown" }),
      "POST /auth/email/resend": (route) => json(route, 202, ACCEPTED)
    });
    await page.goto("/register/customer");
    await page.getByLabel("Full name").fill("New Traveler");
    await page.getByLabel("Email address").fill("new@example.test");
    await page.locator('input[autocomplete="new-password"]').fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Create my account" }).click();
    const done = page.getByRole("status").filter({ hasText: "Check your email" });
    await expect(done).toBeFocused();
    await expect(done).toContainText("Confirm it, then sign in");
    await expect(page.getByText("any server text is not shown")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Continue to sign in" })).toBeVisible();
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    await expect(page.getByText("If this address has an account that is not confirmed yet")).toBeVisible();
    expect(posts(seen, "/auth/email/resend")[0]?.body).toEqual({ email: "new@example.test" });
    expect(posts(seen, "/auth/login")).toHaveLength(0);
    await axeClean(page);
  });
});

test("the credential pages are public (no redirect to sign in) and Arabic renders RTL", async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => { try { window.localStorage.setItem("safry.language", "ar"); } catch { /* ignore */ } });
  for (const path of ["/forgot-password", "/reset-password", "/verify-email"]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  }
  await page.goto("/forgot-password");
  await expect(page.getByRole("heading", { name: "نسيت كلمة المرور؟" })).toBeVisible();
});
