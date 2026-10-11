import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsObject, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ValidateNested } from "class-validator";

/** The only permissions an organization may switch per employee (a typed, closed shape). */
export class PermissionOverridesDto {
  @IsOptional() @IsBoolean() "catalog.service.read"?: boolean;
  @IsOptional() @IsBoolean() "catalog.service.manage"?: boolean;
  @IsOptional() @IsBoolean() "booking.read"?: boolean;
  @IsOptional() @IsBoolean() "booking.manage"?: boolean;
}

export class CreateOrganizationRoleDto {
  @IsString() @Length(2, 40) @Matches(/^[a-z][a-z0-9-]*$/) code!: string;
  @IsString() @Length(2, 160) name!: string;
  @IsArray() @ArrayMaxSize(4) @ArrayUnique() @IsString({ each: true }) @MaxLength(64, { each: true }) permissions!: string[];
}

export class UpdateOrganizationRoleDto {
  @IsOptional() @IsString() @Length(2, 160) name?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(4) @ArrayUnique() @IsString({ each: true }) @MaxLength(64, { each: true }) permissions?: string[];
}

export class SpecialtiesDto {
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(80, { each: true }) specialties!: string[];
}

export class CreateDepartmentDto {
  @IsString() @Length(2, 64) @Matches(/^[a-z][a-z0-9-]*$/) code!: string;
  @IsString() @Length(2, 160) name!: string;
}

export class UpdateDepartmentDto {
  @IsOptional() @IsString() @Length(2, 160) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateEmployeeDto {
  @IsEmail() @MaxLength(320) email!: string;
  @IsString() @Length(2, 200) displayName!: string;
  @IsString() @Length(12, 128) @Matches(/\S/) password!: string;
  @IsString() @Length(2, 160) jobTitle!: string;
  @IsUUID() departmentId!: string;
  @IsArray() @ArrayMaxSize(5) @ArrayUnique() @IsUUID("4", { each: true }) roleIds!: string[];
  @IsOptional() @IsObject() @ValidateNested() @Type(() => PermissionOverridesDto) permissionOverrides?: PermissionOverridesDto;
}

export class UpdateEmployeeDto {
  @IsOptional() @IsString() @Length(2, 160) jobTitle?: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @ArrayUnique() @IsUUID("4", { each: true }) roleIds?: string[];
  @IsOptional() @IsObject() @ValidateNested() @Type(() => PermissionOverridesDto) permissionOverrides?: PermissionOverridesDto;
  @IsOptional() @IsIn(["ACTIVE", "SUSPENDED", "REVOKED"]) status?: "ACTIVE" | "SUSPENDED" | "REVOKED";
}
