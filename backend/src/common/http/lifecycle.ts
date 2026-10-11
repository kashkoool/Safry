import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Graceful shutdown. On SIGTERM Nest runs onModuleDestroy first: readiness flips to "draining" so the
 * load balancer stops sending traffic, we wait for it to notice, and only then Nest closes the HTTP
 * server (in-flight requests finish) and finally the database pool (PrismaService.onApplicationShutdown).
 * A hard deadline guarantees the process exits even if a connection never finishes.
 */
@Injectable()
export class ShutdownState implements OnModuleDestroy {
  private readonly logger = new Logger("shutdown");
  private draining = false;
  constructor(private readonly config: ConfigService) {}

  get isDraining(): boolean {
    return this.draining;
  }

  async onModuleDestroy(): Promise<void> {
    this.draining = true;
    const drainMs = this.config.get<number>("SHUTDOWN_DRAIN_MS", 5000);
    const deadlineMs = this.config.get<number>("SHUTDOWN_DEADLINE_MS", 25_000);
    this.logger.log(`Shutdown requested: readiness failing, draining for ${drainMs} ms, hard deadline ${deadlineMs} ms`);
    setTimeout(() => {
      this.logger.error("Shutdown deadline exceeded; exiting");
      process.exit(1);
    }, deadlineMs).unref();
    await new Promise((resolve) => setTimeout(resolve, drainMs));
  }
}
