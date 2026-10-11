import {
  IsDateString,
  IsInt,
  ValidateIf,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  Matches
} from "class-validator";

export class CreateBookingDto {
  @IsUUID()
  serviceId!: string;

  @IsInt()
  @Min(1)
  @Max(20)
  travelersCount!: number;
  @ValidateIf((_object, value: unknown) => value !== undefined) @IsInt() @Min(1) @Max(20) units?: number;
  @IsDateString() @Matches(/^\d{4}-\d{2}-\d{2}$/) serviceDate!: string;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endDate?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Length(0, 1000)
  notes?: string;
}
