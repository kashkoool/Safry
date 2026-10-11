import { ApiProperty } from "@nestjs/swagger";
import { IsString, Length, Matches, MinLength } from "class-validator";

export class MfaPasswordDto {
  @ApiProperty({ description: "Current password (re-authentication)" })
  @IsString()
  @MinLength(8)
  password!: string;
}

export class MfaEnableDto {
  @ApiProperty({ example: "123456" })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class MfaDisableDto extends MfaPasswordDto {
  @ApiProperty({ description: "Authenticator code or recovery code" })
  @IsString()
  @Length(6, 24)
  code!: string;
}

export class MfaRegenerateRecoveryDto extends MfaPasswordDto {
  @ApiProperty({ example: "123456", description: "Current authenticator code (a recovery code is not accepted)" })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class MfaVerifyDto {
  @ApiProperty()
  @IsString()
  @MinLength(32)
  mfaToken!: string;

  @ApiProperty({ description: "Authenticator code or recovery code" })
  @IsString()
  @Length(6, 24)
  code!: string;
}
