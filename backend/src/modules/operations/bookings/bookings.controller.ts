import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { PageQueryDto } from "../../../common/pagination.js";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { CurrentUser } from "../../../common/security/current-user.decorator.js";
import { RequirePermissions } from "../../../common/security/permissions.decorator.js";
import { BookingsService } from "./bookings.service.js";
import { CreateBookingDto } from "./dto/create-booking.dto.js";
import { UpdateBookingStatusDto } from "./dto/update-booking-status.dto.js";
import { UpdateBookingDto } from "./dto/update-booking.dto.js";

@ApiTags("travel / bookings")
@ApiBearerAuth()
@Controller("bookings")
export class BookingsController {
  constructor(private readonly travel: BookingsService) {}

  @Get()
  @RequirePermissions("booking.read")
  list(
    @CurrentUser() user: AuthUser,
    @Query() page: PageQueryDto,
    @Res({ passthrough: true }) response: Response
  ): Promise<unknown> {
    return this.travel.listBookings(user, page, response);
  }

  @Post()
  @RequirePermissions("booking.create")
  create(
    @CurrentUser() user: AuthUser,
    @Body() input: CreateBookingDto,
    @Headers("idempotency-key") idempotencyKey?: string
  ): Promise<unknown> {
    return this.travel.createBooking(user, input, idempotencyKey);
  }

  @Patch(":id")
  @RequirePermissions("booking.create")
  update(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: UpdateBookingDto
  ): Promise<unknown> {
    return this.travel.updateBooking(user, id, input);
  }

  @Patch(":id/status")
  @RequirePermissions("booking.read")
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: UpdateBookingStatusDto
  ): Promise<unknown> {
    return this.travel.updateBookingStatus(user, id, input.status);
  }
}
