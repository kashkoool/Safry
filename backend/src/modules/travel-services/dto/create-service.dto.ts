import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  ValidateIf,
  IsString,
  IsUUID,
  Length,
  Max,
  Min
} from "class-validator";
import { ServiceCategory } from "../../../generated/prisma/enums.js";
import { supportedCurrencies, type SupportedCurrency } from "../currencies.js";

export class CreateServiceDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @Length(3, 200)
  title!: string;
  @ValidateIf((_object, value: unknown) => value !== undefined) @IsString() @Length(0, 200) titleEn?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined) @IsString() @Length(0, 1000) descriptionEn?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined) @IsString() @Length(0, 120) cityEn?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined) @IsObject() detailsEn?: Record<string, string>;

  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(10, 1000)
  description!: string;

  @IsEnum(ServiceCategory)
  category!: ServiceCategory;

  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(2, 120)
  city!: string;

  @IsInt()
  @Min(100)
  @Max(100_000_000)
  priceCents!: number;

  @IsOptional()
  @IsEnum(supportedCurrencies)
  currency?: SupportedCurrency;

  @IsInt() @Min(1) @Max(100000) capacity!: number;
  @IsObject() details!: Record<string, string>;
  @ValidateIf((_object, value: unknown) => value !== undefined) @IsUUID() providerOrganizationId?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsUUID(undefined, { each: true })
  componentIds?: string[];
}
