import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Length, Matches } from "class-validator";

const trim = ({ value }: { value: unknown }): unknown => (typeof value === "string" ? value.trim() : value);

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^\+?[0-9 ()-]{6,32}$/)
  phone?: string;

  @ApiPropertyOptional({ example: "ar-SA" })
  @IsOptional()
  @IsIn(["ar-SA", "en-US"])
  locale?: string;
}

export class MembersQueryDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 100)
  q?: string;
}

export class MemberStatusDto {
  @ApiProperty({ enum: ["ACTIVE", "SUSPENDED", "REVOKED"] })
  @IsIn(["ACTIVE", "SUSPENDED", "REVOKED"])
  status!: "ACTIVE" | "SUSPENDED" | "REVOKED";

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  reason?: string;
}
