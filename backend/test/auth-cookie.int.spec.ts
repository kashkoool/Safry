import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Reply, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Cookie model: on the web the refresh token lives in an HttpOnly cookie (never in a body); native clients
 * opt in with `X-Client: mobile` and keep the body model..
 */
describe("refresh-token cookie (web) and body (native)", () => {
  const COOKIE = "safry_rt"; // non-production name; production is __Secure-safry_rt (unit-tested)
  const web = { "x-client": "web", "x-requested-with": "XMLHttpRequest" };
  let world: World;
  let tenant: TestTenant;
  let user: TestUser;

  const setCookie = (reply: Reply): string => {
    const header = reply.cookies.find((value) => value.startsWith(`${COOKIE}=`));
    if (!header) throw new Error(`no ${COOKIE} Set-Cookie in ${JSON.stringify(reply.cookies)}`);
    return header;
  };
  const cookieValue = (reply: Reply): string => setCookie(reply).split(";")[0]!.slice(COOKIE.length + 1);
  const cookieHeader = (value: string): Record<string, string> => ({ cookie: `${COOKIE}=${value}` });
  const webLogin = (extra: Record<string, string> = {}): Promise<Reply> =>
    world.api("POST", "/auth/login", {
      headers: { ...web, ...extra },
      body: { email: user.email, password: user.password, tenantCode: tenant.code }
    });
  const webRefresh = (value: string, headers: Record<string, string> = web, body?: unknown): Promise<Reply> =>
    world.api("POST", "/auth/refresh", { headers: { ...headers, ...cookieHeader(value) }, ...(body === undefined ? {} : { body }) });
  const webLogout = (value: string, headers: Record<string, string> = web): Promise<Reply> =>
    world.api("POST", "/auth/logout", { headers: { ...headers, ...cookieHeader(value) } });

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("cookie");
    user = await world.createUser(tenant, { roles: ["traveler"] });
  });

  afterAll(async () => {
    await world.stop();
  });

  describe("login", () => {
    it("sets the refresh token as an HttpOnly, SameSite=Strict, path-scoped cookie and never returns it in the body", async () => {
      const reply = await webLogin();
      expect(reply.status).toBe(200);
      expect(reply.body.accessToken).toEqual(expect.any(String));
      expect(reply.body.refreshToken).toBeUndefined();
      expect(reply.body.refreshExpiresAt).toBeUndefined();
      expect(JSON.stringify(reply.body)).not.toContain(cookieValue(reply));
      const header = setCookie(reply);
      expect(header).toMatch(/;\s*HttpOnly/i);
      expect(header).toMatch(/;\s*SameSite=Strict/i);
      expect(header).toMatch(/;\s*Path=\/api\/v1\/auth(;|$)/i);
      expect(header).not.toMatch(/;\s*Domain=/i);
      // Outside production the Secure flag is off so plain-http local development works.
      expect(header).not.toMatch(/;\s*Secure/i);
      const maxAge = Number(/Max-Age=(\d+)/i.exec(header)?.[1]);
      expect(maxAge).toBeGreaterThan(0);
      expect(maxAge).toBeLessThanOrEqual(24 * 3600); // never beyond the 24 h absolute lifetime
      expect(cookieValue(reply).length).toBeGreaterThanOrEqual(32);
    });

    it("keeps the server side hash-only: the cookie value is not stored", async () => {
      const reply = await webLogin();
      const value = cookieValue(reply);
      const stored = await world.sql.query(`SELECT count(*)::int AS n FROM refresh_sessions WHERE "tokenHash" = $1`, [value]);
      expect(stored.rows[0].n).toBe(0);
    });

    it("refuses a disallowed Origin before touching credentials", async () => {
      const reply = await webLogin({ origin: "https://evil.example" });
      expect(reply.status).toBe(403);
      expect(reply.cookies).toEqual([]);
    });
  });

  describe("refresh", () => {
    it("rotates the cookie, returns an access token and no refresh token in the body", async () => {
      const login = await webLogin();
      const reply = await webRefresh(cookieValue(login));
      expect(reply.status).toBe(200);
      expect(reply.body.accessToken).toEqual(expect.any(String));
      expect(reply.body.refreshToken).toBeUndefined();
      expect(cookieValue(reply)).not.toBe(cookieValue(login));
      // The rotated cookie never outlives the original absolute lifetime.
      const first = Number(/Max-Age=(\d+)/i.exec(setCookie(login))?.[1]);
      expect(Number(/Max-Age=(\d+)/i.exec(setCookie(reply))?.[1])).toBeLessThanOrEqual(first);
    });

    it("rejects a request without the CSRF header with 403 and leaves the session usable", async () => {
      const login = await webLogin();
      const value = cookieValue(login);
      const noHeader = await webRefresh(value, { "x-client": "web" });
      expect(noHeader.status).toBe(403);
      expect(noHeader.cookies).toEqual([]);
      const wrongValue = await webRefresh(value, { "x-client": "web", "x-requested-with": "fetch" });
      expect(wrongValue.status).toBe(403);
      expect((await webRefresh(value)).status).toBe(200);
    });

    it("rejects a present-but-foreign Origin (and Origin: null) with 403, accepts configured and same-origin ones", async () => {
      const value = cookieValue(await webLogin());
      for (const origin of ["https://evil.example", "null", "http://localhost:3001.evil.example"]) {
        expect((await webRefresh(value, { ...web, origin })).status, origin).toBe(403);
      }
      // Default development CORS origin is allowed; a request with no Origin (curl, server-side) is not a browser CSRF.
      const configured = await webRefresh(value, { ...web, origin: "http://localhost:3001" });
      expect(configured.status).toBe(200);
      const host = new URL(world.baseUrl).host;
      const sameOrigin = await webRefresh(cookieValue(configured), { ...web, origin: `http://${host}` });
      expect(sameOrigin.status).toBe(200);
      // the same host over another scheme is another origin (this app is served over http here).
      expect((await webRefresh(cookieValue(sameOrigin), { ...web, origin: `https://${host}` })).status).toBe(403);
      expect((await webRefresh(cookieValue(sameOrigin), { ...web, origin: `http://${new URL(world.baseUrl).hostname}:1` })).status).toBe(403);
      expect((await webRefresh(cookieValue(sameOrigin), { ...web, origin: `http://${host}` })).status).toBe(200);
    });

    it("treats two cookies with the refresh-cookie name as an invalid request and consumes nothing", async () => {
      const value = cookieValue(await webLogin());
      const planted = "p".repeat(64);
      for (const cookie of [`${COOKIE}=${planted}; ${COOKIE}=${value}`, `${COOKIE}=${value}; ${COOKIE}=${planted}`]) {
        const reply = await world.api("POST", "/auth/refresh", { headers: { ...web, cookie } });
        expect(reply.status, cookie.slice(0, 20)).toBe(401);
        expect(reply.cookies, "must not clear or set any cookie").toEqual([]);
      }
      expect((await webRefresh(value)).status).toBe(200); // the real token was not consumed or revoked
    });

    it("ignores a refresh token in the body in browser mode (cookie is the only source)", async () => {
      const native = await world.session(user); // body model
      const reply = await world.api("POST", "/auth/refresh", { headers: web, body: { refreshToken: native.refreshToken } });
      expect(reply.status).toBe(401);
      // ... and the unused body token was not consumed.
      expect((await world.api("POST", "/auth/refresh", { body: { refreshToken: native.refreshToken } })).status).toBe(200);
    });

    it("answers 401 for a missing, malformed or unknown cookie", async () => {
      expect((await world.api("POST", "/auth/refresh", { headers: web })).status).toBe(401);
      expect((await webRefresh("short")).status).toBe(401);
      expect((await webRefresh("x".repeat(64))).status).toBe(401);
    });

    it("a stolen old cookie replayed after the grace window revokes the whole family", async () => {
      const login = await webLogin();
      const rotated = await webRefresh(cookieValue(login));
      expect(rotated.status).toBe(200);
      await world.sql.query(`UPDATE refresh_sessions SET "revokedAt" = now() - interval '30 seconds' WHERE "userId" = $1 AND "revokedAt" IS NOT NULL`, [user.userId]);
      expect((await webRefresh(cookieValue(login))).status).toBe(401);
      expect((await webRefresh(cookieValue(rotated))).status).toBe(401); // family dead, the legitimate holder must sign in again
    });

    it("two tabs sharing one cookie: a concurrent loser inside the 10 s grace gets 401 without killing the family; a later retry with the new cookie works", async () => {
      const login = await webLogin();
      const value = cookieValue(login);
      const replies = await Promise.all([webRefresh(value), webRefresh(value)]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 401]);
      const winner = replies.find((reply) => reply.status === 200)!;
      const loser = replies.find((reply) => reply.status === 401)!;
      expect(loser.cookies).toEqual([]); // must not clear/overwrite the cookie the winner just set
      expect((await webRefresh(cookieValue(winner))).status).toBe(200);
    });
  });

  describe("logout", () => {
    it("clears the cookie with matching scope and kills the session: the old cookie cannot refresh", async () => {
      const login = await webLogin();
      const value = cookieValue(login);
      const out = await webLogout(value);
      expect(out.status).toBe(204);
      const cleared = setCookie(out);
      expect(cleared).toMatch(new RegExp(`^${COOKIE}=;`));
      expect(cleared).toMatch(/Path=\/api\/v1\/auth/i);
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/i);
      expect(cleared).toMatch(/;\s*HttpOnly/i);
      expect((await webRefresh(value)).status).toBe(401);
    });

    it("needs the CSRF header and an allowed Origin; a rejected request ends nothing", async () => {
      const value = cookieValue(await webLogin());
      expect((await webLogout(value, { "x-client": "web" })).status).toBe(403);
      expect((await webLogout(value, { ...web, origin: "https://evil.example" })).status).toBe(403);
      expect((await webRefresh(value)).status).toBe(200);
    });

    it("is idempotent without a cookie", async () => {
      const out = await world.api("POST", "/auth/logout", { headers: web });
      expect(out.status).toBe(204);
    });
  });

  describe("native clients (X-Client: mobile)", () => {
    it("get the refresh token in the body and never a cookie", async () => {
      const reply = await world.login(user); // world.api defaults to x-client: mobile
      expect(reply.status).toBe(200);
      expect(reply.body.refreshToken).toEqual(expect.any(String));
      expect(reply.body.refreshExpiresAt).toBeUndefined();
      expect(reply.cookies).toEqual([]);
    });

    it("never read the cookie: a stolen cookie plus the opt-in header cannot be exchanged for a body token (XSS cannot downgrade)", async () => {
      const value = cookieValue(await webLogin());
      const reply = await world.api("POST", "/auth/refresh", { headers: { "x-client": "mobile", ...cookieHeader(value) } });
      expect(reply.status).toBe(401);
      expect(reply.body.refreshToken).toBeUndefined();
      expect((await webRefresh(value)).status).toBe(200); // cookie untouched
    });
  });

  describe("CORS with credentials", () => {
    const preflight = (origin: string): Promise<Response> =>
      fetch(`${world.baseUrl}/auth/refresh`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "x-requested-with,content-type" }
      });

    it("allows credentials only for the exact configured origin, never a wildcard", async () => {
      const ok = await preflight("http://localhost:3001");
      expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3001");
      expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
      expect(ok.headers.get("access-control-allow-headers")).toMatch(/x-requested-with/i);
      const bad = await preflight("https://evil.example");
      expect(bad.headers.get("access-control-allow-origin")).toBeNull();
      // (the cors middleware still prints Allow-Credentials, but without a matching Allow-Origin a browser refuses the response)
      expect(bad.headers.get("access-control-allow-origin")).not.toBe("*");
    });
  });
});
