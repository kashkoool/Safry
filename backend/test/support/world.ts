import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { COVERAGE_DIR } from "./coverage-dir.js";
import type { INestApplication } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { hash } from "argon2";
import pg from "pg";
import { inject } from "vitest";
import { hotp, totpStep } from "../../dist/common/security/totp.js";
import { PrismaClient } from "../../dist/generated/prisma/client.js";
import { PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES, type SystemRoleCode } from "../../dist/modules/identity/access/system-roles.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- HTTP bodies are asserted field by field in the specs
export type Json = any;

export interface TestTenant {
  id: string;
  code: string;
  roleIds: Record<string, string>;
}

export interface TestUser {
  userId: string;
  membershipId: string;
  email: string;
  password: string;
  tenant: TestTenant;
  organizationId?: string;
  /** TOTP secret once the fixture has enrolled MFA (platform administrators are enrolled by createUser). */
  mfaSecret?: string;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { tenantId: string; userId: string; membershipId: string; permissions: string[]; roles: string[] };
}

export interface RouteInfo {
  method: string;
  /** Express pattern including the global prefix, e.g. /api/v1/bookings/:id/status */
  path: string;
  params: string[];
  public: boolean;
  permissions: string[];
  platformGuard: boolean;
  hasBody: boolean;
}

export interface Reply {
  status: number;
  body: Json;
  /** Raw Set-Cookie header values. */
  cookies: string[];
}

export interface RequestOptions {
  session?: Pick<Session, "accessToken"> & { tenantId?: string };
  body?: unknown;
  headers?: Record<string, string>;
}

const PASSWORD = "Correct-Horse-Battery-9";

function recordHit(method: string, path: string, status: number, authenticated: boolean): void {
  try {
    mkdirSync(COVERAGE_DIR, { recursive: true });
    appendFileSync(join(COVERAGE_DIR, `hits-${process.pid}.jsonl`), `${JSON.stringify({ method, path: path.split("?")[0], status, authenticated })}
`);
  } catch {
    // coverage recording is best effort and must never fail a test
  }
}

/** A booted copy of the API (compiled dist/) on a real PostgreSQL with RLS forced on, plus fixtures. */
export class World {
  readonly stamp = randomUUID().slice(0, 8);
  private counter = 0;

  private constructor(
    readonly app: INestApplication,
    readonly baseUrl: string,
    readonly prisma: PrismaClient,
    readonly sql: pg.Client,
    readonly databaseUrl: string
  ) {}

  static async start(overrides: Record<string, string> = {}): Promise<World> {
    const databaseUrl = inject("databaseUrl");
    Object.assign(process.env, {
      NODE_ENV: "test",
      // TEST_APP_AS_RUNTIME=1: the application connects as the restricted runtime login; fixtures below keep the superuser.
      DATABASE_URL: inject("runtimeDatabaseUrl") || databaseUrl,
      DATABASE_POOL_MAX: "5",
      DATABASE_RLS: "on",
      // Fixtures change rows behind the API (no invalidation), so the shared suite runs uncached; perf.int.spec.ts turns the cache on.
      AUTH_CACHE_TTL_MS: "0",
      JWT_ACCESS_SECRET: "integration-test-secret-with-more-than-32-chars",
      LOGIN_MAX_ATTEMPTS: "5",
      LOGIN_LOCKOUT_MINUTES: "15",
      // World.stop() closes the app: no 5 s load-balancer drain, and the forced-exit deadline must outlive a whole test file.
      SHUTDOWN_DRAIN_MS: "0",
      SHUTDOWN_DEADLINE_MS: "3600000",
      ...overrides
    });
    const [{ NestFactory }, { AppModule }, { configureApp }] = await Promise.all([
      import("@nestjs/core"),
      import("../../dist/app.module.js"),
      import("../../dist/app.setup.js")
    ]);
    const app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number };
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    const sql = new pg.Client({ connectionString: databaseUrl });
    await sql.connect();
    const world = new World(app, `http://127.0.0.1:${address.port}/api/v1`, prisma, sql, databaseUrl);
    await prisma.permission.createMany({
      data: PERMISSIONS.map(([code, description]) => ({ code, description })),
      skipDuplicates: true
    });
    return world;
  }

  async stop(): Promise<void> {
    await this.app.close();
    await this.prisma.$disconnect();
    await this.sql.end();
  }

  /**
   * The routes the running application really serves, read from the Express router (the authority), enriched with the
   * Nest metadata (public flag, permissions, guards, body) of the controller method that handles each of them.
   */
  async routes(): Promise<RouteInfo[]> {
    const { ModulesContainer } = await import("@nestjs/core");
    const reflect = Reflect as unknown as { getMetadata(key: string, target: object, property?: string | symbol): unknown };
    const meta = new Map<string, Omit<RouteInfo, "method" | "path" | "params">>();
    const prefix = `/${process.env.API_PREFIX ?? "api/v1"}`;
    for (const module of this.app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
        if (!controller) continue;
        const base = String(reflect.getMetadata("path", controller) ?? "/");
        const classPublic = Boolean(reflect.getMetadata("isPublic", controller));
        const classPermissions = (reflect.getMetadata("requiredPermissions", controller) as string[] | undefined) ?? [];
        const classGuards = (reflect.getMetadata("__guards__", controller) as { name: string }[] | undefined) ?? [];
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          const handler = (controller.prototype as Record<string, unknown>)[name];
          if (typeof handler !== "function") continue;
          const verb = reflect.getMetadata("method", handler);
          if (verb === undefined) continue;
          const method = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD"][verb as number]!;
          const sub = String(reflect.getMetadata("path", handler) ?? "/");
          const path = `${prefix}/${[base, sub].join("/")}`.replace(/\/+/g, "/").replace(/\/$/, "");
          const args = (reflect.getMetadata("__routeArguments__", controller, name) as Record<string, unknown> | undefined) ?? {};
          const permissions = (reflect.getMetadata("requiredPermissions", handler) as string[] | undefined) ?? classPermissions;
          meta.set(`${method} ${path}`, {
            public: Boolean(reflect.getMetadata("isPublic", handler)) || classPublic,
            permissions,
            platformGuard: classGuards.some((guard) => guard.name === "PlatformAdminGuard"),
            hasBody: Object.keys(args).some((key) => key.startsWith("3:"))
          });
        }
      }
    }
    const router = (this.app.getHttpAdapter().getInstance() as { router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } }).router;
    const found: RouteInfo[] = [];
    for (const layer of router.stack) {
      if (!layer.route || !layer.route.path.startsWith(`${prefix}/`) || layer.route.path.startsWith(`${prefix}/docs`) || layer.route.path.includes("*")) continue; // middleware catch-all (forRoutes)
      for (const method of Object.keys(layer.route.methods).map((m) => m.toUpperCase())) {
        const extra = meta.get(`${method} ${layer.route.path}`);
        if (!extra) throw new Error(`router serves ${method} ${layer.route.path} but no controller metadata matches it`);
        found.push({
          method,
          path: layer.route.path,
          params: [...layer.route.path.matchAll(/:(\w+)/g)].map((match) => match[1]!),
          ...extra
        });
      }
    }
    if (found.length !== meta.size) throw new Error(`router has ${found.length} routes but controllers declare ${meta.size}`);
    return found.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
  }

  unique(prefix: string): string {
    return `${prefix}-${this.stamp}-${++this.counter}`;
  }

  async api(method: string, path: string, options: RequestOptions = {}): Promise<Reply> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        // Existing suites drive the API like a native client (refresh token in the body); the cookie suite sends x-client: web.
        "x-client": "mobile",
        ...(options.session ? { authorization: `Bearer ${options.session.accessToken}` } : {}),
        ...(options.session?.tenantId ? { "x-tenant-id": options.session.tenantId } : {}),
        ...options.headers
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    const text = await response.text();
    recordHit(method.toUpperCase(), path, response.status, Boolean(options.session) || Boolean(options.headers?.authorization));
    let body: Json | undefined;
    try {
      body = text ? (JSON.parse(text) as Json) : undefined;
    } catch {
      body = { text } as Json; // non-JSON answers (Prometheus text)
    }
    return { status: response.status, body, cookies: response.headers.getSetCookie() };
  }

  login(user: TestUser, extra: Record<string, unknown> = {}, password = user.password): Promise<Reply> {
    return this.api("POST", "/auth/login", {
      body: { email: user.email, password, tenantCode: user.tenant.code, ...extra }
    });
  }

  /** A currently valid TOTP code for an enrolled fixture user; clears the replay guard so tests can ask for as many as they need. */
  async mfaCode(user: TestUser): Promise<string> {
    if (!user.mfaSecret) throw new Error("fixture user has no MFA secret");
    await this.prisma.user.update({ where: { id: user.userId }, data: { mfaLastStep: null } });
    return hotp(user.mfaSecret, totpStep());
  }

  /** Enrols MFA through the public endpoints (password-only session) and stores the secret on the fixture. */
  async enrollMfa(user: TestUser): Promise<TestUser> {
    const login = await this.login(user);
    if (login.status !== 200 || !login.body.accessToken) throw new Error(`login failed: ${login.status}`);
    const session = { accessToken: login.body.accessToken as string, tenantId: user.tenant.id };
    const setup = await this.api("POST", "/auth/mfa/setup", { session, body: { password: user.password } });
    const secret = setup.body.secret as string;
    const enabled = await this.api("POST", "/auth/mfa/enable", { session, body: { code: hotp(secret, totpStep()) } });
    if (enabled.status !== 200) throw new Error(`mfa enable failed: ${enabled.status}`);
    user.mfaSecret = secret;
    return user;
  }

  async session(user: TestUser, extra: Record<string, unknown> = {}): Promise<Session> {
    const reply = await this.login(user, extra);
    if (reply.status === 200 && reply.body.mfaRequired && user.mfaSecret) {
      const verified = await this.api("POST", "/auth/mfa/verify", { body: { mfaToken: reply.body.mfaToken, code: await this.mfaCode(user) } });
      if (verified.status !== 200 || !verified.body.accessToken) throw new Error(`mfa verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
      return verified.body as Session;
    }
    if (reply.status !== 200 || !reply.body.accessToken) throw new Error(`login failed: ${reply.status} ${JSON.stringify(reply.body)}`);
    return reply.body as Session;
  }

  /** Creates a tenant with the standard system roles, exactly like the seed and platform tenant creation. */
  async createTenant(label = "tenant"): Promise<TestTenant> {
    const code = this.unique(label).toLowerCase();
    const tenant = await this.prisma.tenant.create({ data: { code, name: `Test ${code}` } });
    const permissions = await this.prisma.permission.findMany();
    const roleIds: Record<string, string> = {};
    for (const [roleCode, name] of SYSTEM_ROLES) {
      const role = await this.prisma.role.create({ data: { tenantId: tenant.id, code: roleCode, name, isSystem: true } });
      roleIds[roleCode] = role.id;
      const allowed = new Set<string>(ROLE_PERMISSIONS[roleCode]);
      await this.prisma.rolePermission.createMany({
        data: permissions.filter((permission) => allowed.has(permission.code)).map((permission) => ({
          roleId: role.id,
          permissionId: permission.id
        }))
      });
    }
    return { id: tenant.id, code, roleIds };
  }

  async createOrganization(tenant: TestTenant, type: "TRAVEL_COMPANY" | "HOTEL" = "TRAVEL_COMPANY"): Promise<string> {
    const name = this.unique("org");
    const organization = await this.prisma.providerOrganization.create({
      data: { tenantId: tenant.id, name, nameAr: name, nameEn: name, type, city: "Riyadh", contactEmail: `${name}@example.test` }
    });
    return organization.id;
  }

  async createUser(
    tenant: TestTenant,
    options: { roles: SystemRoleCode[]; organizationId?: string; isPlatformAdmin?: boolean; mfa?: boolean; email?: string; password?: string }
  ): Promise<TestUser> {
    const email = options.email ?? `${this.unique("user")}@example.test`;
    const password = options.password ?? PASSWORD;
    const user = await this.prisma.user.create({
      data: {
        email,
        emailNormalized: email,
        displayName: email,
        passwordHash: await hash(password),
        isPlatformAdmin: options.isPlatformAdmin ?? false,
        // Fixture accounts are already verified; self-registered ones are not (see test/credentials.int.spec.ts).
        emailVerifiedAt: new Date()
      }
    });
    const fixture = await this.link(tenant, user.id, email, password, options);
    // Platform authority needs a second factor; enrol it unless the test is about the un-enrolled case.
    if (options.isPlatformAdmin && options.mfa !== false) await this.enrollMfa(fixture);
    return fixture;
  }

  /** Stands in for the e-mailed confirmation link for an account that registered through the API. */
  async markEmailVerified(email: string): Promise<void> {
    await this.prisma.user.update({ where: { emailNormalized: email.toLowerCase() }, data: { emailVerifiedAt: new Date() } });
  }

  /** Adds an existing identity to one more tenant. */
  async link(
    tenant: TestTenant,
    userId: string,
    email: string,
    password: string,
    options: { roles: SystemRoleCode[]; organizationId?: string }
  ): Promise<TestUser> {
    const membership = await this.prisma.tenantMembership.create({
      data: { tenantId: tenant.id, userId, status: "ACTIVE", providerOrganizationId: options.organizationId }
    });
    await this.prisma.membershipRole.createMany({
      data: options.roles.map((role) => ({ tenantId: tenant.id, membershipId: membership.id, roleId: tenant.roleIds[role]! }))
    });
    return { userId, membershipId: membership.id, email, password, tenant, organizationId: options.organizationId };
  }

  /** Creates a tenant-level custom role holding exactly the given permission codes and gives it to a membership. */
  async grantCustomRole(tenant: TestTenant, membershipId: string, permissionCodes: string[], organizationId?: string): Promise<string> {
    const role = await this.prisma.role.create({
      data: { tenantId: tenant.id, code: this.unique("custom"), name: "Custom", isSystem: false, ...(organizationId ? { organizationId } : {}) }
    });
    const permissions = await this.prisma.permission.findMany({ where: { code: { in: permissionCodes } } });
    await this.prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })) });
    await this.prisma.membershipRole.create({ data: { tenantId: tenant.id, membershipId, roleId: role.id } });
    return role.id;
  }

  async createService(
    tenant: TestTenant,
    owner: TestUser,
    options: { capacity?: number; priceCents?: number; status?: "ACTIVE" | "DRAFT" } = {}
  ): Promise<string> {
    const service = await this.prisma.travelService.create({
      data: {
        tenantId: tenant.id,
        providerMembershipId: owner.membershipId,
        providerOrganizationId: owner.organizationId!,
        title: this.unique("service"),
        description: "Integration test package",
        category: "PACKAGE",
        city: "Makkah",
        priceCents: options.priceCents ?? 100_000,
        capacity: options.capacity ?? 10,
        status: options.status ?? "ACTIVE",
        details: { durationDays: "5", departureCity: "Riyadh", itinerary: "Test itinerary" }
      }
    });
    return service.id;
  }

  /** Runs raw SQL the way the application does: as the restricted role, with an explicit tenant scope. */
  async asRole<T extends pg.QueryResultRow = pg.QueryResultRow>(
    scope: { tenantId?: string; bypass?: boolean },
    statement: string,
    values: unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    const client = new pg.Client({ connectionString: this.databaseUrl });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('role', 'safry_app', true), set_config('app.tenant_id', $1, true), set_config('app.bypass_rls', $2, true)", [
        scope.tenantId ?? "",
        scope.bypass ? "on" : "off"
      ]);
      const result = await client.query<T>(statement, values);
      await client.query("ROLLBACK");
      return result;
    } finally {
      await client.end();
    }
  }

  futureDate(daysAhead = 30): string {
    return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
  }
}
