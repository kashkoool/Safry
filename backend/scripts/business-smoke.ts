import "dotenv/config";
import { assertDevDatabase } from "../src/config/script-guard.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hash } from "argon2";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { hotp, totpStep } from "../src/common/security/totp.js";

assertDevDatabase("business-smoke");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const base = process.env["SMOKE_API_BASE"] ?? "http://127.0.0.1:3000/api/v1";
const tenantIds: string[] = [];
const userIds: string[] = [];
const password = `Test-${randomUUID()}!`;
const stamp = randomUUID().slice(0, 8);
let checks = 0;
const exercised = new Set<string>();
let documented: Array<{ method: string; path: string }> = [];
type Session = {
  accessToken: string;
  refreshToken: string;
  user: { tenantId: string; userId: string; membershipId: string };
};
type Json = Record<string, any>; // Integration responses are checked with assertions below.
async function call(
  path: string,
  method: string,
  session?: Session,
  body?: unknown,
  expected = 200
): Promise<Json> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-client": "mobile",
      ...(session
        ? { authorization: `Bearer ${session.accessToken}`, "x-tenant-id": session.user.tenantId }
        : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = response.status === 204 ? {} : (await response.json()) as Json;
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
  const pathname = path.split("?")[0]!;
  const route = documented.find(item => item.method === method && new RegExp(`^${item.path.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(pathname));
  if (route) exercised.add(`${method} ${route.path}`);
  checks++;
  console.log(`OK ${method} ${path}: ${response.status}`);
  return result;
}
const future = (days: number): string => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
async function main(): Promise<void> {
  const specResponse = await fetch(`${base}/docs-json`);
  assert.equal(specResponse.status, 200);
  const spec = await specResponse.json() as { paths: Record<string, Record<string, unknown>> };
  documented = Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods)
    .filter(method => ["get", "post", "patch", "put", "delete"].includes(method))
    .map(method => ({ method: method.toUpperCase(), path: path.replace(/^\/api\/v1/, "") })));
  await call("/health/live", "GET");
  const readiness = await call("/health/ready", "GET");
  assert.equal(readiness.database, "reachable");
  const proxyReadiness = await fetch(`${process.env["SMOKE_WEB_BASE"] ?? "http://127.0.0.1:3001"}/api/v1/health/ready`);
  assert.equal(proxyReadiness.status, 200);
  const tenant = await prisma.tenant.create({
    data: { code: `qa-${stamp}`, name: "Temporary business test" }
  });
  tenantIds.push(tenant.id);
  const foreign = await prisma.tenant.create({
    data: { code: `qa-other-${stamp}`, name: "Temporary other tenant" }
  });
  tenantIds.push(foreign.id);
  const allPermissions = await prisma.permission.findMany();
  const roleMap: Record<string, string> = {};
  for (const code of ["tenant-admin", "travel-company", "service-provider", "traveler", "organization-manager"]) {
    const allowed =
      code === "tenant-admin"
        ? allPermissions
        : code === "organization-manager"
          ? allPermissions.filter((permission) => permission.code === "organization.staff.manage")
        : allPermissions.filter((permission) =>
            [
              "tenant.read",
              "catalog.service.read",
              "booking.read",
              ...(code === "traveler" ? ["booking.create"] : ["catalog.service.manage", "booking.manage"])
            ].includes(permission.code)
          );
    const role = await prisma.role.create({
      data: {
        tenantId: tenant.id,
        code,
        name: code,
        permissions: { create: allowed.map((permission) => ({ permissionId: permission.id })) }
      }
    });
    roleMap[code] = role.id;
  }
  async function account(
    alias: string,
    roleCode: string,
    type?: "HOTEL" | "AIRLINE" | "UMRAH_COMPANY"
  ): Promise<{ session: Session; organizationId?: string }> {
    const email = `${alias}-${stamp}@test.safry.local`;
    const user = await prisma.user.create({
      data: {
        email,
        emailNormalized: email,
        displayName: alias,
        passwordHash: await hash(password),
        emailVerifiedAt: new Date(),
        isPlatformAdmin: alias === "admin"
      }
    });
    userIds.push(user.id);
    const org = type
      ? await prisma.providerOrganization.create({
          data: {
            tenantId: tenant.id,
            name: `${alias} organization`,
            type,
            city: "Test City",
            contactEmail: email
          }
        })
      : null;
    const member = await prisma.tenantMembership.create({
      data: { tenantId: tenant.id, userId: user.id, status: "ACTIVE", providerOrganizationId: org?.id }
    });
    await prisma.membershipRole.create({
      data: { tenantId: tenant.id, membershipId: member.id, roleId: roleMap[roleCode]! }
    });
    return {
      session: (await call("/auth/login", "POST", undefined, {
        email,
        password,
        tenantCode: tenant.code
      })) as Session,
      organizationId: org?.id
    };
  }
  const traveler = await account("traveler", "traveler");
  const otherTraveler = await account("traveler2", "traveler");
  const hotel = await account("hotel", "service-provider", "HOTEL");
  const hotel2 = await account("hotel2", "service-provider", "HOTEL");
  const airline = await account("airline", "service-provider", "AIRLINE");
  const company = await account("umrah", "travel-company", "UMRAH_COMPANY");
  const admin = await account("admin", "tenant-admin");
  // Platform routes need an enrolled second factor: enrol the administrator through the (guard-exempt) MFA endpoints.
  const adminSetup = await call("/auth/mfa/setup", "POST", admin.session, { password }, 200);
  await call("/auth/mfa/enable", "POST", admin.session, { code: hotp(adminSetup.secret as string, totpStep()) }, 200);
  const tenantAdmin = await account("tenantadmin", "tenant-admin");
  const me = await call("/auth/me", "GET", traveler.session);
  assert.equal(me.userId, traveler.session.user.userId);
  const currentTenant = await call("/tenants/current", "GET", traveler.session);
  assert.equal(currentTenant.id, tenant.id);
  const members = await call("/tenants/members", "GET", tenantAdmin.session);
  assert.ok(Array.isArray(members));
  assert.ok(!JSON.stringify(members).includes("passwordHash"));
  await call("/tenants/members", "GET", traveler.session, undefined, 403);
  const workspace = await call("/providers/workspace", "GET", hotel.session);
  assert.equal(workspace.organization.id, hotel.organizationId);
  const providers = await call("/providers", "GET", tenantAdmin.session);
  assert.ok(Array.isArray(providers));
  const ratesResponse = await fetch(`${base}/services/exchange-rates`, {
    headers: { authorization: `Bearer ${traveler.session.accessToken}` }
  });
  const rates = await ratesResponse.json() as Json;
  assert.ok([200, 503].includes(ratesResponse.status), JSON.stringify(rates));
  exercised.add("GET /services/exchange-rates");
  if (ratesResponse.status === 200) {
    for (const code of ["TRY", "SYP", "SAR", "USD", "EUR", "EGP"]) {
      assert.ok(rates.rates[code].rate > 0);
      assert.match(rates.rates[code].date, /^\d{4}-\d{2}-\d{2}$/);
    }
    console.log(`EXCHANGE LIVE: 200, six currencies; dates ${JSON.stringify(Object.fromEntries(Object.entries(rates.rates).map(([code, row]) => [code, (row as Json).date])))}`);
  } else {
    console.log("EXCHANGE DEGRADED: 503; external rates unavailable, original-price fallback only");
  }
  checks++;
  await call("/auth/login", "POST", undefined,
    { email: `traveler-${stamp}@test.safry.local`, password, tenantCode: tenant.code, portal: "customer" });
  await call("/auth/login", "POST", undefined,
    { email: `traveler-${stamp}@test.safry.local`, password, tenantCode: tenant.code, portal: "admin" }, 401);
  await call("/auth/login", "POST", undefined,
    { email: `hotel-${stamp}@test.safry.local`, password, tenantCode: tenant.code, portal: "provider" });
  await call("/auth/login", "POST", undefined,
    { email: `hotel-${stamp}@test.safry.local`, password, tenantCode: tenant.code, portal: "customer" }, 401);
  await call("/auth/login", "POST", undefined,
    { email: `admin-${stamp}@test.safry.local`, password, tenantCode: tenant.code, portal: "admin" });
  await call("/auth/login", "POST", undefined,
    { email: `admin-${stamp}@test.safry.local`, password, tenantCode: tenant.code, portal: "provider" }, 401);
  const registeredTravelerEmail = `registered-traveler-${stamp}@test.safry.local`;
  await call("/auth/register/customer", "POST", undefined,
    { displayName: "New traveler", email: registeredTravelerEmail, password, tenantCode: tenant.code }, 201);
  await call("/auth/register/employee", "POST", undefined,
    { displayName: "No self registration", email: `no-staff-${stamp}@test.safry.local`, password,
      tenantCode: tenant.code, organizationId: hotel.organizationId, jobTitle: "Agent" }, 404);
  userIds.push((await prisma.user.findUniqueOrThrow({ where: { emailNormalized: registeredTravelerEmail } })).id);
  // Self-registered accounts sign in only after confirming their address (the mail flow is covered by the integration suites).
  await call("/auth/login", "POST", undefined,
    { email: registeredTravelerEmail, password, tenantCode: tenant.code, portal: "customer" }, 401);
  await prisma.user.update({ where: { emailNormalized: registeredTravelerEmail }, data: { emailVerifiedAt: new Date() } });
  await call("/auth/login", "POST", undefined,
    { email: registeredTravelerEmail, password, tenantCode: tenant.code, portal: "customer" });
  const registeredProviderEmail = `registered-provider-${stamp}@test.safry.local`;
  await call("/auth/register/provider", "POST", undefined,
    { displayName: "Provider owner", email: registeredProviderEmail, password, tenantCode: tenant.code,
      organizationName: "فندق الاختبار", organizationNameEn: "Pending QA Hotel", type: "HOTEL", city: "Makkah", phone: "", licenseNumber: "" }, 201);
  const registeredProvider = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: registeredProviderEmail } });
  userIds.push(registeredProvider.id);
  await prisma.user.update({ where: { id: registeredProvider.id }, data: { emailVerifiedAt: new Date() } });
  const registeredMembership = await prisma.tenantMembership.findFirstOrThrow({
    where: { userId: registeredProvider.id, tenantId: tenant.id }, include: { organization: true }
  });
  assert.equal(registeredMembership.organization?.status, "SUSPENDED");
  assert.equal(registeredMembership.organization?.nameAr, "فندق الاختبار");
  assert.equal(registeredMembership.organization?.nameEn, "Pending QA Hotel");
  checks += 2;
  checks++;
  const registeredProviderSession = await call("/auth/login", "POST", undefined,
    { email: registeredProviderEmail, password, tenantCode: tenant.code, portal: "provider" }) as Session;
  // A self-registered organization stays suspended until the tenant administration activates it.
  await call(`/organizations/${registeredMembership.providerOrganizationId}/roles`, "POST", registeredProviderSession,
    { code: "pending-role", name: "قبل التفعيل", permissions: [] }, 403);
  await call(`/providers/${registeredMembership.providerOrganizationId}/status`, "PATCH", tenantAdmin.session, { status: "ACTIVE" });
  await call(`/organizations/${registeredMembership.providerOrganizationId}/roles`, "POST", registeredProviderSession,
    { code: "frontdesk", name: "الاستقبال", permissions: ["booking.read"] }, 201);
  await call(`/organizations/${hotel.organizationId}/roles`, "POST", registeredProviderSession,
    { code: "foreign", name: "دور خارجي", permissions: [] }, 403);
  await call(`/organizations/${hotel.organizationId}/management`, "GET", hotel.session, undefined, 403);
  await call(`/organizations/${hotel.organizationId}/management`, "GET", hotel2.session, undefined, 403);
  const companyOrganization = await call(`/organizations/${company.organizationId}/management`, "GET", tenantAdmin.session);
  assert.equal(companyOrganization.organization.name, "umrah organization");
  checks++;
  await call(`/organizations/${company.organizationId}/specialties`, "PATCH", tenantAdmin.session,
    { specialties: ["برامج العمرة", "الإقامة والنقل"] });
  const department = await call(`/organizations/${company.organizationId}/departments`, "POST", tenantAdmin.session,
    { code: "bookings", name: "إدارة الحجوزات" }, 201);
  const renamedDepartment = await call(`/organizations/${company.organizationId}/departments/${department.id}`, "PATCH", tenantAdmin.session,
    { name: "متابعة الحجوزات", active: true });
  assert.equal(renamedDepartment.name, "متابعة الحجوزات");
  await call(`/organizations/${hotel.organizationId}/departments/${department.id}`, "PATCH", tenantAdmin.session,
    { name: "Cross-company update" }, 404);
  const companyRole = await call(`/organizations/${company.organizationId}/roles`, "POST", tenantAdmin.session,
    { code: "booking-agent", name: "موظف حجوزات", permissions: ["booking.read", "booking.manage"] }, 201);
  await call(`/organizations/${company.organizationId}/roles`, "POST", hotel.session,
    { code: "forbidden", name: "دور ممنوع", permissions: ["booking.read"] }, 403);
  const hotelDepartment = await call(`/organizations/${hotel.organizationId}/departments`, "POST", tenantAdmin.session,
    { code: "frontdesk", name: "الاستقبال" }, 201);
  await call(`/organizations/${hotel.organizationId}/employees`, "POST", tenantAdmin.session,
    { email: `wrong-role-${stamp}@test.safry.local`, displayName: "Wrong role", password,
      jobTitle: "Agent", departmentId: hotelDepartment.id, roleIds: [companyRole.id] }, 403);
  await call(`/organizations/${hotel.organizationId}/employees`, "POST", company.session,
    { email: `blocked-${stamp}@test.safry.local`, displayName: "Blocked", password, jobTitle: "Staff",
      departmentId: department.id, roleIds: [roleMap["service-provider"]] }, 403);
  const staffEmail = `staff-${stamp}@test.safry.local`;
  const employee = await call(`/organizations/${company.organizationId}/employees`, "POST", tenantAdmin.session,
    { email: staffEmail, displayName: "Bookings employee", password, jobTitle: "Bookings agent",
      departmentId: department.id, roleIds: [companyRole.id],
      permissionOverrides: { "booking.manage": false } }, 201);
  userIds.push(employee.user.id);
  assert.equal(employee.departmentId, department.id);
  checks++;
  const staffSession = await call("/auth/login", "POST", undefined,
    { email: staffEmail, password, tenantCode: tenant.code, portal: "provider" }) as Session;
  await call("/bookings", "GET", staffSession);
  await call("/services", "GET", staffSession, undefined, 403);
  await call(`/organizations/${hotel.organizationId}/roles/${companyRole.id}`, "PATCH", tenantAdmin.session,
    { name: "Other company role", permissions: [] }, 404);
  await call(`/organizations/${company.organizationId}/roles/${companyRole.id}`, "PATCH", tenantAdmin.session,
    { name: "موظف متابعة", permissions: ["booking.read"] });
  await call("/auth/me", "GET", staffSession, undefined, 401);
  await call(`/organizations/${company.organizationId}/employees/${employee.id}`, "PATCH", tenantAdmin.session,
    { status: "SUSPENDED" });
  await call("/auth/login", "POST", undefined,
    { email: staffEmail, password, tenantCode: tenant.code }, 401);
  await call(`/organizations/${company.organizationId}/employees/${employee.id}`, "PATCH", tenantAdmin.session,
    { status: "REVOKED" });
  await call("/auth/login", "POST", undefined,
    { email: staffEmail, password, tenantCode: tenant.code }, 401);
  const ownerEmail = `new-owner-${stamp}@test.safry.local`;
  const newOrganization = await call("/providers", "POST", tenantAdmin.session,
    { name: "رؤيا للاختبار", nameAr: "رؤيا للاختبار", nameEn: "Ruya QA", type: "UMRAH_COMPANY", city: "Makkah", contactEmail: ownerEmail,
      phone: "", licenseNumber: "", password }, 201);
  const ownerUser = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: ownerEmail } });
  userIds.push(ownerUser.id);
  const ownerSession = await call("/auth/login", "POST", undefined,
    { email: ownerEmail, password, tenantCode: tenant.code }) as Session;
  await call(`/organizations/${newOrganization.id}/management`, "GET", ownerSession);
  const renamed = await call(`/providers/${newOrganization.id}`, "PATCH", ownerSession,
    { nameAr: "رؤيا المعدلة", nameEn: "Ruya Updated" });
  assert.equal(renamed.nameAr, "رؤيا المعدلة");
  assert.equal(renamed.nameEn, "Ruya Updated");
  checks += 2;
  await call(`/providers/${newOrganization.id}`, "PATCH", ownerSession, { nameEn: "" }, 400);
  await call(`/organizations/${company.organizationId}/management`, "GET", ownerSession, undefined, 403);
  await call("/platform/overview", "GET", traveler.session, undefined, 403);
  await call("/platform/overview", "GET", tenantAdmin.session, undefined, 403);
  await call("/platform/overview", "GET", admin.session);
  const references = await call("/platform/references", "GET", admin.session);
  assert.ok(references.tenants.some((t: Json) => t.id === foreign.id));
  checks++;
  await call(
    `/platform/users/${admin.session.user.userId}/state`,
    "POST",
    admin.session,
    { action: "DELETE", reason: "Must reject self deletion" },
    409
  );
  await call(
    `/platform/users/${admin.session.user.userId}`,
    "PATCH",
    admin.session,
    { isPlatformAdmin: false },
    409
  );
  const createdEmail = `created-${stamp}@test.safry.local`;
  const created = await call(
    "/platform/users",
    "POST",
    admin.session,
    {
      displayName: "QA created traveler",
      email: createdEmail,
      phone: "",
      password,
      tenantId: tenant.id,
      roleId: roleMap.traveler
    },
    201
  );
  userIds.push(created.id);
  assert.ok(!("passwordHash" in created));
  checks++;
  const createdMember = created.memberships[0];
  const loginCreated = async () =>
    (await call("/auth/login", "POST", undefined, {
      email: createdEmail,
      password,
      tenantCode: tenant.code
    })) as Session;
  let createdSession = await loginCreated();
  await call(`/platform/users/${created.id}`, "PATCH", traveler.session, { displayName: "No access" }, 403);
  await call(`/platform/users/${created.id}`, "PATCH", admin.session, {
    displayName: "QA renamed traveler",
    phone: "123456789"
  });
  await call(`/platform/users/${created.id}`, "PATCH", admin.session, { displayName: "  " }, 400);
  await call(`/platform/users/${created.id}`, "PATCH", admin.session, { isPlatformAdmin: "true" }, 400);
  await call(
    `/platform/memberships/${createdMember.id}/access`,
    "PATCH",
    admin.session,
    { roleIds: [roleMap.traveler], permissionOverrides: { "booking.create": "no" }, status: "ACTIVE" },
    400
  );
  await call(`/platform/memberships/${createdMember.id}/access`, "PATCH", admin.session, {
    roleIds: [roleMap.traveler],
    permissionOverrides: { "booking.create": false },
    status: "ACTIVE"
  });
  await call("/auth/me", "GET", createdSession, undefined, 401);
  await call("/auth/refresh", "POST", undefined, { refreshToken: createdSession.refreshToken }, 401);
  createdSession = await loginCreated();
  assert.ok(!(createdSession as unknown as Json).user.permissions.includes("booking.create"));
  checks++;
  await call(
    "/bookings",
    "POST",
    createdSession,
    { serviceId: randomUUID(), serviceDate: future(30), travelersCount: 1 },
    403
  );
  await call(`/platform/users/${created.id}/revoke-sessions`, "POST", admin.session, undefined, 201);
  await call("/auth/me", "GET", createdSession, undefined, 401);
  createdSession = await loginCreated();
  await call(
    `/platform/users/${created.id}/state`,
    "POST",
    admin.session,
    { action: "SUSPENDED", reason: "Temporary QA suspension" },
    201
  );
  await call("/auth/me", "GET", createdSession, undefined, 401);
  await call(
    "/auth/login",
    "POST",
    undefined,
    { email: createdEmail, password, tenantCode: tenant.code },
    401
  );
  await call(
    `/platform/users/${created.id}/state`,
    "POST",
    admin.session,
    { action: "ACTIVE", reason: "Temporary QA activation" },
    201
  );
  await loginCreated();
  await call(
    `/platform/users/${created.id}/state`,
    "POST",
    admin.session,
    { action: "DELETE", reason: "Temporary QA soft delete" },
    201
  );
  assert.ok(await prisma.tenantMembership.findUnique({ where: { id: createdMember.id } }));
  checks++;
  await call(
    "/auth/login",
    "POST",
    undefined,
    { email: createdEmail, password, tenantCode: tenant.code },
    401
  );
  await call(
    `/platform/users/${created.id}/state`,
    "POST",
    admin.session,
    { action: "ACTIVE", reason: "Must restore first" },
    409
  );
  await call(
    `/platform/users/${created.id}/state`,
    "POST",
    admin.session,
    { action: "RESTORE", reason: "Temporary QA restore" },
    201
  );
  await call(
    `/platform/users/${created.id}/state`,
    "POST",
    admin.session,
    { action: "ACTIVE", reason: "Temporary QA activation" },
    201
  );
  await loginCreated();
  for (const kind of ["users", "tenants", "providers", "services", "bookings", "audit", "sessions"]) {
    const list = await call(`/platform/records/${kind}?tenantId=${tenant.id}`, "GET", admin.session);
    const serialized = JSON.stringify(list);
    assert.ok(
      !serialized.includes("passwordHash") &&
        !serialized.includes("tokenHash") &&
        !serialized.includes(password)
    );
    checks++;
  }
  const audit = await call(`/platform/records/audit?q=${created.id}`, "GET", admin.session);
  assert.ok(audit.items.some((event: Json) => event.action === "platform.account.delete"));
  checks++;
  const room = {
    title: "Double room QA",
    description: "A temporary test room for bookings",
    category: "HOTEL",
    city: "Makkah",
    priceCents: 10000,
    capacity: 2,
    details: { roomType: "Double", maxGuests: "2", mealPlan: "Breakfast" },
    componentIds: []
  };
  const service = await call("/services", "POST", hotel.session, room, 201);
  await call(
    "/services",
    "POST",
    hotel.session,
    {
      ...room,
      category: "FLIGHT",
      details: {
        flightNumber: "T1",
        origin: "DAM",
        destination: "JED",
        departureDate: future(30),
        cabin: "Economy"
      }
    },
    403
  );
  await call(`/services/${service.id}`, "PATCH", hotel2.session, { priceCents: 20000 }, 404);
  await call(`/services/${service.id}`, "PATCH", traveler.session, { priceCents: 20000 }, 403);
  const own = await call("/services", "GET", airline.session);
  assert.equal((own as unknown as unknown[]).length, 0);
  const packageService = await call(
    "/services",
    "POST",
    company.session,
    {
      ...room,
      category: "UMRAH",
      details: { durationDays: "8", departureCity: "Damascus", itinerary: "Makkah and Madinah" },
      componentIds: [service.id]
    },
    201
  );
  assert.equal(packageService.components[0].serviceId, service.id);
  checks++;
  await call("/services", "POST", hotel.session, { ...room, componentIds: [service.id] }, 400);
  const foreignUser = await prisma.user.create({
    data: {
      email: `foreign-${stamp}@test.safry.local`,
      emailNormalized: `foreign-${stamp}@test.safry.local`,
      displayName: "Foreign",
      passwordHash: await hash(password),
      emailVerifiedAt: new Date()
    }
  });
  userIds.push(foreignUser.id);
  const foreignOrg = await prisma.providerOrganization.create({
    data: {
      tenantId: foreign.id,
      name: "Foreign hotel",
      type: "HOTEL",
      city: "Elsewhere",
      contactEmail: foreignUser.email
    }
  });
  const foreignMember = await prisma.tenantMembership.create({
    data: {
      tenantId: foreign.id,
      userId: foreignUser.id,
      status: "ACTIVE",
      providerOrganizationId: foreignOrg.id
    }
  });
  const foreignService = await prisma.travelService.create({
    data: {
      tenantId: foreign.id,
      providerMembershipId: foreignMember.id,
      providerOrganizationId: foreignOrg.id,
      title: "Foreign room",
      description: "Test only foreign room",
      category: "HOTEL",
      city: "Elsewhere",
      priceCents: 10000,
      status: "ACTIVE"
    }
  });
  await call(`/services/${foreignService.id}`, "PATCH", admin.session, { title: "No access" }, 404);
  const globalServices = await call(
    `/platform/records/services?tenantId=${foreign.id}`,
    "GET",
    admin.session
  );
  assert.ok(globalServices.items.some((item: Json) => item.id === foreignService.id));
  checks++;
  await call(`/platform/users/${foreignUser.id}`, "PATCH", admin.session, {
    displayName: "Foreign account managed globally"
  });
  await call(
    `/platform/users/${foreignUser.id}`,
    "PATCH",
    tenantAdmin.session,
    { displayName: "Forbidden" },
    403
  );
  await call(
    `/platform/memberships/${createdMember.id}/access`,
    "PATCH",
    admin.session,
    {
      roleIds: [roleMap.traveler],
      permissionOverrides: {},
      status: "ACTIVE",
      providerOrganizationId: foreignOrg.id
    },
    400
  );
  await call(
    `/services/${packageService.id}`,
    "PATCH",
    company.session,
    { componentIds: [foreignService.id] },
    400
  );
  const request = {
    serviceId: service.id,
    travelersCount: 4,
    units: 2,
    serviceDate: future(30),
    endDate: future(33)
  };
  const booking = await call("/bookings", "POST", traveler.session, request, 201);
  assert.equal(booking.totalCents, 60000);
  checks++;
  await call("/bookings", "POST", otherTraveler.session, { ...request, travelersCount: 1, units: 1 }, 409);
  await call(`/bookings/${booking.id}`, "PATCH", otherTraveler.session, { notes: "not mine" }, 404);
  await call(`/bookings/${booking.id}/status`, "PATCH", hotel2.session, { status: "CONFIRMED" }, 404);
  await call(`/bookings/${booking.id}/status`, "PATCH", traveler.session, { status: "CONFIRMED" }, 403);
  await call(`/services/${service.id}`, "PATCH", hotel.session, { priceCents: 20000 });
  const edited = await call(`/bookings/${booking.id}`, "PATCH", traveler.session, {
    notes: "keep agreed price"
  });
  assert.equal(edited.totalCents, 60000);
  checks++;
  await call(`/bookings/${booking.id}/status`, "PATCH", hotel.session, { status: "CONFIRMED" });
  await call(`/bookings/${booking.id}`, "PATCH", traveler.session, { units: 1 }, 409);
  await call(`/bookings/${booking.id}/status`, "PATCH", traveler.session, { status: "CANCELLED" });
  await call(`/bookings/${booking.id}/status`, "PATCH", hotel.session, { status: "CONFIRMED" }, 409);
  // Simultaneous requests for all rooms: one wins, the other must fail.
  const responses = await Promise.all(
    [traveler, otherTraveler].map((actor) =>
      fetch(`${base}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${actor.session.accessToken}` },
        body: JSON.stringify(request)
      })
    )
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  checks++;
  await call(`/providers/${hotel.organizationId}/status`, "PATCH", admin.session, { status: "SUSPENDED" });
  await call(
    "/bookings",
    "POST",
    traveler.session,
    { ...request, serviceDate: future(40), endDate: future(41) },
    409
  );
  await call(`/services/${service.id}`, "PATCH", hotel.session, { priceCents: 10000 }, 403);
  const market = await call("/services/marketplace", "GET", traveler.session);
  assert.ok(!(market as unknown as Json[]).some((item) => item.id === service.id));
  checks++;
  const preserved = await prisma.booking.count({
    where: { travelerMembershipId: traveler.session.user.membershipId }
  });
  await call(
    `/platform/users/${traveler.session.user.userId}/state`,
    "POST",
    admin.session,
    { action: "DELETE", reason: "QA verify business history preserved" },
    201
  );
  assert.equal(
    await prisma.booking.count({ where: { travelerMembershipId: traveler.session.user.membershipId } }),
    preserved
  );
  checks++;
  const racing = await loginCreated();
  const [refreshRace] = await Promise.all([
    fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-client": "mobile" },
      body: JSON.stringify({ refreshToken: racing.refreshToken })
    }),
    call(`/platform/users/${created.id}/revoke-sessions`, "POST", admin.session, undefined, 201)
  ]);
  assert.ok([200, 401].includes(refreshRace.status));
  checks++;
  if (refreshRace.status === 200) {
    const pair = (await refreshRace.json()) as Session;
    await call("/auth/me", "GET", pair, undefined, 401);
    await call("/auth/refresh", "POST", undefined, { refreshToken: pair.refreshToken }, 401);
  }
  const idle = await account("idle", "traveler");
  const logoutAccount = await account("logout", "traveler");
  await call("/auth/logout", "POST", logoutAccount.session, { refreshToken: logoutAccount.session.refreshToken }, 204);
  await call("/auth/me", "GET", logoutAccount.session, undefined, 401);
  await call("/auth/refresh", "POST", undefined, { refreshToken: logoutAccount.session.refreshToken }, 401);
  const accessSessionId = (token: string): string =>
    (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { sid: string }).sid;
  const firstSessionId = accessSessionId(idle.session.accessToken);
  await call("/auth/activity", "POST", idle.session, undefined, 204);
  const activeSession = await prisma.refreshSession.findUniqueOrThrow({ where: { id: firstSessionId } });
  assert.ok(activeSession.lastUsedAt);
  checks++;
  const idleMs = Number(process.env.SESSION_IDLE_TIMEOUT_MINUTES ?? 15) * 60_000;
  const priorActivity = new Date(Date.now() - Math.min(30_000, idleMs / 2));
  await prisma.refreshSession.update({ where: { id: firstSessionId }, data: { lastUsedAt: priorActivity } });
  const rotated = await call("/auth/refresh", "POST", undefined,
    { refreshToken: idle.session.refreshToken }) as Session;
  const rotatedSessionId = accessSessionId(rotated.accessToken);
  assert.notEqual(rotatedSessionId, firstSessionId);
  const rotatedSession = await prisma.refreshSession.findUniqueOrThrow({ where: { id: rotatedSessionId } });
  assert.equal(rotatedSession.lastUsedAt?.getTime(), priorActivity.getTime());
  checks++;
  await prisma.refreshSession.update({ where: { id: rotatedSessionId },
    data: { lastUsedAt: new Date(Date.now() - idleMs - 60_000) } });
  await call("/auth/me", "GET", rotated, undefined, 401);
  await call("/auth/refresh", "POST", undefined, { refreshToken: rotated.refreshToken }, 401);
  // profile, roles & permissions, member status, tenant management and MFA.
  const member = await account("member", "traveler");
  await call("/users/me", "GET", member.session);
  await call("/users/me", "PATCH", member.session, { displayName: "Member QA", locale: "en-US" });
  await call("/roles", "GET", admin.session);
  await call("/permissions", "GET", admin.session);
  const customRole = await call("/roles", "POST", admin.session,
    { code: `qa-role-${stamp}`, name: "QA role", permissions: ["booking.read"] }, 201);
  await call(`/roles/${customRole.id}`, "PATCH", admin.session, { name: "QA role renamed" });
  const memberId = member.session.user.membershipId;
  await call(`/memberships/${memberId}/roles`, "PUT", admin.session, { roleIds: [customRole.id] });
  await call("/access/audit", "GET", admin.session);
  await call(`/roles/${customRole.id}`, "DELETE", admin.session, undefined, 409);
  await call(`/memberships/${memberId}/roles`, "PUT", admin.session, { roleIds: [roleMap["traveler"]] });
  await call(`/roles/${customRole.id}`, "DELETE", admin.session, undefined, 204);
  await call(`/tenants/members/${memberId}/status`, "PATCH", admin.session, { status: "SUSPENDED", reason: "QA check" });
  await call(`/tenants/members/${memberId}/history`, "GET", admin.session);
  await call(`/tenants/members/${memberId}/status`, "PATCH", admin.session, { status: "ACTIVE" });
  await call("/tenants/current", "PATCH", admin.session, { settings: { locale: "ar-SA" } });
  const createdTenant = await call("/platform/tenants", "POST", admin.session,
    { code: `qa-new-${stamp}`, name: "Temporary created tenant" }, 201);
  tenantIds.push(createdTenant.id as string);
  await call("/platform/tenants", "GET", admin.session);
  await call(`/platform/tenants/${createdTenant.id}/status`, "POST", admin.session,
    { status: "SUSPENDED", reason: "QA lifecycle check" }, 201);
  await call(`/platform/tenants/${createdTenant.id}/activity`, "GET", admin.session);
  const factor = await account("factor", "traveler");
  const factorEmail = `factor-${stamp}@test.safry.local`;
  await call("/auth/mfa", "GET", factor.session);
  const setup = await call("/auth/mfa/setup", "POST", factor.session, { password }, 200);
  const enabled = await call("/auth/mfa/enable", "POST", factor.session, { code: hotp(setup.secret as string, totpStep()) }, 200);
  const challenge = await call("/auth/login", "POST", undefined, { email: factorEmail, password, tenantCode: tenant.code });
  assert.equal(challenge.mfaRequired, true);
  assert.equal(challenge.accessToken, undefined);
  checks++;
  await call("/auth/mfa/verify", "POST", undefined,
    { mfaToken: challenge.mfaToken, code: hotp(setup.secret as string, totpStep() + 1) });
  await call("/auth/mfa/disable", "POST", factor.session,
    { password, code: (enabled.recoveryCodes as string[])[0] }, 204);
  // Operations whose behaviour (mail links, throttling, session management) is owned by the integration suites and
  // checked there by the route-coverage gate (pnpm test:routes); this smoke run does not drive them.
  const coveredByIntegrationSuites = new Set([
    "GET /metrics", "POST /auth/logout-all", "GET /auth/sessions", "DELETE /auth/sessions/{id}", "POST /auth/password",
    "POST /auth/password/forgot", "POST /auth/password/reset", "POST /auth/email/verify", "POST /auth/email/resend",
    "POST /auth/login-throttle/unlock", "POST /auth/mfa/recovery-codes", "GET /users/me/invitations",
    "POST /users/me/invitations/{membershipId}/accept", "POST /users/me/invitations/{membershipId}/decline"
  ]);
  const uncovered = documented.filter(route => !exercised.has(`${route.method} ${route.path}`) && !coveredByIntegrationSuites.has(`${route.method} ${route.path}`));
  console.log(`ROUTE COVERAGE: ${exercised.size}/${documented.length}; uncovered: ${JSON.stringify(uncovered)}`);
  assert.equal(uncovered.length, 0, "Some API operations have not been exercised");
  console.log(
    `PASS: ${checks} business/API checks including platform administration, access revocation, ownership, tenant isolation, pricing and concurrent capacity.`
  );
}
try {
  await main();
} catch (error) {
  console.error("Business test failed before cleanup:", error);
  throw error;
} finally {
  // Only test tenants created in this invocation are removed; never demo/user data.
  for (const tenantId of tenantIds) {
    await prisma.$transaction(async (tx) => {
      await tx.serviceComponent.deleteMany({ where: { tenantId } });
      await tx.booking.deleteMany({ where: { tenantId } });
      await tx.travelService.deleteMany({ where: { tenantId } });
      await tx.refreshSession.deleteMany({ where: { tenantId } });
      await tx.membershipRole.deleteMany({ where: { tenantId } });
      await tx.tenantMembership.deleteMany({ where: { tenantId } });
      await tx.role.deleteMany({ where: { tenantId } });
      await tx.organizationDepartment.deleteMany({ where: { tenantId } });
      await tx.providerOrganization.deleteMany({ where: { tenantId } });
      await tx.auditEvent.deleteMany({ where: { tenantId } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
  }
  await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}
