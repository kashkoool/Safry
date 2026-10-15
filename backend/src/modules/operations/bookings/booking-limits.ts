import { BadRequestException, ConflictException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

/** Operational limits against inventory hoarding by pending bookings (env tunables, validated at boot). */
export interface BookingLimits {
  maxPendingPerTraveler: number;
  maxDaysAhead: number;
  pendingTtlHours: number;
}

export const DEFAULT_BOOKING_LIMITS: BookingLimits = { maxPendingPerTraveler: 10, maxDaysAhead: 365, pendingTtlHours: 48 };

/** Stable machine-readable codes returned in the `code` field of the error body. */
export const BOOKING_ERROR = {
  pendingLimit: "BOOKING_PENDING_LIMIT",
  dateTooFar: "BOOKING_DATE_TOO_FAR",
  expired: "BOOKING_EXPIRED"
} as const;

export function bookingLimits(config: Pick<ConfigService, "get">): BookingLimits {
  const read = (key: string, fallback: number): number => Number(config.get<string | number>(key) ?? fallback);
  return {
    maxPendingPerTraveler: read("BOOKING_MAX_PENDING_PER_TRAVELER", DEFAULT_BOOKING_LIMITS.maxPendingPerTraveler),
    maxDaysAhead: read("BOOKING_MAX_DAYS_AHEAD", DEFAULT_BOOKING_LIMITS.maxDaysAhead),
    pendingTtlHours: read("BOOKING_PENDING_TTL_HOURS", DEFAULT_BOOKING_LIMITS.pendingTtlHours)
  };
}

/** A PENDING booking created before this instant is expired (computed rule; no stored flag, no scheduler). */
export function pendingCutoff(limits: BookingLimits, now = Date.now()): Date {
  return new Date(now - limits.pendingTtlHours * 3_600_000);
}

export const pendingLimitError = (): ConflictException =>
  new ConflictException({ message: "وصلت إلى الحد الأقصى للحجوزات المعلقة؛ أكّد أو ألغِ حجزاً قبل إنشاء حجز جديد", code: BOOKING_ERROR.pendingLimit });
export const expiredError = (): ConflictException =>
  new ConflictException({ message: "انتهت صلاحية الحجز المعلق وتم إلغاؤه؛ أنشئ حجزاً جديداً", code: BOOKING_ERROR.expired });
export const dateTooFarError = (): BadRequestException =>
  new BadRequestException({ message: "تاريخ الحجز بعيد جداً عن اليوم", code: BOOKING_ERROR.dateTooFar });
