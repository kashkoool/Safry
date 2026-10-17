import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const user = { userId: "u1", tenantId: "t1", membershipId: "m1", email: "a@example.test", roles: [], permissions: [] };
const pair = (token: string) => ({ accessToken: token, expiresIn: 900, user });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value))
  };
}

describe("a refresh in flight while the user signs out or in", () => {
  const calls: string[] = [];
  let finishRefresh: (response: Response) => void;

  beforeEach(() => {
    calls.length = 0;
    vi.resetModules();
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
    vi.stubGlobal("window", { dispatchEvent: () => true });
    vi.stubGlobal("navigator", {}); // no Web Locks: a never-settling refresh must not hold a process-wide lock across tests
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      const path = String(url).replace(/^.*\/auth\//, "");
      calls.push(path);
      if (path === "refresh") return new Promise<Response>((resolve) => { finishRefresh = resolve; });
      if (path === "login") return Promise.resolve(json(pair("new-token")));
      return Promise.resolve(new Response(null, { status: 204 }));
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sign-in waits for the pending refresh, so its cookie is the last one the server sets", async () => {
    const { api, restoreSession, getStoredUser } = await import("./api");
    const restoring = restoreSession();
    expect(calls).toEqual(["refresh"]);
    const signingIn = api.login({ email: "a@example.test", password: "x", portal: "customer" } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls, "login must not be sent while the refresh is still in flight").toEqual(["refresh"]);
    finishRefresh(json(pair("late-token")));
    await restoring;
    await signingIn;
    expect(calls).toEqual(["refresh", "login"]);
    expect(getStoredUser()?.userId).toBe("u1");
  });

  it("sign-out waits for the pending refresh and then ends the session with the cookie it set", async () => {
    const { api, restoreSession, getStoredUser } = await import("./api");
    const restoring = restoreSession();
    const signingOut = api.logout();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls, "logout must not be sent while the refresh is still in flight").toEqual(["refresh"]);
    finishRefresh(json(pair("late-token")));
    await restoring;
    await signingOut;
    expect(calls).toEqual(["refresh", "logout"]);
    expect(getStoredUser()).toBeNull();
  });

  it.each(["login", "logout"] as const)("a refresh that never settles releases %s after the 5 s cap", async (action) => {
    vi.useFakeTimers();
    try {
      const { api, restoreSession } = await import("./api");
      void restoreSession(); // its response is never delivered
      const run = action === "login"
        ? api.login({ email: "a@example.test", password: "x", portal: "customer" } as never)
        : api.logout();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls, "still waiting just before the cap").toEqual(["refresh"]);
      await vi.advanceTimersByTimeAsync(2);
      await run;
      expect(calls).toEqual(["refresh", action]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("without a refresh in flight, sign-in is sent at once", async () => {
    const { api } = await import("./api");
    await api.login({ email: "a@example.test", password: "x", portal: "customer" } as never);
    expect(calls).toEqual(["login"]);
  });
});
