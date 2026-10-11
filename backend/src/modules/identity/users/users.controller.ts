import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { CurrentUser } from "../../../common/security/current-user.decorator.js";
import { RequirePermissions } from "../../../common/security/permissions.decorator.js";
import { MembersQueryDto, MemberStatusDto, UpdateProfileDto } from "./dto/users.dto.js";
import { UsersService } from "./users.service.js";

@ApiTags("identity / users")
@ApiBearerAuth()
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get("users/me")
  profile(@CurrentUser() user: AuthUser): Promise<object> {
    return this.users.profile(user);
  }

  @Patch("users/me")
  updateProfile(@CurrentUser() user: AuthUser, @Body() input: UpdateProfileDto): Promise<object> {
    return this.users.updateProfile(user, input);
  }

  @Get("users/me/invitations")
  invitations(@CurrentUser() user: AuthUser): Promise<object[]> {
    return this.users.invitations(user);
  }

  @Post("users/me/invitations/:membershipId/accept")
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param("membershipId", ParseUUIDPipe) membershipId: string): Promise<object> {
    return this.users.respondToInvitation(user, membershipId, true);
  }

  @Post("users/me/invitations/:membershipId/decline")
  @HttpCode(200)
  decline(@CurrentUser() user: AuthUser, @Param("membershipId", ParseUUIDPipe) membershipId: string): Promise<object> {
    return this.users.respondToInvitation(user, membershipId, false);
  }

  @Get("tenants/members")
  @RequirePermissions("identity.user.read")
  members(@CurrentUser() user: AuthUser, @Query() query: MembersQueryDto): Promise<object[]> {
    return this.users.members(user, query.q);
  }

  @Patch("tenants/members/:membershipId/status")
  @RequirePermissions("identity.user.manage")
  setStatus(
    @CurrentUser() user: AuthUser,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Body() input: MemberStatusDto
  ): Promise<object> {
    return this.users.setMemberStatus(user, membershipId, input);
  }

  @Get("tenants/members/:membershipId/history")
  @RequirePermissions("identity.user.read", "audit.read")
  history(
    @CurrentUser() user: AuthUser,
    @Param("membershipId", ParseUUIDPipe) membershipId: string
  ): Promise<object[]> {
    return this.users.history(user, membershipId);
  }
}
