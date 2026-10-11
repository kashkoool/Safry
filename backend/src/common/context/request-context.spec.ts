import { describe, expect, it } from "vitest";
import { bindSystemScope, bindTenantScope, currentScope, requestContext, runAsSystem } from "./request-context.js";

describe("request scope", () => {
  it("has no scope outside a request or before authentication", () => {
    expect(currentScope()).toBeUndefined();
    requestContext.run({ requestId: "r1" }, () => expect(currentScope()).toBeUndefined());
  });

  it("binds the tenant of the verified principal to the request", () => {
    requestContext.run({ requestId: "r1" }, () => {
      bindTenantScope("tenant-1");
      expect(currentScope()).toEqual({ kind: "tenant", tenantId: "tenant-1" });
      bindSystemScope();
      expect(currentScope()).toEqual({ kind: "system" });
    });
  });

  it("ignores binding calls made outside a request", () => {
    expect(() => bindTenantScope("tenant-1")).not.toThrow();
    expect(currentScope()).toBeUndefined();
  });

  it("runs a callback in system scope without changing the surrounding scope", async () => {
    await requestContext.run({ requestId: "r1", scope: { kind: "tenant", tenantId: "tenant-1" } }, async () => {
      const inside = await runAsSystem(() => Promise.resolve(currentScope()));
      expect(inside).toEqual({ kind: "system" });
      expect(currentScope()).toEqual({ kind: "tenant", tenantId: "tenant-1" });
    });
  });

  it("works without an enclosing request (background jobs)", async () => {
    expect(await runAsSystem(() => Promise.resolve(currentScope()))).toEqual({ kind: "system" });
  });

  it("starts lazy work inside the scope (Prisma promises run when first awaited)", async () => {
    const lazy = { then: <T>(resolve: (value: unknown) => T): T => resolve(currentScope()) } as PromiseLike<unknown>;
    expect(await runAsSystem(() => lazy)).toEqual({ kind: "system" });
  });
});
