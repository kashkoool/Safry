import { expect, test, type Page } from "@playwright/test";
import { useEnglish } from "./helpers";

// Fully mocked API (no backend needed): what a visitor sees when the page crashes, a route does not exist, or a lazy chunk is gone after a deploy.
const CHUNK = "**/assets/ForgotPasswordPage-*.js";
const copy = {
  en: { notFound: "Page not found", home: "Go to the home page", failed: "Something went wrong", reload: "Reload the page", form: "Forgot your password?" },
  ar: { notFound: "الصفحة غير موجودة", home: "العودة إلى الصفحة الرئيسية", failed: "حدث خطأ غير متوقع", reload: "إعادة تحميل الصفحة", form: "" }
} as const;

async function quietApi(page: Page): Promise<void> {
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "no session" }) })
  );
}

function countDocumentLoads(page: Page, path: string): () => number {
  let loads = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document" && new URL(request.url()).pathname === path) loads += 1;
  });
  return () => loads;
}

for (const language of ["en", "ar"] as const) {
  test.describe(`failure screens (${language})`, () => {
    const text = copy[language];

    test("an unknown address shows the translated not-found page, not a redirect", async ({ page }) => {
      await useEnglish(page, language);
      await quietApi(page);
      await page.goto("/no/such/page");
      await expect(page.getByRole("heading", { name: text.notFound })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/no/such/page");
      await expect(page.getByRole("link", { name: text.home })).toHaveAttribute("href", "/");
      await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
    });

    test("a page that crashes while rendering shows the fallback with a reload button and no error details", async ({ page }) => {
      await useEnglish(page, language);
      await quietApi(page);
      const logs: string[] = [];
      page.on("console", (message) => logs.push(message.text()));
      // The chunk loads but throws when it runs: the lazy import rejects with this error during render.
      await page.route(CHUNK, (route) =>
        route.fulfill({ status: 200, contentType: "text/javascript", body: 'throw new Error("secret-detail-4711");' })
      );
      await page.goto("/forgot-password");
      const alert = page.getByRole("alert");
      await expect(alert.getByRole("heading", { name: text.failed })).toBeVisible();
      await expect(alert.getByRole("button", { name: text.reload })).toBeVisible();
      expect(await page.locator("body").innerText()).not.toContain("secret-detail-4711");
      // The browser itself reports the uncaught error to the console; the application's own log line carries the class only.
      const own = logs.filter((line) => line.startsWith("Render failure"));
      expect(own).toHaveLength(1);
      expect(own[0]).not.toContain("secret-detail-4711");
    });

    test("a missing lazy chunk reloads the page once and recovers when the new build is there", async ({ page }) => {
      await useEnglish(page, language);
      await quietApi(page);
      const documentLoads = countDocumentLoads(page, "/forgot-password");
      let attempts = 0;
      // The first load asks for a chunk a deploy removed; after the reload the file exists again.
      await page.route(CHUNK, (route) => (++attempts === 1 ? route.abort() : route.continue()));
      await page.goto("/forgot-password");
      await expect.poll(documentLoads).toBe(2);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.locator("form")).toBeVisible();
      expect(await page.evaluate(() => window.sessionStorage.getItem("safry.chunk-reload"))).not.toBeNull();
    });

    test("a chunk that stays missing reloads only once, then shows the fallback instead of looping", async ({ page }) => {
      await useEnglish(page, language);
      await quietApi(page);
      const documentLoads = countDocumentLoads(page, "/forgot-password");
      await page.route(CHUNK, (route) => route.abort());
      await page.goto("/forgot-password");
      await expect(page.getByRole("alert").getByRole("heading", { name: text.failed })).toBeVisible();
      await page.waitForTimeout(1500);
      expect(documentLoads()).toBe(2);
    });
  });
}
