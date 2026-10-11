import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { CurrentUser } from "../../../common/security/current-user.decorator.js";
import { PlatformAdminGuard } from "../../../common/security/platform-admin.guard.js";
import { RequirePermissions } from "../../../common/security/permissions.decorator.js";
import { CreateTenantDto, TenantStatusDto, UpdateTenantDto } from "./dto/tenants.dto.js";
import { TenantsService } from "./tenants.service.js";

@ApiTags("identity / tenants")
@ApiBearerAuth()
@Controller("tenants")
export class TenantController {
  constructor(private readonly tenants: TenantsService) {}

  @Get("current")
  @RequirePermissions("tenant.read")
  current(@CurrentUser() user: AuthUser): Promise<object> {
    return this.tenants.current(user);
  }

  @Patch("current")
  @RequirePermissions("tenant.update")
  update(@CurrentUser() user: AuthUser, @Body() input: UpdateTenantDto): Promise<object> {
    return this.tenants.updateCurrent(user, input);
  }
}

/** Platform-level tenant lifecycle. Only platform administrators; runs in explicit cross-tenant scope. */
@ApiTags("platform administration / tenants")
@ApiBearerAuth()
@UseGuards(PlatformAdminGuard)
@Controller("platform/tenants")
export class PlatformTenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  list(): Promise<object[]> {
    return this.tenants.list();
  }

  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() input: CreateTenantDto): Promise<object> {
    return this.tenants.create(actor, input);
  }

  @Post(":id/status")
  status(
    @CurrentUser() actor: AuthUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: TenantStatusDto
  ): Promise<object> {
    return this.tenants.setStatus(actor, id, input);
  }

  @Get(":id/activity")
  activity(@Param("id", ParseUUIDPipe) id: string): Promise<object[]> {
    return this.tenants.activity(id);
  }
}
