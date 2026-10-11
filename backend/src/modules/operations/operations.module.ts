import { Module } from "@nestjs/common";
import { BookingsController } from "./bookings/bookings.controller.js";
import { BookingsService } from "./bookings/bookings.service.js";

/** Travel Operations (currently Booking Management). */
@Module({ controllers: [BookingsController], providers: [BookingsService] })
export class OperationsModule {}
