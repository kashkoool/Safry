import { defineConfig, devices } from "@playwright/test";

// Environment (see frontend/README.md):
//   E2E_BASE_URL   the web app (default http://127.0.0.1:55526, served by `vite preview`)
//   E2E_API_URL    the API the app proxies /api to (default http://127.0.0.1:55516)
//   E2E_DEMO_PASSWORD / E2E_ADMIN_PASSWORD  the passwords given to the seed (never committed)
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:55526";
const apiURL = process.env.E2E_API_URL ?? "http://127.0.0.1:55516";
const port = new URL(baseURL).port || "80";

// Project sets (E2E_PROJECTS): "default" is what pull-request CI runs (Chromium, real stack).
// "browsers" adds Firefox and WebKit for the mocked specs only (weekly workflow), "visual" is the screenshot suite.
const set = process.env.E2E_PROJECTS ?? "default";
const needsRealStack = [/account-journey\.spec/, /credentials-real\.spec/, /tenant-admin-journey\.spec/, /journeys\.spec/];
const visualFiles = /visual\.shot\.ts$/;
const projects =
  set === "browsers"
    ? [
        { name: "firefox", use: { ...devices["Desktop Firefox"] }, testIgnore: [...needsRealStack, visualFiles] },
        { name: "webkit", use: { ...devices["Desktop Safari"] }, testIgnore: [...needsRealStack, visualFiles] }
      ]
    : set === "visual"
      ? [{ name: "visual", testMatch: visualFiles, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, timezoneId: "UTC", locale: "en-US" } }]
      : [{ name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: [visualFiles] }];

export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFileName}/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: { baseURL, trace: process.env.CI ? "on-first-retry" : "retain-on-failure", locale: "en-US" },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide" } },
  projects,
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: `npm run build && npx vite preview --host 127.0.0.1 --port ${port}`,
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
        env: { VITE_PROXY_TARGET: apiURL }
      }
});
