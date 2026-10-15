import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { bindSystemScope } from "../context/request-context.js";
import type { AuthUser } from "./auth-user.js";

/** Stable machine code returned with the 403 so clients can send the administrator to the 2FA wizard. */
export const MFA_ENROLLMENT_REQUIRED = "mfa_enrollment_required";

/**
 * Platform-level routes: verifies the administrator, requires an enrolled second factor, then opts the
 * request into cross-tenant scope. An administrator without MFA can still sign in and enrol (the /auth/mfa
 * endpoints are not behind this guard) but reaches no platform route until enrolled.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user?.isPlatformAdmin) throw new ForbiddenException("هذه الواجهة مخصصة لمدير النظام فقط");
    if (!user.mfaEnabled)
      throw new ForbiddenException({
        code: MFA_ENROLLMENT_REQUIRED,
        message: "فعّل المصادقة متعددة العوامل لحسابك قبل استخدام واجهات مدير النظام"
      });
    bindSystemScope();
    return true;
  }
}
