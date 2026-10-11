import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { REQUIRED_PERMISSIONS_KEY } from "./permissions.decorator.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import type { AuthUser } from "./auth-user.js";

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]))
      return true;
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (!required?.length) return true;
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user || required.some((permission) => !user.permissions.includes(permission))) {
      throw new ForbiddenException("Missing required permission");
    }
    return true;
  }
}
