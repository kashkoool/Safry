import { IsEmail, IsEnum, IsIn, IsString, Length, Matches } from "class-validator";
import { PartialType, OmitType } from "@nestjs/swagger";
import { ProviderType } from "../../../../generated/prisma/enums.js";
import { Transform } from "class-transformer";

export class CreateProviderDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(3, 200)
  name!: string;
  @Transform(({ value }: { value: unknown }) => typeof value === "string" ? value.trim() : value)
  @IsString() @Length(3, 200) nameAr!: string;
  @Transform(({ value }: { value: unknown }) => typeof value === "string" ? value.trim() : value)
  @IsString() @Length(3, 200) nameEn!: string;
  @IsEnum(ProviderType) type!: ProviderType;
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(2, 120)
  city!: string;
  @IsEmail() contactEmail!: string;
  @IsString() @Length(0, 32) phone!: string;
  @IsString() @Length(0, 120) licenseNumber!: string;
  @IsString() @Length(12, 128) @Matches(/\S/) password!: string;
}
export class UpdateProviderDto extends PartialType(
  OmitType(CreateProviderDto, ["type", "password", "contactEmail"] as const),
  { skipNullProperties: false }
) {}
export class ProviderStatusDto {
  @IsIn(["ACTIVE", "SUSPENDED"]) status!: "ACTIVE" | "SUSPENDED";
}
