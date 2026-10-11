import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MinLength } from "class-validator";

export class LoginDto {
  @ApiProperty({ example: "admin@safry.local" })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ example: "safry" })
  @IsString()
  @Length(2, 64)
  @Matches(/^[a-z0-9-]+$/)
  tenantCode!: string;

  @ApiProperty({ enum: ["customer", "provider", "admin"], required: false })
  @IsOptional()
  @IsIn(["customer", "provider", "admin"])
  portal?: "customer" | "provider" | "admin";
}
