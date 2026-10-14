import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { assertCapacity, bookingTerms } from "./booking-rules.js";
import { assertCategory, validateDetails } from "../../travel-services/catalog.js";

describe("business provider scope", () => {
  it("allows optional translated text without changing numeric capacity or dates", () => {
    expect(validateDetails("HOTEL", { roomType: "Family" }, true)).toEqual({ roomType: "Family", mealPlan: "" });
    expect(() => validateDetails("HOTEL", { maxGuests: "100" }, true)).toThrow();
    expect(() => validateDetails("FLIGHT", { departureDate: "2027-01-01" }, true)).toThrow();
  });
  it("does not allow a hotel to offer flights", () => {
    expect(() => assertCategory("HOTEL", "FLIGHT")).toThrow();
    expect(() => assertCategory("UMRAH_COMPANY", "UMRAH")).not.toThrow();
  });
  it("requires the operational fields of each category", () => {
    expect(() => validateDetails("HOTEL", { roomType: "double" })).toThrow();
    expect(() =>
      validateDetails("FLIGHT", {
        flightNumber: "SF1",
        origin: "DAM",
        destination: "JED",
        departureDate: "2027-02-30",
        cabin: "Economy"
      })
    ).toThrow();
    expect(() =>
      validateDetails("HOTEL", {
        roomType: "double",
        maxGuests: "2",
        mealPlan: "breakfast",
        flightNumber: "x"
      })
    ).toThrow();
  });
});
describe("category-specific booking calculations", () => {
  it("charges rooms times nights, not traveler count", () => {
    const result = bookingTerms(
      "HOTEL",
      { maxGuests: "2" },
      45000n,
      { travelersCount: 4, units: 2, serviceDate: "2030-01-10", endDate: "2030-01-13" },
      "2030-01-01"
    );
    expect(result.totalCents).toBe(270000n);
    expect(result.units).toBe(2);
    expect(result.nights).toBe(3);
  });
  it("charges vehicles and enforces their passenger limits", () => {
    expect(
      bookingTerms(
        "TRANSPORT",
        { seats: "4" },
        30000n,
        { travelersCount: 4, units: 1, serviceDate: "2030-01-10" },
        "2030-01-01"
      ).totalCents
    ).toBe(30000n);
    expect(() =>
      bookingTerms(
        "TRANSPORT",
        { seats: "4" },
        30000n,
        { travelersCount: 5, units: 1, serviceDate: "2030-01-10" },
        "2030-01-01"
      )
    ).toThrow();
  });
  it("requires the flight date and charges seats", () => {
    const details = { departureDate: "2030-01-10" };
    expect(
      bookingTerms("FLIGHT", details, 120000n, { travelersCount: 2, serviceDate: "2030-01-10" }, "2030-01-01")
        .totalCents
    ).toBe(240000n);
    expect(() =>
      bookingTerms("FLIGHT", details, 120000n, { travelersCount: 2, serviceDate: "2030-01-11" }, "2030-01-01")
    ).toThrow();
  });
  it("rejects missing, invalid and past dates and zero-night stays", () => {
    for (const serviceDate of ["", "2030-02-30", "2029-12-01"])
      expect(() =>
        bookingTerms("TOUR", {}, 10000n, { travelersCount: 1, serviceDate }, "2030-01-01")
      ).toThrow();
    expect(() =>
      bookingTerms(
        "HOTEL",
        {},
        10000n,
        { travelersCount: 1, serviceDate: "2030-01-10", endDate: "2030-01-10" },
        "2030-01-01"
      )
    ).toThrow();
  });
});
describe("booking totals beyond 32 bits", () => {
  const hotel = (price: bigint, units: number, nights: number) =>
    bookingTerms("HOTEL", { maxGuests: "4" }, price, { travelersCount: 1, units, serviceDate: "2030-01-10", endDate: new Date(Date.parse("2030-01-10") + nights * 86400000).toISOString().slice(0, 10) }, "2030-01-01");
  it("computes exactly at and above 2147483647", () => {
    expect(hotel(67_108_864n, 16, 2).totalCents).toBe(2_147_483_648n);
    expect(hotel(100_000_000n, 20, 90).totalCents).toBe(180_000_000_000n);
    expect(bookingTerms("TOUR", {}, 2_147_483_647n, { travelersCount: 1, serviceDate: "2030-01-10" }, "2030-01-01").totalCents).toBe(2_147_483_647n);
    expect(bookingTerms("TOUR", {}, 2_147_483_648n, { travelersCount: 1, serviceDate: "2030-01-10" }, "2030-01-01").totalCents).toBe(2_147_483_648n);
  });
  it("accepts the largest exact JSON integer and rejects one above, or any overflow", () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    expect(bookingTerms("TOUR", {}, max, { travelersCount: 1, serviceDate: "2030-01-10" }, "2030-01-01").totalCents).toBe(max);
    expect(() => bookingTerms("TOUR", {}, max + 1n, { travelersCount: 1, serviceDate: "2030-01-10" }, "2030-01-01")).toThrow(BadRequestException);
    expect(() => bookingTerms("TOUR", {}, max, { travelersCount: 2, serviceDate: "2030-01-10" }, "2030-01-01")).toThrow(BadRequestException);
    expect(() => bookingTerms("TOUR", {}, 2n ** 70n, { travelersCount: 20, serviceDate: "2030-01-10" }, "2030-01-01")).toThrow(BadRequestException);
  });
  it("never produces a zero or negative total", () => {
    expect(() => bookingTerms("TOUR", {}, 0n, { travelersCount: 1, serviceDate: "2030-01-10" }, "2030-01-01")).toThrow(BadRequestException);
    expect(() => bookingTerms("TOUR", {}, -5n, { travelersCount: 1, serviceDate: "2030-01-10" }, "2030-01-01")).toThrow(BadRequestException);
  });
});
describe("dated inventory", () => {
  const existing = [
    { id: "one", units: 2, serviceDate: new Date("2030-01-10"), endDate: new Date("2030-01-12") }
  ];
  it("rejects overbooking on any overlapping night", () => {
    expect(() =>
      assertCapacity(3, existing, {
        units: 2,
        serviceDate: new Date("2030-01-11"),
        endDate: new Date("2030-01-13")
      })
    ).toThrow();
  });
  it("makes rooms available on the checkout date", () => {
    expect(() =>
      assertCapacity(3, existing, {
        units: 3,
        serviceDate: new Date("2030-01-12"),
        endDate: new Date("2030-01-13")
      })
    ).not.toThrow();
  });
  it("does not sum non-overlapping reservations", () => {
    const later = {
      id: "two",
      units: 2,
      serviceDate: new Date("2030-01-12"),
      endDate: new Date("2030-01-14")
    };
    expect(() =>
      assertCapacity(3, [...existing, later], {
        units: 1,
        serviceDate: new Date("2030-01-10"),
        endDate: new Date("2030-01-14")
      })
    ).not.toThrow();
  });
});
