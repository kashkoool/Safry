import { Injectable, Logger, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { MetricsService } from "./metrics.js";

/**
 * One structured JSON access-log line per request, plus the metrics sample. Deliberately logs only
 * method, route template, status, duration, request id and (when known) the tenant: never the URL
 * query, headers, cookies, bodies, tokens or e-mail addresses.
 */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger("http");
  constructor(private readonly metrics: MetricsService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();
    response.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const route = (request.route as { path?: string } | undefined)?.path;
      const template = route ? `${request.baseUrl}${route}` : "unmatched";
      this.metrics.observe(request.method, template, response.statusCode, durationMs);
      if (template.endsWith("/health/live") || template.endsWith("/health/ready") || template.endsWith("/metrics")) return;
      const user = (request as Request & { user?: { tenantId: string } }).user;
      this.logger.log({
        event: "http_request",
        requestId: response.getHeader("x-request-id"),
        method: request.method,
        route: template,
        status: response.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        tenantId: user?.tenantId,
        bytes: Number(response.getHeader("content-length") ?? 0) || undefined
      });
    });
    next();
  }
}
