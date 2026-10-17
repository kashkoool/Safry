import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DEFAULT_MAIL_RETRY, MAIL_RETRY, MAIL_TRANSPORT, MailDeliveryError, type MailRetryPolicy, type MailTransport } from "./mail.types.js";
import { MailBudget, type AddressScope, type MailSource } from "./mail-budget.js";
import { MetricsService } from "../../common/http/metrics.js";
import { mailLocale, renderMail, type MailTemplate } from "./templates.js";

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(MAIL_TRANSPORT) readonly transport: MailTransport,
    @Optional() @Inject(MAIL_RETRY) private readonly retry: MailRetryPolicy = DEFAULT_MAIL_RETRY,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly budget?: MailBudget
  ) {}

  /** Renders the template for the user's locale and hands it to the transport; the caller decides whether to await. */
  async send(to: string, locale: string | null | undefined, template: MailTemplate, idempotencyKey: string = randomUUID()): Promise<void> {
    if (this.budget && !(await this.budget.allow(template.kind))) throw new MailDeliveryError("mail budget spent");
    return this.transport.send(renderMail(mailLocale(locale), template, to), idempotencyKey);
  }

  /**
   * Delivery after the HTTP answer has been decided: a slow or failing provider must neither change the response time (an account
   * enumeration signal) nor turn into an error for the caller. Transient failures are retried in this process with backoff and the
   * SAME idempotency key (the provider cannot send twice); permanent ones are not. Logs carry kind and counts only, never the
   * recipient, body or link. A restart during a backoff wait loses the pending retry (nothing secret is persisted); the user can
   * request a new link.
   */
  sendDetached(to: string, locale: string | null | undefined, template: MailTemplate, idempotencyKey: string = randomUUID(), source: MailSource = "existing"): void {
    this.deliverWithRetry(to, locale, template, idempotencyKey, source).catch(() => undefined);
  }

  /** Counts one mail-causing request against the client address daily cap; false means "send no mail" (the caller still answers as usual). */
  allowAddress(scope: AddressScope, ip: string | undefined): Promise<boolean> {
    return this.budget ? this.budget.allowAddress(scope, ip) : Promise.resolve(true);
  }

  /** Counts one reset or resend mail for this recipient against its daily cap; false means "send no mail" (the caller still answers as usual). */
  allowRecipient(emailNormalized: string): Promise<boolean> {
    return this.budget ? this.budget.allowRecipient(emailNormalized) : Promise.resolve(true);
  }

  private async deliverWithRetry(to: string, locale: string | null | undefined, template: MailTemplate, idempotencyKey: string, source: MailSource): Promise<void> {
    const { attempts, baseDelayMs } = this.retry;
    // Asked once per mail, not per attempt: the retries share one idempotency key, so the provider sends at most one mail.
    if (this.budget && !(await this.budget.allow(template.kind, source))) return; // dropped and counted by the budget; the caller answer is unchanged
    let message;
    try {
      message = renderMail(mailLocale(locale), template, to);
    } catch (error) {
      this.logger.error(`mail "${template.kind}" not delivered: could not be rendered (${errorClass(error)})`);
      this.metrics?.mailOutcome("failed");
      return;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await this.transport.send(message, idempotencyKey);
        this.metrics?.mailOutcome("sent");
        if (attempt > 1) this.logger.log(`mail "${template.kind}" delivered on attempt ${attempt}`);
        return;
      } catch (error) {
        const detail = error instanceof MailDeliveryError ? error.message : errorClass(error);
        if (!isTransient(error)) {
          this.logger.error(`mail "${template.kind}" not delivered, permanent failure (no retry) on attempt ${attempt}: ${detail}`);
          this.metrics?.mailOutcome("failed");
          return;
        }
        if (attempt >= attempts) {
          this.logger.error(`mail "${template.kind}" not delivered after ${attempt} attempts, giving up: ${detail}`);
          this.metrics?.mailOutcome("failed");
          return;
        }
        const delay = backoffMs(baseDelayMs, attempt);
        this.logger.warn(`mail "${template.kind}" attempt ${attempt} failed transiently (${detail}); retrying in ${delay} ms`);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delay).unref(); // never keeps a shutting-down process alive
        });
      }
    }
  }
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

/**
 * Retry only what is known to be transient: a network failure or timeout (no HTTP status), 429, or 5xx. Every other
 * failure (other 4xx such as an invalid recipient, or an unexpected error type) is permanent.
 */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof MailDeliveryError)) return false;
  if (error.status === undefined) return true;
  return error.status === 429 || (error.status >= 500 && error.status <= 599);
}

/** Wait after failed attempt n: base x 5^(n-1) (2 s then 10 s by default) with +-20% jitter. */
export function backoffMs(baseDelayMs: number, failedAttempt: number, random: () => number = Math.random): number {
  const nominal = baseDelayMs * 5 ** (failedAttempt - 1);
  return Math.round(nominal * (0.8 + random() * 0.4));
}
