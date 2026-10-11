import { IsIn } from "class-validator";

export class UpdateBookingStatusDto {
  @IsIn(["CONFIRMED", "CANCELLED"])
  status!: "CONFIRMED" | "CANCELLED";
}
