import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsIn, IsISO4217CurrencyCode, IsObject, IsOptional, IsString, IsTimeZone, IsUrl, Length, Matches, MaxLength, ValidateNested } from "class-validator";

const trim = ({ value }: { value: unknown }): unknown => (typeof value === "string" ? value.trim() : value);

/** Tenant branding: only formats the web app can render safely. */
export class TenantBrandingDto {
  @ApiPropertyOptional({ example: "#0f766e" })
  @IsOptional()
  @Matches(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  primaryColor?: string;

  @ApiPropertyOptional({ example: "https://cdn.example.com/logo.svg" })
  @IsOptional()
  @MaxLength(500)
  @IsUrl({ protocols: ["https"], require_protocol: true })
  logoUrl?: string;
}

/**
 * Feature switches a tenant may store. Nothing reads them yet, so the list is closed and empty until
 * the product defines real features; any key is rejected.
 */
export class TenantFeaturesDto {}

export class TenantSettingsDto {
  @ApiPropertyOptional({ enum: ["ar-SA", "en-US"] })
  @IsOptional()
  @IsIn(["ar-SA", "en-US"])
  locale?: string;

  @ApiPropertyOptional({ example: "Asia/Riyadh" })
  @IsOptional()
  @MaxLength(64)
  @IsTimeZone()
  timezone?: string;

  @ApiPropertyOptional({ example: "SAR" })
  @IsOptional()
  @IsISO4217CurrencyCode()
  currency?: string;

  @ApiPropertyOptional({ type: TenantBrandingDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => TenantBrandingDto)
  branding?: TenantBrandingDto;

  @ApiPropertyOptional({ type: TenantFeaturesDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => TenantFeaturesDto)
  features?: TenantFeaturesDto;
}

export class UpdateTenantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  name?: string;

  @ApiPropertyOptional({ type: TenantSettingsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => TenantSettingsDto)
  settings?: TenantSettingsDto;
}

export class CreateTenantDto {
  @ApiProperty({ example: "acme-travel" })
  @IsString()
  @Length(2, 64)
  @Matches(/^[a-z0-9-]+$/)
  code!: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  name!: string;

  @ApiPropertyOptional({ type: TenantSettingsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => TenantSettingsDto)
  settings?: TenantSettingsDto;
}

export class TenantStatusDto {
  @ApiProperty({ enum: ["ACTIVE", "SUSPENDED", "ARCHIVED"] })
  @IsIn(["ACTIVE", "SUSPENDED", "ARCHIVED"])
  status!: "ACTIVE" | "SUSPENDED" | "ARCHIVED";

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  reason!: string;
}
