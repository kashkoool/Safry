import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { bindSystemScope } from "../context/request-context.js";
import type { AuthUser } from "./auth-user.js";

/** Platform-level routes: verifies the administrator, then opts the request into cross-tenant scope. */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!context.switchToHttp().getRequest<{ user?: AuthUser }>().user?.isPlatformAdmin)
      throw new ForbiddenException("هذه الواجهة مخصصة لمدير النظام فقط");
    bindSystemScope();
    return true;
  }
}
