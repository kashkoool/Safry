import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Origin check behind a TLS-terminating proxy (nginx: `Host $http_host`, `X-Forwarded-Proto`), with TRUST_PROXY on: the
 * request's own origin is https://<host>, so an http:// Origin for the same host is another origin and is refused.
 * Without TRUST_PROXY the app only sees http (covered in auth-cookie.int.spec.ts).
 */
describe("same-origin check behind a trusted proxy", () => {
  const COOKIE = "safry_rt";
  const web = { "x-client": "web", "x-requested-with": "XMLHttpRequest" };
  let publicHost = "";
  let world: World;
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    world = await World.start({ TRUST_PROXY: "1" });
    publicHost = new URL(world.baseUrl).host; // the test client cannot override Host: the same host as the proxy would forward
    tenant = await world.createTenant("origin-proxy");
    user = await world.createUser(tenant, { roles: ["traveler"] });
  });
  afterAll(async () => {
    await world.stop();
  });

  it("accepts https://<host> and refuses http://<host> when the proxy says the browser used https", async () => {
    const login = await world.api("POST", "/auth/login", { headers: { ...web }, body: { email: user.email, password: user.password, tenantCode: tenant.code } });
    let value = login.cookies.find((c) => c.startsWith(`${COOKIE}=`))!.split(";")[0]!.slice(COOKIE.length + 1);
    const proxied = { ...web, "x-forwarded-proto": "https" };
    const refresh = (origin: string) => world.api("POST", "/auth/refresh", { headers: { ...proxied, origin, cookie: `${COOKIE}=${value}` } });
    expect((await refresh(`http://${publicHost}`)).status).toBe(403);
    expect((await refresh(`https://${publicHost}:8443`)).status).toBe(403);
    expect((await refresh("https://evil.example.test")).status).toBe(403);
    const ok = await refresh(`https://${publicHost}`);
    expect(ok.status).toBe(200);
    value = ok.cookies.find((c) => c.startsWith(`${COOKIE}=`))!.split(";")[0]!.slice(COOKIE.length + 1);
  });
});
