import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { finishPage, keysetPage, type PageQueryDto } from "../../../common/pagination.js";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { isOperator, isTenantAdmin } from "../../../common/security/principal.js";
import { PrismaService } from "../../../database/prisma.service.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { serviceInclude } from "../../travel-services/service-select.js";
import { assertCapacity, bookingTerms, inventorySelect, overlapWhere } from "./booking-rules.js";
import { bookingLimits, expiredError, pendingCutoff, pendingLimitError, type BookingLimits } from "./booking-limits.js";
import type { CreateBookingDto } from "./dto/create-booking.dto.js";
import type { UpdateBookingDto } from "./dto/update-booking.dto.js";

const bookingInclude = {
  service: { include: serviceInclude },
  traveler: { select: { user: { select: { displayName: true, email: true } } } }
} as const;
const operator = isOperator;
const admin = isTenantAdmin;

/** Booking Management. */
@Injectable()
export class BookingsService {
  private readonly limits: BookingLimits;
  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.limits = bookingLimits(config);
  }

  /** Capacity only counts CONFIRMED and non-expired PENDING bookings. */
  private liveWhere(): Prisma.BookingWhereInput {
    return { status: { not: "CANCELLED" }, NOT: { status: "PENDING", createdAt: { lt: pendingCutoff(this.limits) } } };
  }

  private isExpired(booking: { status: string; createdAt: Date }): boolean {
    return booking.status === "PENDING" && booking.createdAt < pendingCutoff(this.limits);
  }

  /** Idempotent cleanup: marks expired PENDING bookings of this service or traveler CANCELLED and audits each one. */
  private async sweepExpired(tx: Prisma.TransactionClient, user: AuthUser, where: Prisma.BookingWhereInput): Promise<void> {
    const stale = await tx.booking.findMany({
      where: { tenantId: user.tenantId, status: "PENDING", createdAt: { lt: pendingCutoff(this.limits) }, ...where },
      select: { id: true },
      take: 500
    });
    if (stale.length === 0) return;
    const ids = stale.map((row) => row.id);
    // Audit only the rows this transaction actually cancelled: a concurrent cancel or sweep may have taken some of them.
    const cancelled: string[] = [];
    for (const id of ids) {
      const done = await tx.booking.updateMany({ where: { id, tenantId: user.tenantId, status: "PENDING" }, data: { status: "CANCELLED" } });
      if (done.count > 0) cancelled.push(id);
    }
    if (cancelled.length > 0)
      await tx.auditEvent.createMany({
        data: cancelled.map((entityId) => ({ tenantId: user.tenantId, actorUserId: user.userId, action: "booking.expire", entityType: "booking", entityId }))
      });
  }

  /** API view: an expired PENDING booking is reported as CANCELLED with `expired: true` (also before it is swept). */
  private present<T extends { status: string; createdAt: Date }>(row: T): T & { expired?: true } {
    return this.isExpired(row) ? { ...row, status: "CANCELLED", expired: true } : row;
  }

  private async audit(tx: Prisma.TransactionClient, user: AuthUser, action: string, entityId: string): Promise<void> {
    await tx.auditEvent.create({
      data: { tenantId: user.tenantId, actorUserId: user.userId, action, entityType: "booking", entityId }
    });
  }

  /**
   * What a member may see and act on, decided by permission (never by role name): the whole tenant for a tenant
   * administrator, the bookings of the organization's services for staff holding booking.manage, and otherwise only
   * the member's own bookings. The routes themselves are guarded by booking.read.
   */
  private bookingScope(user: AuthUser): Prisma.BookingWhereInput {
    if (admin(user)) return { tenantId: user.tenantId };
    if (this.manages(user))
      return {
        tenantId: user.tenantId,
        service: { organization: { members: { some: { id: user.membershipId } } } }
      };
    return this.ownScope(user);
  }

  private ownScope(user: AuthUser): Prisma.BookingWhereInput {
    return { tenantId: user.tenantId, travelerMembershipId: user.membershipId };
  }

  /** Organization staff who may manage the bookings of their organization's services. */
  private manages(user: AuthUser): boolean {
    return operator(user) && user.permissions.includes("booking.manage");
  }

  /** Booking for oneself needs booking.create; a tenant administrator only books when also a traveler. */
  private canBookForSelf(user: AuthUser): boolean {
    return user.permissions.includes("booking.create") && (!admin(user) || user.roles.includes("traveler"));
  }

  /** Newest first, keyset-paged (see common/pagination.ts): `?limit=` and `?cursor=`, next cursor in `X-Next-Cursor`. */
  async listBookings(user: AuthUser, page: PageQueryDto, response: Response): Promise<unknown> {
    const rows = await this.prisma.booking.findMany({ ...keysetPage(page, this.bookingScope(user)), include: bookingInclude });
    return finishPage(rows.map((row) => this.present(row)), page, response);
  }

  private async lockService(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    id: string,
    active = true
  ): Promise<Prisma.TravelServiceGetPayload<{ include: { organization: true } }>> {
    const initial = await tx.travelService.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!initial) throw new NotFoundException("الخدمة غير موجودة");
    // Shared lock on the organization: bookings of different services no longer queue behind each other, while
    // anything that changes the organization (suspension, service edits take FOR UPDATE) still excludes them.
    // Capacity is serialized per service by the service row lock below (same lock order everywhere: org, then service).
    await tx.$queryRaw`SELECT "id" FROM "provider_organizations" WHERE "id"=${initial.providerOrganizationId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "travel_services" WHERE "id"=${id}::uuid FOR UPDATE`;
    const service = await tx.travelService.findUniqueOrThrow({
      where: { id, tenantId: user.tenantId },
      include: { organization: true }
    });
    if (active && (service.status !== "ACTIVE" || service.organization.status !== "ACTIVE"))
      throw new ConflictException("الخدمة أو المنشأة غير متاحة للحجز حالياً");
    return service;
  }

  async createBooking(user: AuthUser, input: CreateBookingDto, idempotencyKey?: string): Promise<unknown> {
    if (!this.canBookForSelf(user)) throw new ForbiddenException("إنشاء الحجز متاح للمسافر");
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey))
      throw new BadRequestException("Idempotency-Key must be 8-64 letters, digits, - or _");
    return this.prisma.$transaction(async (tx) => {
      // Lock first (a concurrent retry of the same request waits here and then finds the first booking), but do NOT require
      // the service to be bookable yet: a retry must get the stored booking even after midnight or after the service was
      // suspended, so the availability and date rules apply only to a request that is really new.
      const service = await this.lockService(tx, user, input.serviceId, false);
      if (idempotencyKey) {
        const first = await tx.booking.findFirst({
          where: { travelerMembershipId: user.membershipId, idempotencyKey },
          include: bookingInclude
        });
        if (first) {
          // Compare the raw request with what was stored; nothing is re-validated or re-priced.
          const perUnit = service.category === "HOTEL" || service.category === "TRANSPORT";
          const day = (value: Date | null): string | null => value?.toISOString().slice(0, 10) ?? null;
          const same = first.serviceId === service.id && first.travelersCount === input.travelersCount
            && first.units === (perUnit ? (input.units ?? 1) : input.travelersCount)
            && day(first.serviceDate) === input.serviceDate && day(first.endDate) === (input.endDate ?? null);
          if (!same) throw new ConflictException("Idempotency-Key was already used for a different booking request");
          return first;
        }
      }
      if (service.status !== "ACTIVE" || service.organization.status !== "ACTIVE")
        throw new ConflictException("الخدمة أو المنشأة غير متاحة للحجز حالياً");
      const terms = bookingTerms(
        service.category,
        service.details as Record<string, string>,
        service.priceCents,
        input,
        undefined,
        this.limits.maxDaysAhead
      );
      // One create per traveler at a time, across services, so parallel requests cannot pass the cap together.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"booking-pending:" + user.membershipId}, 0))`;
      await this.sweepExpired(tx, user, { OR: [{ serviceId: service.id }, { travelerMembershipId: user.membershipId }] });
      const open = await tx.booking.count({ where: { travelerMembershipId: user.membershipId, status: "PENDING" } });
      if (open >= this.limits.maxPendingPerTraveler) throw pendingLimitError();
      const existing = await tx.booking.findMany({
        where: { serviceId: service.id, ...this.liveWhere(), ...overlapWhere(terms) },
        select: inventorySelect
      });
      assertCapacity(service.capacity, existing, terms);
      const stored = {
        units: terms.units,
        serviceDate: terms.serviceDate,
        endDate: terms.endDate,
        totalCents: terms.totalCents
      };
      const booking = await tx.booking.create({
        data: {
          ...stored,
          tenantId: user.tenantId,
          serviceId: service.id,
          travelerMembershipId: user.membershipId,
          travelersCount: input.travelersCount,
          unitPriceCents: service.priceCents,
          currency: service.currency,
          notes: input.notes?.trim(),
          ...(idempotencyKey ? { idempotencyKey } : {})
        },
        include: bookingInclude
      });
      await this.audit(tx, user, "booking.create", booking.id);
      return booking;
    });
  }

  async updateBooking(user: AuthUser, id: string, input: UpdateBookingDto): Promise<unknown> {
    if (!admin(user) && !user.permissions.includes("booking.create"))
      throw new ForbiddenException("تعديل تفاصيل الحجز متاح للمسافر والمدير");
    // Only a tenant administrator edits other people's bookings; everyone else edits their own.
    const scope = admin(user) ? this.bookingScope(user) : this.ownScope(user);
    const result = await this.prisma.$transaction(async (tx) => {
      const first = await tx.booking.findFirst({ where: { id, ...scope } });
      if (!first) throw new NotFoundException("الحجز غير موجود");
      const service = await this.lockService(tx, user, first.serviceId);
      const booking = await tx.booking.findUniqueOrThrow({ where: { id, tenantId: user.tenantId } });
      if (this.isExpired(booking)) {
        await this.sweepExpired(tx, user, { id });
        return "expired" as const;
      }
      if (booking.status !== "PENDING") throw new ConflictException("يمكن تعديل الحجوزات المعلقة فقط");
      const terms = bookingTerms(
        service.category,
        service.details as Record<string, string>,
        booking.unitPriceCents,
        {
          travelersCount: input.travelersCount ?? booking.travelersCount,
          units: input.units ?? booking.units,
          serviceDate: input.serviceDate ?? booking.serviceDate.toISOString().slice(0, 10),
          endDate: input.endDate ?? booking.endDate?.toISOString().slice(0, 10)
        },
        undefined,
        this.limits.maxDaysAhead
      );
      const existing = await tx.booking.findMany({
        where: { serviceId: service.id, id: { not: id }, ...this.liveWhere(), ...overlapWhere(terms) },
        select: inventorySelect
      });
      assertCapacity(service.capacity, existing, terms);
      const stored = {
        units: terms.units,
        serviceDate: terms.serviceDate,
        endDate: terms.endDate,
        totalCents: terms.totalCents
      };
      const updated = await tx.booking.update({
        where: { id, tenantId: user.tenantId },
        data: { ...stored, travelersCount: input.travelersCount, notes: input.notes?.trim() },
        include: bookingInclude
      });
      await this.audit(tx, user, "booking.update", id);
      return updated;
    });
    if (result === "expired") throw expiredError();
    return result;
  }

  async updateBookingStatus(user: AuthUser, id: string, status: "CONFIRMED" | "CANCELLED"): Promise<unknown> {
    const manager = admin(user) || this.manages(user);
    if (!user.permissions.includes(manager ? "booking.manage" : "booking.create"))
      throw new ForbiddenException("صلاحية تغيير حالة الحجز غير متاحة لهذا الحساب");
    if (status === "CONFIRMED" && !manager)
      throw new ForbiddenException("تأكيد الحجز متاح للمنشأة والمدير فقط");
    const result = await this.prisma.$transaction(async (tx) => {
      const first = await tx.booking.findFirst({ where: { id, ...this.bookingScope(user) } });
      if (!first) throw new NotFoundException("الحجز غير موجود");
      await this.lockService(tx, user, first.serviceId, status === "CONFIRMED");
      const booking = await tx.booking.findUniqueOrThrow({ where: { id, tenantId: user.tenantId }, include: bookingInclude });
      if (status === "CONFIRMED" && this.isExpired(booking)) {
        // The lazy cancel must commit, so the refusal is raised after the transaction.
        await this.sweepExpired(tx, user, { serviceId: first.serviceId });
        return "expired" as const;
      }
      if (booking.status === status) return this.present(booking);
      if (booking.status === "CANCELLED")
        throw new ConflictException("لا يمكن إعادة تأكيد حجز ملغي؛ أنشئ حجزاً جديداً");
      const updated = await tx.booking.update({
        where: { id, tenantId: user.tenantId },
        data: { status },
        include: bookingInclude
      });
      await this.audit(tx, user, `booking.${status.toLowerCase()}`, id);
      return updated;
    });
    if (result === "expired") throw expiredError();
    return result;
  }
}
