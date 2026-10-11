import { Global, Module } from "@nestjs/common";
import { MetricsController, MetricsService } from "./metrics.js";
import { ShutdownState } from "./lifecycle.js";

/** Cross-cutting HTTP concerns: metrics, request logging support and graceful shutdown state. */
@Global()
@Module({ controllers: [MetricsController], providers: [MetricsService, ShutdownState], exports: [MetricsService, ShutdownState] })
export class HttpSupportModule {}
