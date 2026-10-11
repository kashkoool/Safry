import { IsIn, ValidateIf } from "class-validator";
import { PartialType, OmitType } from "@nestjs/swagger";
import { CreateServiceDto } from "./create-service.dto.js";
export class UpdateServiceDto extends PartialType(
  OmitType(CreateServiceDto, ["providerOrganizationId"] as const),
  { skipNullProperties: false }
) {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["DRAFT", "ACTIVE", "INACTIVE"])
  status?: "DRAFT" | "ACTIVE" | "INACTIVE";
}
