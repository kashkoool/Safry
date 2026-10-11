import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { AuthPrincipalCache, type InvalidationTarget } from "../common/cache/auth-principal-cache.js";
import { invalidationFor } from "../common/cache/auth-principal-invalidation.js";
import { currentScope, type DbScope } from "../common/context/request-context.js";
import type * as runtime from "@prisma/client/runtime/client";
import { PrismaClient, type Prisma } from "../generated/prisma/client.js";
import { TENANT_KEY, confineToTenant } from "./tenant-scope.js";

/** True while the current async chain runs inside a transaction whose RLS context is already set. */
const insideScopedTransaction = new AsyncLocalStorage<{ dirty: InvalidationTarget[] }>();

interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]*$/;

function requireScope(): DbScope {
  const scope = currentScope();
  if (!scope)
    throw new Error("Database access without a tenant scope: authenticate the request or wrap the call in runAsSystem()");
  return scope;
}

/**
 * PrismaClient with two tenant-isolation layers:
 *  1. every top-level query on a tenant-owned model is confined to the verified tenant;
 *  2. every query runs in a transaction that drops to the restricted `safry_app` role and
 *     publishes the tenant to PostgreSQL, where row-level security policies apply.
 * The constructor returns the extended client, so injected code needs no changes.
 */
/**
 * an API login that is a superuser, BYPASSRLS, or owns/is a member of the owner of
 * public tables can `RESET ROLE` out of safry_app and bypass row-level security. Refuse in production.
 */
export function unsafeRuntimeLogin(probe: { privileged: boolean; owner: boolean }, production: boolean): string | undefined {
  if (!production || (!probe.privileged && !probe.owner)) return undefined;
  return "DATABASE_URL must be the restricted runtime login (safry_runtime), not the database owner, a member of the owner role, a superuser or BYPASSRLS; the owner login belongs in DATABASE_MIGRATE_URL only (backend/docs/database-operations.md)";
}

/** A database cloned from a local `prisma dev` server carries dev-only grants (migration 0011): never serve production from it. */
export function devWalRefusal(devSchemaPresent: boolean, production: boolean): string | undefined {
  if (!devSchemaPresent || !production) return undefined;
  return "Schema _prisma_dev_wal exists: this database comes from a local prisma dev server and must not run in production";
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);
  /** Shared by the original and the extended client (the extended one only inherits from it). */
  private readonly state: { rls: boolean };
  private readonly detectEmbeddedEngine: boolean;
  private readonly appRole: string;
  private readonly principalCache: AuthPrincipalCache;
  private readonly production: boolean;

  constructor(config: ConfigService, principalCache: AuthPrincipalCache) {
    super({
      adapter: new PrismaPg({
        connectionString: config.getOrThrow<string>("DATABASE_URL"),
        // Prisma's local development server supports a small connection budget.
        // Budget: DATABASE_POOL_MAX x replicas + migration/admin reserve must stay below max_connections.
        max: config.get<number>("DATABASE_POOL_MAX") ?? (config.get<string>("NODE_ENV") === "development" ? 1 : 10),
        // pg waits forever by default (Prisma 6 used 5 s): fail fast instead of queueing behind an exhausted pool.
        connectionTimeoutMillis: config.get<number>("DATABASE_CONNECT_TIMEOUT_MS", 5000),
        idleTimeoutMillis: config.get<number>("DATABASE_IDLE_TIMEOUT_MS", 30_000),
        // Server-side caps so a runaway query or a client that vanished mid-transaction can not hold a connection or locks.
        statement_timeout: config.get<number>("DATABASE_STATEMENT_TIMEOUT_MS", 15_000),
        idle_in_transaction_session_timeout: config.get<number>("DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS", 15_000),
        application_name: "safry-api"
      }),
      transactionOptions: {
        maxWait: config.get<number>("DATABASE_TX_MAX_WAIT_MS", 3000),
        timeout: config.get<number>("DATABASE_TX_TIMEOUT_MS", 10_000)
      }
    });
    this.principalCache = principalCache;
    const mode = config.get<string>("DATABASE_RLS", "auto");
    this.state = { rls: mode !== "off" };
    // "auto" is on everywhere except the embedded Prisma dev engine, which crashes on writes made under a restricted role.
    this.detectEmbeddedEngine = mode === "auto" && config.get<string>("NODE_ENV") === "development";
    this.appRole = config.get<string>("DATABASE_APP_ROLE", "safry_app");
    this.production = config.get<string>("NODE_ENV") === "production";
    if (!ROLE_NAME.test(this.appRole)) throw new Error("DATABASE_APP_ROLE is invalid");
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const base = this;
    // The extended client inherits from this instance, so lifecycle hooks and $transaction stay available.
    return this.$extends({
      name: "tenant-isolation",
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const scope = requireScope();
            const confined = scope.kind === "tenant" && model in TENANT_KEY
              ? (confineToTenant(model, operation, args, scope.tenantId) as typeof args)
              : args;
            const stale = invalidationFor(model, operation, confined);
            const transaction = insideScopedTransaction.getStore();
            try {
              if (!base.state.rls || transaction) return await query(confined);
              const [, result] = await base.$transaction([base.contextStatement(scope), query(confined)]);
              return result;
            } finally {
              // Drop cached principals the write may have changed. Inside an interactive transaction the
              // commit happens later, so the target is replayed after it (see $transaction below).
              if (stale) {
                principalCache.invalidate(stale);
                transaction?.dirty.push(stale);
              }
            }
          }
        }
      }
    }) as unknown as this;
  }

  private contextStatement(scope: DbScope): ReturnType<PrismaClient["$queryRaw"]> {
    const tenantId = scope.kind === "tenant" ? scope.tenantId : "";
    const bypass = scope.kind === "system" ? "on" : "off";
    return this.$queryRaw`SELECT set_config('role', ${this.appRole}, true), set_config('app.tenant_id', ${tenantId}, true), set_config('app.bypass_rls', ${bypass}, true)`;
  }

  /** Interactive transactions publish the request scope to PostgreSQL before running the callback. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the PrismaClient overload signature
  override $transaction<P extends Prisma.PrismaPromise<any>[]>(
    arg: [...P],
    options?: TransactionOptions
  ): runtime.Types.Utils.JsPromise<runtime.Types.Utils.UnwrapTuple<P>>;
  override $transaction<R>(
    fn: (prisma: Omit<PrismaClient, runtime.ITXClientDenyList>) => runtime.Types.Utils.JsPromise<R>,
    options?: TransactionOptions
  ): runtime.Types.Utils.JsPromise<R>;
  override $transaction(input: unknown, options?: TransactionOptions): Promise<unknown> {
    const run = super.$transaction.bind(this) as (input: unknown, options?: TransactionOptions) => Promise<unknown>;
    if (typeof input !== "function" || !this.state.rls || insideScopedTransaction.getStore()) return run(input, options);
    const scope = requireScope();
    const dirty: InvalidationTarget[] = [];
    return run(async (tx: PrismaClient) => {
      await tx.$queryRaw`SELECT set_config('role', ${this.appRole}, true), set_config('app.tenant_id', ${scope.kind === "tenant" ? scope.tenantId : ""}, true), set_config('app.bypass_rls', ${scope.kind === "system" ? "on" : "off"}, true)`;
      return insideScopedTransaction.run({ dirty }, () => (input as (client: PrismaClient) => Promise<unknown>)(tx));
    }, options).finally(() => {
      for (const target of dirty) this.principalCache.invalidate(target);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    if (this.detectEmbeddedEngine) {
      const rows = await this.$queryRaw<Array<{ version: string }>>`SELECT version() AS version`;
      if (rows[0]?.version.includes("wasm32")) {
        this.state.rls = false;
        this.logger.warn("Embedded Prisma dev database detected: the row-level-security role context is disabled (application-level tenant scoping stays active)");
      }
    }
    if (!this.state.rls) {
      this.logger.warn("Row-level-security context is disabled (DATABASE_RLS=off or embedded dev database)");
      return;
    }
    const rows = await this.$queryRaw<Array<{ rolname: string }>>`SELECT rolname FROM pg_roles WHERE rolname = ${this.appRole}`;
    if (rows.length !== 1)
      throw new Error(`Database role "${this.appRole}" is missing; run "pnpm db:deploy" to apply migration 0010`);
    // Prove the role switch works for this login (the migration that grants membership swallows errors).
    const [, probe] = await this.$transaction([
      this.$queryRaw`SELECT set_config('role', ${this.appRole}, true)`,
      this.$queryRaw<Array<{ active: string; privileged: boolean; owner: boolean; appPrivileged: boolean }>>`SELECT current_user::text AS active, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) OR EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND pg_has_role(current_user, tableowner, 'MEMBER')) AS "appPrivileged", (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = session_user) AS privileged, EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND pg_has_role(session_user, tableowner, 'MEMBER')) AS owner`
    ]);
    // Migration 0011 grants dev-only access when this schema exists: a database cloned from a
    // `prisma dev` instance must never serve production traffic ().
    const [dev] = await this.$queryRaw<Array<{ present: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '_prisma_dev_wal') AS present`;
    const devRefusal = devWalRefusal(Boolean(dev?.present), this.production);
    if (devRefusal) throw new Error(devRefusal);
    if (probe[0]?.active !== this.appRole)
      throw new Error(`Cannot switch to database role "${this.appRole}"; grant it to the connecting login ("GRANT ${this.appRole} TO <login>")`);
    // The role every request runs as must itself enforce RLS: a superuser, BYPASSRLS or table-owner role here
    // would make every policy a no-op without any other sign.
    if (probe[0].appPrivileged)
      throw new Error(`Database role "${this.appRole}" is a superuser, has BYPASSRLS or is a member of the table owner role: row-level security would not apply. Use a plain NOLOGIN role.`);
    const unsafe = unsafeRuntimeLogin(probe[0], this.production);
    if (unsafe) throw new Error(unsafe);
    if (probe[0].privileged)
      this.logger.warn("The application connects as a superuser or BYPASSRLS role: use a restricted login in DATABASE_URL and an owner login in DATABASE_MIGRATE_URL (backend/docs/database-operations.md)");
  }

  /** After the HTTP server has drained: closing the pool earlier would fail the requests still in flight. */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
