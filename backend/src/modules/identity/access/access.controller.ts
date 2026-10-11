import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { CurrentUser } from "../../../common/security/current-user.decorator.js";
import { RequirePermissions } from "../../../common/security/permissions.decorator.js";
import { AccessService } from "./access.service.js";
import { AssignRolesDto, CreateRoleDto, UpdateRoleDto } from "./dto/access.dto.js";

@ApiTags("identity / roles and permissions")
@ApiBearerAuth()
@RequirePermissions("identity.role.manage")
@Controller()
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get("roles")
  roles(@CurrentUser() user: AuthUser): Promise<object[]> {
    return this.access.listRoles(user);
  }

  @Get("permissions")
  permissions(): Promise<Array<{ code: string; description: string | null }>> {
    return this.access.listPermissions();
  }

  @Post("roles")
  create(@CurrentUser() user: AuthUser, @Body() input: CreateRoleDto): Promise<object> {
    return this.access.createRole(user, input);
  }

  @Patch("roles/:id")
  update(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: UpdateRoleDto
  ): Promise<object> {
    return this.access.updateRole(user, id, input);
  }

  @Delete("roles/:id")
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.access.deleteRole(user, id);
  }

  @Put("memberships/:membershipId/roles")
  assign(
    @CurrentUser() user: AuthUser,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Body() input: AssignRolesDto
  ): Promise<object> {
    return this.access.assignRoles(user, membershipId, input);
  }

  @Get("access/audit")
  @RequirePermissions("audit.read")
  audit(@CurrentUser() user: AuthUser, @Query("limit") limit?: string): Promise<object[]> {
    return this.access.permissionAudit(user, limit ? Number.parseInt(limit, 10) || 100 : 100);
  }
}
