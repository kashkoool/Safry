import { BadRequestException, Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The x-tenant-id header is only an assertion by the client. It is validated for shape here
 * and compared with the tenant inside the verified JWT by JwtStrategy; it is never used to
 * select the database scope.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction): void {
    const tenantId = request.header("x-tenant-id");
    if (tenantId && !UUID_PATTERN.test(tenantId)) {
      throw new BadRequestException("x-tenant-id must be a valid UUID");
    }
    next();
  }
}
