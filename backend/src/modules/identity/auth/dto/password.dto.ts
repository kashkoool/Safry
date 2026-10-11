import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, Length, Matches, MinLength } from "class-validator";

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(8)
  currentPassword!: string;

  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @Length(12, 128)
  @Matches(/\S/)
  newPassword!: string;
}

export class UnlockLoginDto {
  @ApiProperty()
  @IsEmail()
  email!: string;
}
