import { IsEmail, IsEnum, IsString, Length, Matches } from "class-validator";
import { ProviderType } from "../../../../generated/prisma/enums.js";
import { Transform } from "class-transformer";

export class RegisterCustomerDto {
  @IsString() @Length(2, 200) displayName!: string;
  @IsEmail() email!: string;
  @IsString() @Length(12, 128) @Matches(/\S/) password!: string;
  @IsString() @Length(2, 64) @Matches(/^[a-z0-9-]+$/) tenantCode!: string;
}

export class RegisterProviderDto extends RegisterCustomerDto {
  @Transform(({ value }: { value: unknown }) => typeof value === "string" ? value.trim() : value)
  @IsString() @Length(3, 200) organizationName!: string;
  @Transform(({ value }: { value: unknown }) => typeof value === "string" ? value.trim() : value)
  @IsString() @Length(3, 200) organizationNameEn!: string;
  @IsEnum(ProviderType) type!: ProviderType;
  @IsString() @Length(2, 120) city!: string;
  @IsString() @Length(0, 32) phone!: string;
  @IsString() @Length(0, 120) licenseNumber!: string;
}
