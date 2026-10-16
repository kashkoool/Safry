import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { rateLimitState } from "../../common/http/rate-limit.js";
import { ShutdownState } from "../../common/http/lifecycle.js";
import { MetricsService } from "../../common/http/metrics.js";
import { Public } from "../../common/security/public.decorator.js";
import { PrismaService } from "../../database/prisma.service.js";

const READY_DB_TIMEOUT_MS = 2000;

/** Probes never touch the rate limiter and never need a database for liveness. */
@ApiTags("health")
@Public()
@SkipThrottle({ default: true, account: true })
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shutdown: ShutdownState,
    private readonly metrics: MetricsService
  ) {}

  /** Liveness: the process answers. Must not depend on the database (a DB outage must not restart every pod). */
  @Get("live")
  live(): { status: string; timestamp: string } {
    return { status: "ok", timestamp: new Date().toISOString() };
  }

  /** Readiness: able to serve traffic (database reachable, not draining for shutdown). */
  @Get("ready")
  async ready(): Promise<{ status: string; database: string; rateLimit: string }> {
    if (this.shutdown.isDraining) {
      this.metrics.readinessFailure("draining");
      throw new ServiceUnavailableException("Shutting down");
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), READY_DB_TIMEOUT_MS);
        })
      ]);
      return { status: rateLimitState.degraded ? "degraded" : "ok", database: "reachable", rateLimit: rateLimitState.degraded ? "degraded-in-process" : "ok" };
    } catch {
      this.metrics.readinessFailure("database");
      throw new ServiceUnavailableException("Database is not reachable");
    } finally {
      clearTimeout(timer);
    }
  }
}
