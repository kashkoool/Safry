import { describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { JwtStrategy } from "./jwt.strategy.js";
import type { PrismaService } from "../../../database/prisma.service.js";
import type { AuthPrincipalCache } from "../../../common/cache/auth-principal-cache.js";

/** the per-request principal lookup must not load password hashes or MFA secrets. */
describe("JwtStrategy principal lookup", () => {
  it("selects only the user columns it needs (no passwordHash, no mfaSecretEnc)", async () => {
    const membershipArgs: Array<{ include: { user: unknown } }> = [];
    const prisma = {
      refreshSession: { findFirst: vi.fn().mockResolvedValue({ id: "s", lastUsedAt: new Date(), createdAt: new Date() }) },
      tenantMembership: {
        findFirst: vi.fn().mockImplementation((args: { include: { user: unknown } }) => {
          membershipArgs.push(args);
          return Promise.resolve({
            providerOrganizationId: null,
            permissionOverrides: null,
            user: { email: "a@b.test", isPlatformAdmin: false, authVersion: 0 },
            roles: []
          });
        })
      }
    } as unknown as PrismaService;
    const cache = { getOrLoad: (_k: string, _m: unknown, load: () => Promise<unknown>) => load() } as unknown as AuthPrincipalCache;
    const config = { getOrThrow: () => "x".repeat(40), get: (_k: string, d: unknown) => d } as unknown as ConfigService;
    const strategy = new JwtStrategy(config, prisma, cache);
    const request = { header: () => undefined } as unknown as Request;
    const principal = await strategy.validate(request, { sid: "s", sub: "u", tid: "t", mid: "m", av: 0 } as never);
    expect(principal.email).toBe("a@b.test");
    const user = membershipArgs[0]?.include.user as { select?: Record<string, boolean> } | true;
    expect(user).not.toBe(true);
    const selected = Object.keys((user as { select: Record<string, boolean> }).select);
    expect(selected.sort()).toEqual(["authVersion", "email", "isPlatformAdmin"]);
  });
});
