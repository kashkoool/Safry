import { ServiceUnavailableException } from "@nestjs/common";

export const SERVICE_BUSY_MESSAGE = "الخدمة مشغولة حالياً، حاول بعد لحظات";

/** Retry-After for a refused request: the base plus 0 to `spread` whole seconds, so clients that were refused together do not all return together. */
export function retryAfterWithJitter(base: number, random: () => number = Math.random, spread = 2): number {
  return base + Math.floor(random() * (spread + 1));
}

/** HTTP 503 for a temporary overload (database pool, hashing queue); the filter adds a Retry-After header. */
export class ServiceBusyException extends ServiceUnavailableException {
  constructor(readonly retryAfterSeconds = 2) {
    super(SERVICE_BUSY_MESSAGE);
  }
}
