import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthUser } from "./auth-user.js";

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthUser => {
  return context.switchToHttp().getRequest<{ user: AuthUser }>().user;
});
