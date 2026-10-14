import { Body, Controller, Delete, Get, Headers, HttpCode, Ip, Param, ParseUUIDPipe, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { ApiAcceptedResponse, ApiBearerAuth, ApiHeader, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { CurrentUser } from "../../../common/security/current-user.decorator.js";
import { PlatformAdminGuard } from "../../../common/security/platform-admin.guard.js";
import { Public } from "../../../common/security/public.decorator.js";
import { RegistrationService } from "../users/registration.service.js";
import { RegisterCustomerDto, RegisterProviderDto } from "../users/dto/register.dto.js";
import { AuthService } from "./auth.service.js";
import type { IssuedTokenPair, LoginResult, MfaChallenge, NativeTokenPair, TokenPair } from "./auth.types.js";
import {
  assertBrowserRequest,
  clearRefreshCookie,
  clientKind,
  cookieSettings,
  readCookie,
  setRefreshCookie,
  type CookieSettings
} from "./refresh-cookie.js";
import { LoginDto } from "./dto/login.dto.js";
import { MfaDisableDto, MfaEnableDto, MfaPasswordDto, MfaRegenerateRecoveryDto, MfaVerifyDto } from "./dto/mfa.dto.js";
import { RefreshTokenDto } from "./dto/refresh-token.dto.js";
import { ChangePasswordDto, UnlockLoginDto } from "./dto/password.dto.js";
import { AcceptedDto, ForgotPasswordDto, ResendVerificationDto, ResetPasswordDto, VerifyEmailDto } from "./dto/credential.dto.js";
import { CredentialService } from "./credential.service.js";
import { AccountSecurityService } from "./account-security.service.js";
import { MfaService, type MfaStatus } from "./mfa.service.js";

const NATIVE_CLIENT_HEADER = ApiHeader({
  name: "X-Client",
  required: false,
  description:
    "Browsers omit it: the refresh token is an HttpOnly cookie and never appears in a body. Native apps send `mobile` and exchange the refresh token in the JSON body instead (no cookie is read or set)."
});
const CSRF_HEADER_DOC = ApiHeader({
  name: "X-Requested-With",
  required: false,
  description: "Browser clients must send `XMLHttpRequest` on cookie-authenticated calls (CSRF defence); a present Origin must also be allowed."
});

@ApiTags("identity / authentication")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly registration: RegistrationService,
    private readonly mfa: MfaService,
    private readonly security: AccountSecurityService,
    private readonly credentials: CredentialService,
    config: ConfigService
  ) {
    this.production = config.get<string>("NODE_ENV") === "production";
    this.corsOrigins = config.get<string>("CORS_ORIGINS");
    this.cookie = cookieSettings(config.get<string>("API_PREFIX", "api/v1"), this.production);
  }

  private readonly production: boolean;
  private readonly corsOrigins: string | undefined;
  private readonly cookie: CookieSettings;

  /** Browser: refresh token into the HttpOnly cookie and out of the body. Native (`X-Client: mobile`): body, no cookie. */
  private deliver(req: Request, res: Response, issued: IssuedTokenPair): TokenPair | NativeTokenPair {
    const { refreshToken, refreshExpiresAt, ...pair } = issued;
    if (clientKind(req) === "native") return { ...pair, refreshToken };
    setRefreshCookie(res, this.cookie, refreshToken, refreshExpiresAt);
    return pair;
  }

  private deliverLogin(req: Request, res: Response, result: LoginResult): TokenPair | NativeTokenPair | MfaChallenge {
    return "mfaRequired" in result ? result : this.deliver(req, res, result);
  }

  private guardBrowser(req: Request, csrfHeader: boolean): void {
    if (clientKind(req) === "web") assertBrowserRequest(req, this.corsOrigins, this.production, csrfHeader);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("register/customer")
  registerCustomer(@Body() input: RegisterCustomerDto, @Ip() ipAddress: string): Promise<{ message: string }> {
    return this.registration.customer(input, ipAddress);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("register/provider")
  registerProvider(@Body() input: RegisterProviderDto, @Ip() ipAddress: string): Promise<{ message: string }> {
    return this.registration.provider(input, ipAddress);
  }

  @Public()
  @Throttle({ default: { limit: 50, ttl: 60_000 } })
  @HttpCode(200)
  @NATIVE_CLIENT_HEADER
  @Post("login")
  async login(
    @Body() input: LoginDto,
    @Headers("user-agent") userAgent: string | undefined,
    @Ip() ipAddress: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): Promise<TokenPair | NativeTokenPair | MfaChallenge> {
    this.guardBrowser(req, false);
    return this.deliverLogin(req, res, await this.authService.login(input, { userAgent, ipAddress }));
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @NATIVE_CLIENT_HEADER
  @Post("mfa/verify")
  async verifyMfa(
    @Body() input: MfaVerifyDto,
    @Headers("user-agent") userAgent: string | undefined,
    @Ip() ipAddress: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): Promise<TokenPair | NativeTokenPair> {
    this.guardBrowser(req, false);
    return this.deliver(req, res, await this.authService.verifyMfa(input.mfaToken, input.code, { userAgent, ipAddress }));
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @NATIVE_CLIENT_HEADER
  @CSRF_HEADER_DOC
  @Post("refresh")
  async refresh(
    @Body() input: RefreshTokenDto,
    @Headers("user-agent") userAgent: string | undefined,
    @Ip() ipAddress: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): Promise<TokenPair | NativeTokenPair> {
    this.guardBrowser(req, true);
    const token = this.presentedToken(req, input);
    if (!token) throw new UnauthorizedException("Refresh token is invalid or expired");
    return this.deliver(req, res, await this.authService.refresh(token, { userAgent, ipAddress }));
  }

  /** Browser: the cookie only (a body value is ignored). Native: the body only (a cookie is ignored). */
  private presentedToken(req: Request, input: RefreshTokenDto): string | undefined {
    return clientKind(req) === "native" ? input.refreshToken : readCookie(req.headers.cookie, this.cookie.name);
  }

  @ApiBearerAuth()
  @HttpCode(204)
  @Post("activity")
  activity(@CurrentUser() user: AuthUser): Promise<void> {
    return this.authService.activity(user);
  }

  /** Needs only the refresh token, so it works after the access token expired. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(204)
  @NATIVE_CLIENT_HEADER
  @CSRF_HEADER_DOC
  @Post("logout")
  async logout(@Body() input: RefreshTokenDto, @Ip() ipAddress: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    this.guardBrowser(req, true);
    const token = this.presentedToken(req, input);
    if (clientKind(req) === "web") clearRefreshCookie(res, this.cookie);
    if (token) await this.authService.logout(token, { ipAddress });
  }

  @ApiBearerAuth()
  @HttpCode(204)
  @Post("logout-all")
  async logoutAll(@CurrentUser() user: AuthUser): Promise<void> {
    await this.authService.logoutAll(user);
  }

  @ApiBearerAuth()
  @Get("sessions")
  sessions(@CurrentUser() user: AuthUser): ReturnType<AuthService["listSessions"]> {
    return this.authService.listSessions(user);
  }

  @ApiBearerAuth()
  @HttpCode(204)
  @Delete("sessions/:id")
  async endSession(@CurrentUser() user: AuthUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.authService.endSession(user, id);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(204)
  @Post("password")
  async changePassword(@CurrentUser() user: AuthUser, @Body() input: ChangePasswordDto, @Ip() ipAddress: string): Promise<void> {
    await this.authService.changePassword(user, input.currentPassword, input.newPassword, ipAddress);
  }

  /**
   * Mails a password-reset link when the address belongs to an active account. The answer (202, `{ accepted: true }`) and its
   * timing are the same for every address. Limits: per client address and per (address, client address), plus at most one link
   * per minute and five per hour for one account regardless of who asks.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 }, account: { limit: 3, ttl: 60_000 } })
  @HttpCode(202)
  @ApiAcceptedResponse({ type: AcceptedDto })
  @Post("password/forgot")
  async forgotPassword(@Body() input: ForgotPasswordDto, @Ip() ipAddress: string): Promise<AcceptedDto> {
    await this.credentials.forgotPassword(input.email, ipAddress);
    return { accepted: true };
  }

  /**
   * Sets a new password from the e-mailed token (single use, valid one hour). Ends every session and refresh token of the
   * account, lifts its lockout and sends a "password changed" notice. 400 for an unknown, used, expired or altered token.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(204)
  @Post("password/reset")
  async resetPassword(@Body() input: ResetPasswordDto, @Ip() ipAddress: string): Promise<void> {
    await this.credentials.resetPassword(input.token, input.newPassword, ipAddress);
  }

  /** Confirms the address with the e-mailed token (single use, valid 24 hours). 400 for an unknown, used, expired or altered token. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(204)
  @Post("email/verify")
  async verifyEmail(@Body() input: VerifyEmailDto, @Ip() ipAddress: string): Promise<void> {
    await this.credentials.verifyEmail(input.token, ipAddress);
  }

  /** Mails a new verification link to an unverified account; same answer and timing for every address. Same limits as forgot. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 }, account: { limit: 3, ttl: 60_000 } })
  @HttpCode(202)
  @ApiAcceptedResponse({ type: AcceptedDto })
  @Post("email/resend")
  async resendVerification(@Body() input: ResendVerificationDto, @Ip() ipAddress: string): Promise<AcceptedDto> {
    await this.credentials.resendVerification(input.email, ipAddress);
    return { accepted: true };
  }

  /** Platform-admin unlock path for an e-mail whose sign-in is blocked account-wide. */
  @ApiBearerAuth()
  @UseGuards(PlatformAdminGuard)
  @HttpCode(204)
  @Post("login-throttle/unlock")
  async unlockLogin(@CurrentUser() user: AuthUser, @Body() input: UnlockLoginDto): Promise<void> {
    await this.security.unlock(input.email, user);
  }

  @ApiBearerAuth()
  @Get("me")
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @ApiBearerAuth()
  @Get("mfa")
  mfaStatus(@CurrentUser() user: AuthUser): Promise<MfaStatus> {
    return this.mfa.status(user);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post("mfa/setup")
  mfaSetup(@CurrentUser() user: AuthUser, @Body() input: MfaPasswordDto, @Ip() ipAddress: string): Promise<{ secret: string; otpauthUri: string }> {
    return this.mfa.beginSetup(user, input.password, ipAddress);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post("mfa/enable")
  mfaEnable(@CurrentUser() user: AuthUser, @Body() input: MfaEnableDto): Promise<{ recoveryCodes: string[] }> {
    return this.mfa.enable(user, input.code);
  }

  /** new recovery codes (all older ones, including legacy ones, stop working). */
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post("mfa/recovery-codes")
  mfaRegenerateRecoveryCodes(@CurrentUser() user: AuthUser, @Body() input: MfaRegenerateRecoveryDto, @Ip() ipAddress: string): Promise<{ recoveryCodes: string[] }> {
    return this.mfa.regenerateRecoveryCodes(user, input.password, input.code, ipAddress);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(204)
  @Post("mfa/disable")
  async mfaDisable(@CurrentUser() user: AuthUser, @Body() input: MfaDisableDto, @Ip() ipAddress: string): Promise<void> {
    await this.mfa.disable(user, input.password, input.code, ipAddress);
  }
}
