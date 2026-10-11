import { BadRequestException, ConflictException } from "@nestjs/common";
import type { ServiceCategory } from "../../../generated/prisma/enums.js";

const day = 86400000;
/**
 * Booking limits (still code constants, not tenant configuration). The error messages below stay static
 * literals on purpose: the frontend dictionary translates them by exact text, so keep the numbers in sync by hand.
 */
const MAX_TRAVELERS = 20;
const MAX_UNITS = 20;
const MAX_NIGHTS = 90;
/** `totalCents` is a 32-bit Postgres integer. */
const INT32_MAX = 2_147_483_647;
export function bookingTerms(
  category: ServiceCategory,
  details: Record<string, string>,
  priceCents: number,
  input: { travelersCount: number; units?: number; serviceDate: string; endDate?: string },
  today = new Date().toISOString().slice(0, 10)
): { units: number; nights: number; serviceDate: Date; endDate: Date | null; totalCents: number } {
  const { serviceDate, endDate } = input;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) ||
    !Number.isFinite(Date.parse(serviceDate)) ||
    new Date(serviceDate).toISOString().slice(0, 10) !== serviceDate ||
    serviceDate < today
  )
    throw new BadRequestException("اختر تاريخاً صحيحاً من اليوم فصاعداً");
  if (category === "FLIGHT" && details.departureDate && details.departureDate !== serviceDate)
    throw new BadRequestException("تاريخ الحجز يجب أن يطابق موعد رحلة الطيران");
  if (!Number.isInteger(input.travelersCount) || input.travelersCount < 1 || input.travelersCount > MAX_TRAVELERS)
    throw new BadRequestException("عدد المسافرين بين 1 و20");
  let units = input.travelersCount;
  let nights = 1;
  if (category === "HOTEL" || category === "TRANSPORT") {
    units = input.units ?? 1;
    if (!Number.isInteger(units) || units < 1 || units > MAX_UNITS)
      throw new BadRequestException("عدد الوحدات بين 1 و20");
    const guestsPerUnit = Number(category === "HOTEL" ? details.maxGuests : details.seats);
    if (guestsPerUnit > 0 && input.travelersCount > units * guestsPerUnit)
      throw new BadRequestException("عدد المسافرين يتجاوز سعة الغرف أو المركبات المختارة");
  }
  if (category === "HOTEL") {
    if (
      !endDate ||
      !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
      !Number.isFinite(Date.parse(endDate)) ||
      new Date(endDate).toISOString().slice(0, 10) !== endDate
    )
      throw new BadRequestException("تاريخ المغادرة مطلوب");
    nights = (Date.parse(endDate) - Date.parse(serviceDate)) / day;
    if (!Number.isInteger(nights) || nights < 1 || nights > MAX_NIGHTS)
      throw new BadRequestException("مدة الإقامة من ليلة إلى 90 ليلة");
  } else if (endDate) throw new BadRequestException("تاريخ نهاية الإقامة مخصص للفنادق");
  const totalCents = priceCents * units * nights;
  if (!Number.isSafeInteger(totalCents) || totalCents < 1 || totalCents > INT32_MAX)
    throw new BadRequestException("قيمة الحجز تتجاوز الحد المدعوم");
  return {
    units,
    nights,
    serviceDate: new Date(serviceDate),
    endDate: category === "HOTEL" ? new Date(endDate!) : null,
    totalCents
  };
}

/**
 * Prisma filter for the non-cancelled bookings that can affect the nights [serviceDate, endDate or +1 day):
 * a booking whose own range overlaps the request (serviceDate is required since migration 20261012; legacy rows without one
 * were deleted). Narrowing to
 * these keeps the work done under the service row lock proportional to the overlap, not to every booking ever made.
 */
export function overlapWhere(request: { serviceDate: Date; endDate: Date | null }): {
  OR: Array<Record<string, unknown>>;
} {
  const start = request.serviceDate;
  const finish = request.endDate ?? new Date(start.getTime() + day);
  return {
    OR: [
      { serviceDate: { lt: finish }, endDate: { gt: start } },
      { serviceDate: { lt: finish, gt: new Date(start.getTime() - day) }, endDate: null }
    ]
  };
}

export const inventorySelect = { id: true, units: true, serviceDate: true, endDate: true } as const;

export interface InventoryBooking {
  id: string;
  units: number;
  serviceDate: Date;
  endDate: Date | null;
}
export function assertCapacity(
  capacity: number,
  existing: InventoryBooking[],
  request: { units: number; serviceDate: Date; endDate: Date | null }
): void {
  const start = request.serviceDate.getTime();
  const finish = request.endDate?.getTime() ?? start + day;
  for (let date = start; date < finish; date += day) {
    const used = existing.reduce((sum, item) => {
      const from = item.serviceDate.getTime();
      const to = item.endDate?.getTime() ?? from + day;
      return sum + (from <= date && date < to ? item.units : 0);
    }, 0);
    if (used + request.units > capacity)
      throw new ConflictException("السعة المتاحة لا تكفي في الموعد المحدد");
  }
}
