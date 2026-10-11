import { describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../security/auth-user.js";
import { InMemoryAuthPrincipalCache, principalKey, type PrincipalMeta } from "./auth-principal-cache.js";
import { invalidationFor } from "./auth-principal-invalidation.js";

const meta = (n: number, tenantId = "t1"): PrincipalMeta => ({ sessionId: `s${n}`, userId: `u${n}`, membershipId: `m${n}`, tenantId });
const user = (n: number): AuthUser => ({ userId: `u${n}`, tenantId: "t1", membershipId: `m${n}`, email: "a@b.c", roles: [], permissions: ["x"] });

describe("InMemoryAuthPrincipalCache", () => {
  it("serves a hit without calling the loader again", async () => {
    const cache = new InMemoryAuthPrincipalCache(5000, 100);
    const loader = vi.fn(() => Promise.resolve(user(1)));
    const key = principalKey(meta(1), 0);
    await cache.getOrLoad(key, meta(1), loader);
    await cache.getOrLoad(key, meta(1), loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it("returns a copy so a caller can not poison the cached principal", async () => {
    const cache = new InMemoryAuthPrincipalCache(5000, 100);
    const key = principalKey(meta(1), 0);
    const first = await cache.getOrLoad(key, meta(1), () => Promise.resolve(user(1)));
    first.permissions.push("admin.everything");
    expect((await cache.getOrLoad(key, meta(1), () => Promise.resolve(user(1)))).permissions).toEqual(["x"]);
  });

  it("never caches a failed load and expires after the TTL", async () => {
    vi.useFakeTimers();
    try {
      const cache = new InMemoryAuthPrincipalCache(1000, 100);
      const key = principalKey(meta(1), 0);
      await expect(cache.getOrLoad(key, meta(1), () => Promise.reject(new Error("401")))).rejects.toThrow("401");
      const loader = vi.fn(() => Promise.resolve(user(1)));
      await cache.getOrLoad(key, meta(1), loader);
      vi.advanceTimersByTime(1001);
      await cache.getOrLoad(key, meta(1), loader);
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps tenants apart: the tenant id is part of the key", () => {
    expect(principalKey(meta(1, "t1"), 0)).not.toBe(principalKey(meta(1, "t2"), 0));
  });

  it("invalidates by session, user, tenant and all", async () => {
    const cache = new InMemoryAuthPrincipalCache(5000, 100);
    const load = (n: number, tenantId = "t1"): Promise<AuthUser> => cache.getOrLoad(principalKey(meta(n, tenantId), 0), meta(n, tenantId), () => Promise.resolve(user(n)));
    await Promise.all([load(1), load(2), load(3, "t2")]);
    cache.invalidate({ sessionId: "s1" });
    expect(cache.stats().size).toBe(2);
    cache.invalidate({ userId: "u2" });
    expect(cache.stats().size).toBe(1);
    cache.invalidate({ tenantId: "t2" });
    expect(cache.stats().size).toBe(0);
    await load(1);
    cache.invalidate("all");
    expect(cache.stats().size).toBe(0);
  });

  it("does not store a value whose load raced with an invalidation", async () => {
    const cache = new InMemoryAuthPrincipalCache(5000, 100);
    const key = principalKey(meta(1), 0);
    let release!: () => void;
    const slow = cache.getOrLoad(key, meta(1), () => new Promise<AuthUser>((resolve) => { release = (): void => resolve(user(1)); }));
    cache.invalidate({ sessionId: "s1" });
    release();
    await slow;
    expect(cache.stats().size).toBe(0);
  });

  it("evicts the least recently used entry beyond the limit and is disabled by ttl 0", async () => {
    const cache = new InMemoryAuthPrincipalCache(5000, 2);
    for (const n of [1, 2, 3]) await cache.getOrLoad(principalKey(meta(n), 0), meta(n), () => Promise.resolve(user(n)));
    expect(cache.stats().size).toBe(2);
    const off = new InMemoryAuthPrincipalCache(0, 2);
    const loader = vi.fn(() => Promise.resolve(user(1)));
    await off.getOrLoad("k", meta(1), loader);
    await off.getOrLoad("k", meta(1), loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("invalidationFor", () => {
  it("ignores models that never feed the principal and read operations", () => {
    expect(invalidationFor("Booking", "update", { where: { id: "b" } })).toBeUndefined();
    expect(invalidationFor("User", "findMany", {})).toBeUndefined();
  });
  it("ignores session creation and last-activity touches but not revocation", () => {
    expect(invalidationFor("RefreshSession", "create", { data: {} })).toBeUndefined();
    expect(invalidationFor("RefreshSession", "updateMany", { where: { id: "s" }, data: { lastUsedAt: new Date() } })).toBeUndefined();
    expect(invalidationFor("RefreshSession", "updateMany", { where: { id: "s" }, data: { revokedAt: new Date() } })).toEqual({ sessionId: "s" });
    expect(invalidationFor("RefreshSession", "updateMany", { where: { userId: "u", revokedAt: null }, data: { revokedAt: new Date() } })).toEqual({ userId: "u" });
  });
  it("narrows by the most specific key and falls back to flushing everything", () => {
    expect(invalidationFor("User", "update", { where: { id: "u" }, data: { authVersion: 2 } })).toEqual({ userId: "u" });
    expect(invalidationFor("User", "update", { where: { emailNormalized: "a@b" }, data: {} })).toBe("all");
    expect(invalidationFor("TenantMembership", "update", { where: { id: "m" }, data: { status: "SUSPENDED" } })).toEqual({ membershipId: "m" });
    expect(invalidationFor("MembershipRole", "deleteMany", { where: { membershipId: "m" } })).toEqual({ membershipId: "m" });
    expect(invalidationFor("MembershipRole", "create", { data: { membershipId: "m", roleId: "r" } })).toEqual({ membershipId: "m" });
    expect(invalidationFor("Role", "update", { where: { id: "r", tenantId: "t" }, data: {} })).toEqual({ tenantId: "t" });
    expect(invalidationFor("RolePermission", "deleteMany", { where: { roleId: "r" } })).toBe("all");
    expect(invalidationFor("Tenant", "update", { where: { id: "t" }, data: { status: "SUSPENDED" } })).toEqual({ tenantId: "t" });
  });
});
