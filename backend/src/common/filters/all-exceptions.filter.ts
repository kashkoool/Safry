import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import { requestContext } from "../context/request-context.js";
import { mapDatabaseError } from "./database-errors.js";
import { ServiceBusyException, retryAfterWithJitter } from "./service-busy.exception.js";

/** body-parser (Express) reports oversized or malformed bodies as plain errors with a 4xx status and `expose: true`; keep them 4xx. */
function mapParserError(raised: unknown): HttpException | undefined {
  if (typeof raised !== "object" || raised === null) return undefined;
  const { status, type } = raised as { status?: unknown; type?: unknown };
  if (typeof type !== "string" || !type.startsWith("entity.") || typeof status !== "number") return undefined;
  if (status === 413) return new HttpException("Payload too large", HttpStatus.PAYLOAD_TOO_LARGE);
  if (status >= 400 && status < 500) return new HttpException("Request body is invalid", status);
  return undefined;
}

/**
 * Database drivers put table, column and sometimes row values into their message text. Log only the error
 * class and code; returns undefined when the error is not a Prisma or PostgreSQL error.
 */
export function describeDatabaseError(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { name, code } = error as { name?: unknown; code?: unknown };
  const isPrisma = typeof name === "string" && name.startsWith("PrismaClient");
  const isPg = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && (error as { severity?: unknown }).severity !== undefined;
  if (!isPrisma && !isPg) return undefined;
  return `${typeof name === "string" ? name : "DatabaseError"}${typeof code === "string" ? ` code=${code}` : ""} (message withheld)`;
}

/** Class name only, for errors that are mapped to a status without being recognisable Prisma or PostgreSQL errors (e.g. a pool timeout). */
function errorClassName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(raised: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request & { user?: { userId?: string; tenantId?: string } }>();
    let exception: unknown = raised;
    if (!(raised instanceof HttpException)) {
      const parser = mapParserError(raised);
      const database = parser ? undefined : mapDatabaseError(raised);
      exception = parser ?? database ?? raised;
      if (database) {
        // Log the class and code only; driver messages carry table, column and row values.
        this.logger.warn(`Database error mapped to HTTP ${database.getStatus()}: ${describeDatabaseError(raised) ?? `${errorClassName(raised)} (message withheld)`}`);
      }
    }
    const clientStatus = exception instanceof HttpException ? undefined : httpClientStatus(exception);
    const status =
      exception instanceof HttpException ? exception.getStatus() : (clientStatus ?? HttpStatus.INTERNAL_SERVER_ERROR);
    if (status === 401 || status === 403) {
      // Denied access is a security event (OWASP A09): log who and where, never the query string or body.
      const path = String(request?.originalUrl ?? request?.url ?? "").split("?")[0];
      this.logger.warn(
        `Access denied ${status} ${request?.method ?? "?"} ${path} user=${request?.user?.userId ?? "anonymous"} tenant=${request?.user?.tenantId ?? "-"} request=${requestContext.getStore()?.requestId ?? "-"}`
      );
    }
    if (status === 500) {
      const safe = describeDatabaseError(exception);
      if (safe) this.logger.error(safe);
      else this.logger.error(exception instanceof Error ? exception.message : String(exception), exception instanceof Error ? exception.stack : undefined);
    }
    const exceptionBody = exception instanceof HttpException ? exception.getResponse() : undefined;
    const message =
      clientStatus !== undefined
        ? (CLIENT_ERROR_MESSAGES[clientStatus] ?? "Request failed")
        : typeof exceptionBody === "string"
        ? exceptionBody
        : typeof exceptionBody === "object" && exceptionBody && "message" in exceptionBody
          ? exceptionBody.message
          : status === 500
            ? "Internal server error"
            : "Request failed";

    // Stable machine code (letters, digits, underscore) when the exception carries one, e.g. mfa_enrollment_required or BOOKING_EXPIRED.
    const rawCode = typeof exceptionBody === "object" && exceptionBody && "code" in exceptionBody ? exceptionBody.code : undefined;
    const code = typeof rawCode === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rawCode) ? rawCode : undefined;
    if (exception instanceof ServiceBusyException) response.setHeader("Retry-After", String(retryAfterWithJitter(exception.retryAfterSeconds)));
    response.status(status).json({
      statusCode: status,
      message,
      ...(code ? { code } : {}),
      requestId: requestContext.getStore()?.requestId,
      timestamp: new Date().toISOString()
    });
  }
}

const CLIENT_ERROR_MESSAGES: Record<number, string> = { 413: "Payload too large", 415: "Unsupported media type" };

/** Client errors raised by the HTTP layer (body-parser/http-errors) carry a numeric 4xx status but are not HttpExceptions. */
function httpClientStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const carrier = error as { status?: unknown; statusCode?: unknown };
  const code = typeof carrier.status === "number" ? carrier.status : carrier.statusCode;
  return typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 499 ? code : undefined;
}
