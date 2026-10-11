import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { PageQueryDto } from "../../../common/pagination.js";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { CurrentUser } from "../../../common/security/current-user.decorator.js";
import { RequirePermissions } from "../../../common/security/permissions.decorator.js";
import { CreateProviderDto, ProviderStatusDto, UpdateProviderDto } from "./dto/provider.dto.js";
import { ProvidersService } from "./providers.service.js";

@ApiBearerAuth()
@ApiTags("business entities / providers")
@Controller("providers")
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}
  @Get("workspace")
  @RequirePermissions("tenant.read")
  workspace(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.providers.workspace(user);
  }
  @Get()
  @RequirePermissions("catalog.service.read")
  list(
    @CurrentUser() user: AuthUser,
    @Query() page: PageQueryDto,
    @Res({ passthrough: true }) response: Response
  ): Promise<unknown> {
    return this.providers.list(user, page, response);
  }
  @Post()
  @RequirePermissions("identity.user.manage")
  create(@CurrentUser() user: AuthUser, @Body() input: CreateProviderDto): Promise<unknown> {
    return this.providers.create(user, input);
  }
  @Patch(":id")
  @RequirePermissions("catalog.service.manage")
  update(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: UpdateProviderDto
  ): Promise<unknown> {
    return this.providers.update(user, id, input);
  }
  @Patch(":id/status")
  @RequirePermissions("identity.user.manage")
  status(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: ProviderStatusDto
  ): Promise<unknown> {
    return this.providers.status(user, id, input.status);
  }
}
