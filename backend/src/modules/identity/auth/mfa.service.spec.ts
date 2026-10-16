import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { MFA_ENROLLMENT_REQUIRED } from "../../../common/security/platform-admin.guard.js";
import type { PrismaService } from "../../../database/prisma.service.js";
import type { AccountSecurityService } from "./account-security.service.js";
import { MfaService } from "./mfa.service.js";

function build(account: { isPlatformAdmin: boolean; mfaEnabledAt: Date | null }): MfaService {
  const prisma = { user: { findUnique: () => Promise.resolve({ id: "u1", status: "ACTIVE", deletedAt: null, ...account }) } };
  const config = { get: () => undefined, getOrThrow: () => "unit-test-secret-with-more-than-32-characters" };
  return new MfaService(prisma as unknown as PrismaService, {} as AccountSecurityService, config as unknown as ConfigService);
}

const actor = { userId: "u1", tenantId: "t1" } as AuthUser;

describe("MfaService.stepUp for platform administrators", () => {
  it("refuses with 403 mfa_enrollment_required when no second factor is enrolled, even with the password", async () => {
    const service = build({ isPlatformAdmin: true, mfaEnabledAt: null });
    const failure = await service.stepUp(actor, "a-password", undefined).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ForbiddenException);
    expect((failure as ForbiddenException).getResponse()).toMatchObject({ code: MFA_ENROLLMENT_REQUIRED });
  });

  it("asks for the password first (401) when none is given", async () => {
    const service = build({ isPlatformAdmin: true, mfaEnabledAt: null });
    await expect(service.stepUp(actor, undefined, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
