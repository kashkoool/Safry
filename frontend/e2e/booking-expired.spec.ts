import { expect, test } from "@playwright/test";
import { json, mockApi, tenantAdmin } from "./mock-api";

// Fully mocked API (no backend needed). An unconfirmed pending booking that timed out is reported as CANCELLED with expired: true,
// and confirming one is refused with BOOKING_EXPIRED. The screen must say so in both languages.
const EXPIRED_AR = "انتهت صلاحية الحجز المعلق وتم إلغاؤه؛ أنشئ حجزاً جديداً";
const EXPIRED_EN = "This pending booking expired and was cancelled; create a new booking";
const service = {
  id: "s1", title: "Test hotel", description: "d", category: "HOTEL", city: "Riyadh", priceCents: 10000, currency: "SAR",
  status: "ACTIVE", capacity: 10, details: {}, components: [],
  organization: { id: "o1", name: "Org", type: "HOTEL", status: "ACTIVE" }
};
const booking = (over: Record<string, unknown>) => ({
  id: "b1", travelersCount: 1, totalCents: 10000, unitPriceCents: 10000, units: 1, serviceDate: "2030-01-10T00:00:00.000Z", endDate: null,
  currency: "SAR", status: "PENDING", createdAt: "2029-12-01T00:00:00.000Z", service,
  traveler: { user: { displayName: "Test Traveler", email: "trav@example.test" } }, ...over
});

for (const language of ["en", "ar"] as const) {
  test(`an expired booking is shown as expired and confirming it explains why (${language})`, async ({ page }) => {
    let expiredNow = false;
    const { calls } = await mockApi(page, tenantAdmin, async (call, route) => {
      if (call.method === "GET" && call.path === "/bookings") {
        json(route, 200, [booking(expiredNow ? { status: "CANCELLED", expired: true } : {})]);
        return true;
      }
      if (call.method === "PATCH" && call.path === "/bookings/b1/status") {
        expiredNow = true; // it timed out while the page was open
        json(route, 409, { message: EXPIRED_AR, code: "BOOKING_EXPIRED" });
        return true;
      }
      return false;
    }, language);
    await page.goto("/workspace/bookings");
    const row = page.locator(".booking-row");
    await expect(row).toHaveCount(1);
    const expiredLabel = language === "en" ? "Expired" : "انتهت المهلة";
    await expect(row.locator(".booking-status")).not.toHaveText(expiredLabel);

    const confirm = row.getByRole("button", { name: language === "en" ? "Confirm" : "تأكيد" });
    await confirm.click();
    await expect(page.getByRole("alert")).toContainText(language === "en" ? EXPIRED_EN : EXPIRED_AR);
    expect(calls.some((c) => c.method === "PATCH" && c.path === "/bookings/b1/status" && c.body.status === "CONFIRMED")).toBe(true);

    // The list was reloaded: the booking now reads as expired and offers no confirm or edit.
    await expect(row.locator(".booking-status")).toHaveText(expiredLabel);
    await expect(row.locator(".booking-row__expired")).toBeVisible();
    await expect(row.getByRole("button", { name: language === "en" ? "Confirm" : "تأكيد" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: language === "en" ? "Edit" : "تعديل" })).toHaveCount(0);
  });
}
