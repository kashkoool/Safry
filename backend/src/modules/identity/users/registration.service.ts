import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { runAsSystem } from "../../../common/context/request-context.js";
import { verifyPassword } from "../../../common/security/password.js";
import { PrismaService } from "../../../database/prisma.service.js";
import type { User } from "../../../generated/prisma/client.js";
import { providerDefinitions } from "../../travel-services/catalog.js";
import { AccountSecurityService } from "../auth/account-security.service.js";
import { CredentialService } from "../auth/credential.service.js";
import { AccountLinkingService } from "./account-linking.service.js";
import type { RegisterCustomerDto, RegisterProviderDto } from "./dto/register.dto.js";
import { isUniqueViolation } from "../../../common/filters/database-errors.js";

const REGISTRATION_REFUSED = "تعذر إكمال التسجيل بهذه البيانات";

/** User Account Creation (self-service registration). */
@Injectable()
export class RegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly linking: AccountLinkingService,
    private readonly security: AccountSecurityService,
    private readonly credentials: CredentialService
  ) {}

  private async tenantOf(tenantCode: string): Promise<string> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { code: tenantCode.trim().toLowerCase(), status: "ACTIVE" }, select: { id: true }
    });
    if (!tenant) throw new NotFoundException("الجهة غير موجودة أو غير متاحة");
    return tenant.id;
  }

  /**
   * The same e-mail may register in several tenants. An existing identity is linked to the new
   * tenant only after the registrant proves ownership with its current password. Those checks have
   * their own throttle ("register" scope), so they cannot be used to guess passwords and cannot
   * block the owner's sign-in. The refusal does not say whether or where the e-mail is registered.
   */
  private async proveOwnership(tenantId: string, emailInput: string, password: string, ipAddress: string | undefined): Promise<void> {
    const existing: User | null = await this.prisma.user.findUnique({
      where: { emailNormalized: emailInput.trim().toLowerCase() }
    });
    if (!existing) return;
    const attempt = await this.security.begin(existing.emailNormalized, ipAddress, "register");
    if (!attempt.allowed || !(await verifyPassword(existing.passwordHash, password))) {
      await this.security.recordFailure({
        userId: existing.id,
        tenantId,
        ipAddress,
        reason: attempt.allowed ? "bad_password_on_registration" : "throttled_registration"
      });
      throw new UnauthorizedException(REGISTRATION_REFUSED);
    }
    await this.security.succeed(existing.emailNormalized, ipAddress, "register");
    if (existing.mfaEnabledAt)
      throw new ConflictException("الحساب محمي بالمصادقة متعددة العوامل؛ اطلب من مدير الجهة إضافته");
  }

  private registrationError(error: unknown): never {
    if (isUniqueViolation(error))
      throw new ConflictException("البريد الإلكتروني مستخدم بالفعل في هذه الجهة");
    throw error;
  }

  /**
   * Closing sentence of a registration answer. A new (unverified) identity is mailed a confirmation link and must use it
   * before signing in; an existing, already verified identity that was linked to one more tenant can sign in at once.
   */
  private async confirmation(user: User | undefined, created: string): Promise<string> {
    if (user && user.emailVerifiedAt === null) {
      await this.credentials.sendVerification(user);
      return `${created} أرسلنا رابط تأكيد إلى بريدك الإلكتروني؛ أكّده ثم سجّل الدخول.`;
    }
    return `${created} يمكنك تسجيل الدخول الآن.`;
  }

  customer(input: RegisterCustomerDto, ipAddress?: string): Promise<{ message: string }> {
    return runAsSystem(async () => {
      const tenantId = await this.tenantOf(input.tenantCode);
      const role = await this.prisma.role.findUnique({ where: { tenantId_code: { tenantId, code: "traveler" } } });
      if (!role) throw new ConflictException("دور المسافر غير مهيأ لهذه الجهة");
      await this.proveOwnership(tenantId, input.email, input.password, ipAddress);
      let registered: User | undefined;
      try {
        registered = await this.prisma.$transaction(async (tx) => {
          const { user, linked } = await this.linking.resolve(tx, tenantId, input);
          const membership = await tx.tenantMembership.create({ data: {
            tenantId, userId: user.id, status: "ACTIVE", jobTitle: "مسافر"
          } });
          await tx.membershipRole.create({ data: { tenantId, membershipId: membership.id, roleId: role.id } });
          await tx.auditEvent.create({ data: {
            tenantId, actorUserId: user.id, action: "identity.customer.register",
            entityType: "membership", entityId: membership.id, metadata: { linkedExistingAccount: linked }
          } });
          return user;
        });
      } catch (error) { this.registrationError(error); }
      return { message: await this.confirmation(registered, "أُنشئ حساب المسافر.") };
    });
  }

  provider(input: RegisterProviderDto, ipAddress?: string): Promise<{ message: string }> {
    return runAsSystem(async () => {
      const tenantId = await this.tenantOf(input.tenantCode);
      const definition = providerDefinitions[input.type];
      const roles = await this.prisma.role.findMany({ where: {
        tenantId, code: { in: [definition.role, "organization-manager"] }
      } });
      if (roles.length !== 2) throw new ConflictException("أدوار مقدم الخدمة غير مهيأة لهذه الجهة");
      await this.proveOwnership(tenantId, input.email, input.password, ipAddress);
      const email = input.email.trim().toLowerCase();
      let registered: User | undefined;
      try {
        registered = await this.prisma.$transaction(async (tx) => {
          const organization = await tx.providerOrganization.create({ data: {
            tenantId, name: input.organizationName.trim(), nameAr: input.organizationName.trim(),
            nameEn: input.organizationNameEn.trim(), type: input.type,
            city: input.city.trim(), contactEmail: email, phone: input.phone.trim(),
            licenseNumber: input.licenseNumber.trim(), status: "SUSPENDED"
          } });
          const { user, linked } = await this.linking.resolve(tx, tenantId, input);
          const membership = await tx.tenantMembership.create({ data: {
            tenantId, userId: user.id, providerOrganizationId: organization.id,
            status: "ACTIVE", jobTitle: "مسؤول المنشأة"
          } });
          await tx.membershipRole.createMany({ data: roles.map((role) => ({
            tenantId, membershipId: membership.id, roleId: role.id
          })) });
          await tx.auditEvent.create({ data: {
            tenantId, actorUserId: user.id, action: "identity.provider.register",
            entityType: "provider_organization", entityId: organization.id,
            metadata: { status: "SUSPENDED", linkedExistingAccount: linked }
          } });
          return user;
        });
      } catch (error) { this.registrationError(error); }
      return { message: await this.confirmation(registered, "أُنشئ حساب الشركة وهو بانتظار تفعيل النشاط من إدارة الجهة.") };
    });
  }
}
