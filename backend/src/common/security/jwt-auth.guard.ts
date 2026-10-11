import { Injectable, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { bindTenantScope } from "../context/request-context.js";
import type { AuthUser } from "./auth-user.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (isPublic) return true;
    const allowed = (await super.canActivate(context)) as boolean;
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    // The database scope comes only from the verified token/membership, never from request headers.
    if (allowed && user) bindTenantScope(user.tenantId);
    return allowed;
  }
}
