import { SetMetadata } from "@nestjs/common";

export const REQUIRED_PERMISSIONS_KEY = "requiredPermissions";
export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
