import { ServiceUnavailableException } from "@nestjs/common";

export const SERVICE_BUSY_MESSAGE = "الخدمة مشغولة حالياً، حاول بعد لحظات";

/** HTTP 503 for a temporary overload (database pool, hashing queue); the filter adds a Retry-After header. */
export class ServiceBusyException extends ServiceUnavailableException {
  constructor(readonly retryAfterSeconds = 2) {
    super(SERVICE_BUSY_MESSAGE);
  }
}
