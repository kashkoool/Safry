import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { CurrentUser } from "../../../common/security/current-user.decorator.js";
import { RequirePermissions } from "../../../common/security/permissions.decorator.js";
import { CreateDepartmentDto, CreateEmployeeDto, CreateOrganizationRoleDto, SpecialtiesDto, UpdateDepartmentDto, UpdateEmployeeDto, UpdateOrganizationRoleDto } from "./dto/organization.dto.js";
import { OrganizationService } from "./organization.service.js";

@ApiBearerAuth()
@ApiTags("organization departments and employees")
@RequirePermissions("tenant.read")
@Controller("organizations/:organizationId")
export class OrganizationController {
  constructor(private readonly organizations: OrganizationService) {}

  @Get("management")
  overview(@CurrentUser() user: AuthUser, @Param("organizationId", ParseUUIDPipe) id: string): Promise<unknown> {
    return this.organizations.overview(user, id);
  }

  @Patch("specialties")
  specialties(@CurrentUser() user: AuthUser, @Param("organizationId", ParseUUIDPipe) id: string,
    @Body() input: SpecialtiesDto): Promise<unknown> {
    return this.organizations.setSpecialties(user, id, input);
  }

  @Post("departments")
  createDepartment(@CurrentUser() user: AuthUser, @Param("organizationId", ParseUUIDPipe) id: string,
    @Body() input: CreateDepartmentDto): Promise<unknown> {
    return this.organizations.createDepartment(user, id, input);
  }

  @Patch("departments/:departmentId")
  updateDepartment(@CurrentUser() user: AuthUser, @Param("organizationId", ParseUUIDPipe) id: string,
    @Param("departmentId", ParseUUIDPipe) departmentId: string, @Body() input: UpdateDepartmentDto): Promise<unknown> {
    return this.organizations.updateDepartment(user, id, departmentId, input);
  }

  @Post("roles")
  createRole(@CurrentUser() user: AuthUser, @Param("organizationId", ParseUUIDPipe) id: string,
    @Body() input: CreateOrganizationRoleDto): Promise<unknown> {
    return this.organizations.createRole(user, id, input);
  }

  @Patch("roles/:roleId")
  updateRole(@CurrentUser() user: AuthUser, @Param("organizationId", ParseUUIDPipe) id: string,
    @Param("roleId", ParseUUIDPipe) roleId: string, @Body() input: UpdateOrganizationRoleDto): Promise<unknown> {
    return this.organizations.updateRole(user, id, roleId, input);
  }

  @Post("employees")
  createEmployee(@CurrentUser() user: AuthUser, @Param("organizationId", ParseUUIDPipe) id: string,
    @Body() input: CreateEmployeeDto): Promise<unknown> {
    return this.organizations.createEmployee(user, id, input);
  }

  @Patch("employees/:membershipId")
  updateEmployee(@CurrentUser() user: AuthUser, @Param("organizationId", ParseUUIDPipe) id: string,
    @Param("membershipId", ParseUUIDPipe) membershipId: string, @Body() input: UpdateEmployeeDto): Promise<unknown> {
    return this.organizations.updateEmployee(user, id, membershipId, input);
  }
}
