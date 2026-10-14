import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { MAIL_TRANSPORT, type MailTransport } from "./mail.types.js";
import { mailLocale, renderMail, type MailTemplate } from "./templates.js";

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(@Inject(MAIL_TRANSPORT) readonly transport: MailTransport) {}

  /** Renders the template for the user's locale and hands it to the transport; the caller decides whether to await. */
  send(to: string, locale: string | null | undefined, template: MailTemplate, idempotencyKey: string = randomUUID()): Promise<void> {
    return this.transport.send(renderMail(mailLocale(locale), template, to), idempotencyKey);
  }

  /**
   * Delivery after the HTTP answer has been decided: a slow or failing provider must neither change the response time (an account
   * enumeration signal) nor turn into an error for the caller. Failure is logged without recipient or body.
   */
  sendDetached(to: string, locale: string | null | undefined, template: MailTemplate, idempotencyKey?: string): void {
    this.send(to, locale, template, idempotencyKey).catch((error: unknown) => {
      this.logger.error(`mail "${template.kind}" not delivered: ${error instanceof Error ? error.message : "unknown error"}`);
    });
  }
}
