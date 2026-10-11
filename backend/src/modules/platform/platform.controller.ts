import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthUser } from "../../common/security/auth-user.js";
import { PlatformAdminGuard } from "../../common/security/platform-admin.guard.js";
import { CurrentUser } from "../../common/security/current-user.decorator.js";
import { PlatformService } from "./platform.service.js";
import {
  AccessDto,
  AccountStateDto,
  CreateAccountDto,
  PlatformQuery,
  UpdateAccountDto
} from "./platform.dto.js";
@ApiTags("platform administration")
@ApiBearerAuth()
@UseGuards(PlatformAdminGuard)
@Controller("platform")
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}
  @Get("overview") overview(): Promise<unknown> {
    return this.platform.overview();
  }
  @Get("references") references(): Promise<unknown> {
    return this.platform.references();
  }
  @Get("records/:kind") records(
    @Param("kind") kind: string,
    @Query() query: PlatformQuery
  ): Promise<unknown> {
    return this.platform.records(kind, query);
  }
  @Post("users") create(@CurrentUser() actor: AuthUser, @Body() input: CreateAccountDto, @Ip() ipAddress: string): Promise<unknown> {
    return this.platform.create(actor, input, ipAddress);
  }
  @Patch("users/:id") update(
    @CurrentUser() actor: AuthUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: UpdateAccountDto,
    @Ip() ipAddress: string
  ): Promise<unknown> {
    return this.platform.updateAccount(actor, id, input, ipAddress);
  }
  @Post("users/:id/state") state(
    @CurrentUser() actor: AuthUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: AccountStateDto,
    @Ip() ipAddress: string
  ): Promise<unknown> {
    return this.platform.state(actor, id, input, ipAddress);
  }
  @Post("users/:id/revoke-sessions") revoke(
    @CurrentUser() actor: AuthUser,
    @Param("id", ParseUUIDPipe) id: string
  ): Promise<unknown> {
    return this.platform.revokeSessions(actor, id);
  }
  @Patch("memberships/:id/access") access(
    @CurrentUser() actor: AuthUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: AccessDto,
    @Ip() ipAddress: string
  ): Promise<unknown> {
    return this.platform.access(actor, id, input, ipAddress);
  }
}
