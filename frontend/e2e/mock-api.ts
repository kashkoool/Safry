import { type Page, type Route } from "@playwright/test";
import { seedSessionHint, useEnglish } from "./helpers";

export const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });

export const adminPermissions = [
  "tenant.read", "tenant.update", "identity.user.read", "identity.user.manage", "identity.role.manage", "audit.read",
  "catalog.service.read", "catalog.service.manage", "booking.read", "booking.create", "booking.manage"
];
export const tenantAdmin = { userId: "u-admin", tenantId: "t1", membershipId: "m-admin", email: "admin@example.test", roles: ["tenant-admin"], permissions: adminPermissions };
export const traveler = { userId: "u-trav", tenantId: "t1", membershipId: "m-trav", email: "trav@example.test", roles: ["traveler"], permissions: ["tenant.read", "catalog.service.read", "booking.read", "booking.create"] };
export const platformAdmin = { ...tenantAdmin, isPlatformAdmin: true };
export const tenantRecord = { id: "t1", code: "safry", name: "Safry Test", status: "ACTIVE", settings: {}, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-02T00:00:00.000Z", archivedAt: null };

export interface Call { method: string; path: string; search: string; body: Record<string, unknown> }
export type Handler = (call: Call, route: Route) => Promise<boolean> | boolean;

/** Fully mocked API: a resumed cookie session for `user`, the quiet defaults the workspace shell needs, and `handler` for the rest. */
export async function mockApi(page: Page, user: object, handler: Handler): Promise<{ calls: Call[] }> {
  await useEnglish(page);
  await seedSessionHint(page);
  const calls: Call[] = [];
  const session = { accessToken: "AT", expiresIn: 900, idleTimeoutSeconds: 900, user };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = request.method();
    const call: Call = { method, path, search: url.search, body: (method === "GET" ? {} : request.postDataJSON() ?? {}) as Record<string, unknown> };
    if (path === "/auth/refresh") return json(route, 200, session);
    if (path === "/auth/activity") return route.fulfill({ status: 204 });
    calls.push(call);
    if (await handler(call, route)) return;
    if (path === "/auth/mfa") return json(route, 200, { enabled: false, pendingSetup: false, recoveryCodesRemaining: 0, recoveryCodesRegenerationRequired: false });
    if (path === "/tenants/current") return json(route, 200, tenantRecord);
    if (path === "/providers/workspace") return json(route, 200, { organization: null, providerDefinitions: {}, serviceDefinitions: {} });
    if (path === "/services/exchange-rates") return json(route, 503, { message: "unavailable" });
    if (path === "/users/me/invitations") return json(route, 200, []);
    return json(route, 200, []);
  });
  return { calls };
}
