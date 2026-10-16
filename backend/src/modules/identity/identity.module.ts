import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { AccessController } from "./access/access.controller.js";
import { AccessService } from "./access/access.service.js";
import { AccountSecurityService } from "./auth/account-security.service.js";
import { AuthController } from "./auth/auth.controller.js";
import { RefreshRateLimit } from "./auth/refresh-rate-limit.js";
import { AuthService } from "./auth/auth.service.js";
import { CredentialService } from "./auth/credential.service.js";
import { JwtStrategy } from "./auth/jwt.strategy.js";
import { MfaService } from "./auth/mfa.service.js";
import { PlatformTenantsController, TenantController } from "./tenants/tenant.controller.js";
import { TenantsService } from "./tenants/tenants.service.js";
import { AccountLinkingService } from "./users/account-linking.service.js";
import { RegistrationService } from "./users/registration.service.js";
import { UsersController } from "./users/users.controller.js";
import { UsersService } from "./users/users.service.js";

/**
 * Identity:
 *  users/   User & Account Management
 *  auth/    Authentication & Login Management (lockout, MFA)
 *  access/  Roles & Permissions Management
 *  tenants/ Tenant Management
 */
@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AuthController, UsersController, AccessController, TenantController, PlatformTenantsController],
  providers: [
    AuthService,
    RefreshRateLimit,
    CredentialService,
    AccountSecurityService,
    MfaService,
    JwtStrategy,
    RegistrationService,
    AccountLinkingService,
    UsersService,
    AccessService,
    TenantsService
  ],
  exports: [AccountLinkingService, MfaService, CredentialService, AccountSecurityService]
})
export class IdentityModule {}
