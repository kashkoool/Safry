import { describe, expect, it } from "vitest";
import { TENANT_KEY, TenantIsolationError, confineToTenant } from "./tenant-scope.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

describe("confineToTenant", () => {
  it("leaves models without a tenant key untouched", () => {
    const args = { where: { id: "u1" } };
    expect(confineToTenant("User", "findMany", args, tenant)).toBe(args);
    expect(confineToTenant("Permission", "create", { data: { code: "x" } }, tenant)).toEqual({ data: { code: "x" } });
  });

  it("covers every tenant-owned model, keyed by id for the tenant itself", () => {
    expect(TENANT_KEY["Tenant"]).toBe("id");
    for (const model of ["Booking", "TravelService", "Role", "TenantMembership", "ProviderOrganization", "RefreshSession", "AuditEvent"])
      expect(TENANT_KEY[model]).toBe("tenantId");
  });

  describe("reads and filtered writes", () => {
    it("adds the tenant to a missing or partial where", () => {
      expect(confineToTenant("Booking", "findMany", undefined, tenant)).toEqual({ where: { tenantId: tenant } });
      expect(confineToTenant("Booking", "findMany", { where: { status: "PENDING" }, take: 5 }, tenant)).toEqual({
        where: { status: "PENDING", tenantId: tenant },
        take: 5
      });
      expect(confineToTenant("Booking", "count", {}, tenant)).toEqual({ where: { tenantId: tenant } });
      expect(confineToTenant("Booking", "deleteMany", { where: { id: "b" } }, tenant)).toEqual({ where: { id: "b", tenantId: tenant } });
    });

    it("accepts a where that already names this tenant", () => {
      const args = { where: { tenantId: tenant, id: "b" } };
      expect(confineToTenant("Booking", "findFirst", args, tenant)).toEqual(args);
    });

    it("rejects a where that names another tenant", () => {
      expect(() => confineToTenant("Booking", "findFirst", { where: { tenantId: other } }, tenant)).toThrow(TenantIsolationError);
      expect(() => confineToTenant("Tenant", "findUnique", { where: { id: other } }, tenant)).toThrow(/another tenant/);
    });

    it("wraps a filter on the tenant key instead of replacing it, but never for unique lookups", () => {
      const wrapped = confineToTenant("Booking", "findMany", { where: { tenantId: { in: [tenant, other] } } }, tenant) as {
        where: { AND: unknown[] };
      };
      expect(wrapped.where.AND).toEqual([{ tenantId: { in: [tenant, other] } }, { tenantId: tenant }]);
      expect(() => confineToTenant("Booking", "findUnique", { where: { tenantId: { in: [other] } } }, tenant)).toThrow(TenantIsolationError);
    });

    it("confines unique lookups and keeps compound unique keys", () => {
      expect(confineToTenant("Role", "findUnique", { where: { id: "r" } }, tenant)).toEqual({ where: { id: "r", tenantId: tenant } });
      const compound = { where: { tenantId_code: { tenantId: tenant, code: "traveler" } } };
      expect(confineToTenant("Role", "findUnique", compound, tenant)).toEqual({
        where: { tenantId_code: { tenantId: tenant, code: "traveler" }, tenantId: tenant }
      });
      expect(confineToTenant("Tenant", "findUnique", { where: { code: "safry" } }, tenant)).toEqual({ where: { code: "safry", id: tenant } });
    });
  });

  describe("creates", () => {
    it("stamps the tenant when the data does not carry one", () => {
      expect(confineToTenant("Booking", "create", { data: { totalCents: 1 } }, tenant)).toEqual({ data: { totalCents: 1, tenantId: tenant } });
    });

    it("does not mix a tenant key into a relation-style create", () => {
      const args = { data: { name: "x", tenant: { connect: { id: tenant } } } };
      expect(confineToTenant("Role", "create", args, tenant)).toEqual(args);
    });

    it("rejects a relation-style create that connects another tenant or anything but the own tenant", () => {
      for (const relation of [
        { connect: { id: other } },
        { connect: { code: "x" } },
        { connect: { id: tenant, code: "x" } },
        { create: { code: "x", name: "x" } },
        { connectOrCreate: { where: { id: tenant }, create: {} } },
        null
      ])
        expect(() => confineToTenant("Role", "create", { data: { name: "x", tenant: relation } }, tenant)).toThrow(TenantIsolationError);
    });

    it("rejects data aimed at another tenant", () => {
      expect(() => confineToTenant("Booking", "create", { data: { tenantId: other } }, tenant)).toThrow(TenantIsolationError);
      expect(() => confineToTenant("Booking", "createMany", { data: [{ tenantId: tenant }, { tenantId: other }] }, tenant)).toThrow(
        TenantIsolationError
      );
    });

    it("stamps every row of a bulk create", () => {
      expect(confineToTenant("MembershipRole", "createMany", { data: [{ roleId: "a" }, { roleId: "b", tenantId: tenant }] }, tenant)).toEqual({
        data: [{ roleId: "a", tenantId: tenant }, { roleId: "b", tenantId: tenant }]
      });
    });

    it("never lets a tenant session create tenants", () => {
      expect(() => confineToTenant("Tenant", "create", { data: { code: "x", name: "x" } }, tenant)).toThrow(/platform/);
    });

    it("stamps the session's tenant on an audit event written without one", () => {
      const args = { data: { tenantId: null, action: "identity.login.failed" } };
      expect(confineToTenant("AuditEvent", "create", args, tenant)).toEqual({ data: { tenantId: tenant, action: "identity.login.failed" } });
      expect(() => confineToTenant("Booking", "create", { data: { tenantId: null } }, tenant)).toThrow(TenantIsolationError);
    });
  });

  describe("updates", () => {
    it("refuses to move a row to another tenant", () => {
      expect(() => confineToTenant("Booking", "update", { where: { id: "b" }, data: { tenantId: other } }, tenant)).toThrow(TenantIsolationError);
      expect(() => confineToTenant("Booking", "updateMany", { data: { tenantId: other } }, tenant)).toThrow(TenantIsolationError);
    });

    it("confines upserts on both the lookup and the created row", () => {
      const result = confineToTenant(
        "Role",
        "upsert",
        { where: { id: "r" }, create: { code: "c" }, update: { name: "n" } },
        tenant
      ) as { where: object; create: object };
      expect(result.where).toEqual({ id: "r", tenantId: tenant });
      expect(result.create).toEqual({ code: "c", tenantId: tenant });
      expect(() => confineToTenant("Role", "upsert", { where: { id: "r" }, create: { tenantId: other }, update: {} }, tenant)).toThrow(
        TenantIsolationError
      );
    });
  });

  it("does not mutate the caller's arguments", () => {
    const args = { where: { status: "PENDING" } };
    confineToTenant("Booking", "findMany", args, tenant);
    expect(args).toEqual({ where: { status: "PENDING" } });
  });
});
