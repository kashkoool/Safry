import { expect, test, type Page, type Route } from "@playwright/test";
import { seedSessionHint, useEnglish } from "./helpers";

// Fully mocked API (no backend needed): lists follow the X-Next-Cursor header the API returns.
const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
const traveler = { userId: "u1", tenantId: "t1", membershipId: "m1", email: "t@example.test", roles: ["traveler"], permissions: ["tenant.read", "catalog.service.read", "booking.create", "booking.read"] };
const session = { accessToken: "AT", expiresIn: 900, idleTimeoutSeconds: 900, user: traveler };
const def = { label: "L", unit: "u", dateLabel: "D", fields: [] };
const workspace = {
  organization: null,
  providerDefinitions: Object.fromEntries(["UMRAH_COMPANY", "TRAVEL_COMPANY", "HOTEL", "TRANSPORT", "RESTAURANT", "VISA"].map((k) => [k, { label: k, categories: [], role: "r" }])),
  serviceDefinitions: Object.fromEntries(["FLIGHT", "HOTEL", "TRANSPORT", "TOUR", "OTHER", "UMRAH", "PACKAGE", "RESTAURANT", "VISA", "VISIT"].map((k) => [k, def]))
};
const tenant = { id: "t1", code: "safry", name: "Safry", status: "ACTIVE", settings: {}, createdAt: "", updatedAt: "" };
const service = (n: number) => ({
  id: `s${n}`, title: `Hotel number ${n}`, description: "d", category: "HOTEL", city: "Riyadh", priceCents: 10000, currency: "SAR",
  status: "ACTIVE", capacity: 10, details: {}, components: [],
  organization: { id: "o1", name: "Org", type: "HOTEL", status: "ACTIVE" }
});
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => service(from + i));

async function setup(page: Page, marketplace: (cursor: string | null) => { items: unknown[]; next?: string }) {
  await useEnglish(page);
  await seedSessionHint(page);
  const seen: Array<string | null> = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/v1", "");
    if (path === "/auth/refresh") return json(route, 200, session);
    if (path === "/providers/workspace") return json(route, 200, workspace);
    if (path === "/tenants/current") return json(route, 200, tenant);
    if (path === "/services/exchange-rates") return json(route, 200, { base: "USD", source: "t", fetchedAt: "", rates: {} });
    if (path === "/services/marketplace") {
      const cursor = url.searchParams.get("cursor");
      seen.push(cursor);
      expect(url.searchParams.get("offset")).toBeNull(); // keyset paging only
      const page = marketplace(cursor);
      return json(route, 200, page.items, page.next ? { "x-next-cursor": page.next } : {});
    }
    return json(route, 200, []);
  });
  return seen;
}

test("'Load more' follows the cursor and disappears when the server stops sending one", async ({ page }) => {
  const seen = await setup(page, (cursor) => cursor === null ? { items: range(1, 3), next: "c-2" } : { items: range(4, 5) });
  await page.goto("/workspace/marketplace");
  await expect(page.getByText("Hotel number 1")).toBeVisible();
  const more = page.getByRole("button", { name: "Load more" });
  await more.click();
  await expect(page.getByText("Hotel number 5")).toBeVisible();
  await expect(page.getByText("Hotel number 1")).toBeVisible(); // the first page is kept
  await expect(more).toHaveCount(0);
  expect(seen).toEqual([null, "c-2"]);
});

test("a full page with no cursor header shows no dead 'Load more' button", async ({ page }) => {
  // exactly 100 rows is the page size: the old length check would have offered a button that loads nothing
  await setup(page, () => ({ items: range(1, 100) }));
  await page.goto("/workspace/marketplace");
  await expect(page.getByText("Hotel number 100")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
});

test("a row that shows up in two pages is listed once, and a failed page keeps the list and reports it", async ({ page }) => {
  let failNext = true;
  await setup(page, (cursor) => cursor === null ? { items: range(1, 2), next: "c-2" } : { items: range(2, 3) });
  await page.route("**/api/v1/services/marketplace?*cursor=*", async (route) => {
    if (failNext) { failNext = false; return json(route, 429, { message: "ThrottlerException: Too Many Requests" }, { "retry-after": "5" }); }
    return route.fallback();
  });
  await page.goto("/workspace/marketplace");
  await expect(page.getByText("Hotel number 2")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("alert")).toContainText("Too many attempts");
  await expect(page.getByText("Hotel number 1")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Hotel number 3")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hotel number 2" })).toHaveCount(1);
});
