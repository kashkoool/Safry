import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, Length, Matches } from "class-validator";

/** Answer of the "request a link" endpoints: identical whether or not the address belongs to an account. */
export class AcceptedDto {
  @ApiProperty({ example: true, description: "Always true. A link is mailed only when the address belongs to a matching account." })
  accepted!: true;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: "traveler@example.org" })
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ minLength: 43, maxLength: 43, description: "The value after `#token=` in the e-mailed link (43 URL-safe characters)." })
  @IsString()
  @Length(43, 43)
  token!: string;

  @ApiProperty({ minLength: 12, maxLength: 128, description: "Same policy as every other password field." })
  @IsString()
  @Length(12, 128)
  @Matches(/\S/)
  newPassword!: string;
}

export class VerifyEmailDto {
  @ApiProperty({ minLength: 43, maxLength: 43, description: "The value after `#token=` in the e-mailed link (43 URL-safe characters)." })
  @IsString()
  @Length(43, 43)
  token!: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: "traveler@example.org" })
  @IsEmail()
  email!: string;
}
