import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MinLength } from "class-validator";

/**
 * Browsers send no body: the refresh token is read from the HttpOnly cookie. Native clients (`X-Client: mobile`)
 * send the token here; browsers' body value is ignored.
 */
export class RefreshTokenDto {
  @ApiPropertyOptional({ description: "Native clients only (header `X-Client: mobile`); ignored for browsers, which use the cookie." })
  @IsOptional()
  @IsString()
  @MinLength(32)
  refreshToken?: string;
}
