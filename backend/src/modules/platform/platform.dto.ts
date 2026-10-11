import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf
} from "class-validator";
import { PartialType } from "@nestjs/swagger";
export class PlatformQuery {
  @Type(() => Number) @IsInt() @Min(1) @Max(1000) page = 1;
  @ValidateIf((_o, v: unknown) => v !== undefined) @IsUUID() tenantId?: string;
  @ValidateIf((_o, v: unknown) => v !== undefined) @IsString() @Length(0, 200) q?: string;
}
export class ProfileDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(2, 200)
  displayName!: string;
  @IsEmail() @Length(3, 320) email!: string;
  @IsString() @Length(0, 32) phone!: string;
}
export class UpdateAccountDto extends PartialType(ProfileDto, { skipNullProperties: false }) {
  @ValidateIf((_o, v: unknown) => v !== undefined) @IsBoolean() isPlatformAdmin?: boolean;
  /** Step-up: the acting administrator's own password and, with MFA on, a current code. Needed only to grant platform administration. */
  @ValidateIf((_o, v: unknown) => v !== undefined) @IsString() @Length(1, 128) currentPassword?: string;
  @ValidateIf((_o, v: unknown) => v !== undefined) @IsString() @Length(6, 64) mfaCode?: string;
}
export class AccountStateDto {
  @IsIn(["ACTIVE", "SUSPENDED", "DISABLED", "DELETE", "RESTORE"]) action!:
    "ACTIVE" | "SUSPENDED" | "DISABLED" | "DELETE" | "RESTORE";
  @IsString() @Length(3, 500) reason!: string;
  /** Step-up: the acting administrator's own password and, when their account has MFA, a current code. Needed only when the request grants administrative power (see the operation). */
  @ValidateIf((_o, v: unknown) => v !== undefined) @IsString() @Length(1, 128) currentPassword?: string;
  @ValidateIf((_o, v: unknown) => v !== undefined) @IsString() @Length(6, 64) mfaCode?: string;
}
export class AccessDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  roleIds!: string[];
  @IsObject() permissionOverrides!: Record<string, boolean>;
  @IsIn(["ACTIVE", "SUSPENDED", "REVOKED"]) status!: "ACTIVE" | "SUSPENDED" | "REVOKED";
  @ValidateIf((_o, v: unknown) => v !== undefined && v !== null) @IsUUID() providerOrganizationId?:
    string | null;
  /** Step-up: the acting administrator's own password and, when their account has MFA, a current code. Needed only when the request grants administrative power (see the operation). */
  @ValidateIf((_o, v: unknown) => v !== undefined) @IsString() @Length(1, 128) currentPassword?: string;
  @ValidateIf((_o, v: unknown) => v !== undefined) @IsString() @Length(6, 64) mfaCode?: string;
}
export class CreateAccountDto extends ProfileDto {
  @IsString() @Length(12, 128) password!: string;
  @IsUUID() tenantId!: string;
  @IsUUID() roleId!: string;
  @ValidateIf((_o, v: unknown) => v !== undefined) @IsUUID() providerOrganizationId?: string;
  /** Step-up: the acting administrator's own password and, when their account has MFA, a current code. Needed only when the request grants administrative power (see the operation). */
  @ValidateIf((_o, v: unknown) => v !== undefined) @IsString() @Length(1, 128) currentPassword?: string;
  @ValidateIf((_o, v: unknown) => v !== undefined) @IsString() @Length(6, 64) mfaCode?: string;
}
