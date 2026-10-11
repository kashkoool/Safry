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
      45000,
      { travelersCount: 4, units: 2, serviceDate: "2030-01-10", endDate: "2030-01-13" },
      "2030-01-01"
    );
    expect(result.totalCents).toBe(270000);
    expect(result.units).toBe(2);
    expect(result.nights).toBe(3);
  });
  it("charges vehicles and enforces their passenger limits", () => {
    expect(
      bookingTerms(
        "TRANSPORT",
        { seats: "4" },
        30000,
        { travelersCount: 4, units: 1, serviceDate: "2030-01-10" },
        "2030-01-01"
      ).totalCents
    ).toBe(30000);
    expect(() =>
      bookingTerms(
        "TRANSPORT",
        { seats: "4" },
        30000,
        { travelersCount: 5, units: 1, serviceDate: "2030-01-10" },
        "2030-01-01"
      )
    ).toThrow();
  });
  it("requires the flight date and charges seats", () => {
    const details = { departureDate: "2030-01-10" };
    expect(
      bookingTerms("FLIGHT", details, 120000, { travelersCount: 2, serviceDate: "2030-01-10" }, "2030-01-01")
        .totalCents
    ).toBe(240000);
    expect(() =>
      bookingTerms("FLIGHT", details, 120000, { travelersCount: 2, serviceDate: "2030-01-11" }, "2030-01-01")
    ).toThrow();
  });
  it("rejects missing, invalid and past dates and zero-night stays", () => {
    for (const serviceDate of ["", "2030-02-30", "2029-12-01"])
      expect(() =>
        bookingTerms("TOUR", {}, 10000, { travelersCount: 1, serviceDate }, "2030-01-01")
      ).toThrow();
    expect(() =>
      bookingTerms(
        "HOTEL",
        {},
        10000,
        { travelersCount: 1, serviceDate: "2030-01-10", endDate: "2030-01-10" },
        "2030-01-01"
      )
    ).toThrow();
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
