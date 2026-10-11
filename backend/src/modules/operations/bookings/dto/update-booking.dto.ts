import { PartialType, OmitType } from "@nestjs/swagger";
import { CreateBookingDto } from "./create-booking.dto.js";
export class UpdateBookingDto extends PartialType(OmitType(CreateBookingDto, ["serviceId"] as const), {
  skipNullProperties: false
}) {}
