import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsString, IsUUID, Length, Matches } from "class-validator";

const trim = ({ value }: { value: unknown }): unknown => (typeof value === "string" ? value.trim() : value);

export class CreateRoleDto {
  @ApiProperty({ example: "support-agent" })
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{2,59}$/)
  code!: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @Length(2, 160)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 500)
  description?: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  permissions!: string[];
}

export class UpdateRoleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 160)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 500)
  description?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  permissions?: string[];
}

export class AssignRolesDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsUUID("all", { each: true })
  roleIds!: string[];
}
