import { Logger } from "@nestjs/common";
import type { MailMessage, MailTransport } from "./mail.types.js";

/**
 * Development and test transport: nothing leaves the process. Messages are kept in a bounded in-memory outbox (tests read it) and
 * the recipient, subject and the first link are logged so a developer can follow the flow without a mail account. Refused in
 * production by the environment validation: the link is a credential.
 */
export class ConsoleTransport implements MailTransport {
  readonly name = "console" as const;
  private readonly logger = new Logger("MailConsole");
  private readonly sent: Array<MailMessage & { at: Date; idempotencyKey: string }> = [];

  constructor(private readonly keep = 200, private readonly log = true) {}

  send(message: MailMessage, idempotencyKey: string): Promise<void> {
    this.sent.push({ ...message, at: new Date(), idempotencyKey });
    if (this.sent.length > this.keep) this.sent.shift();
    if (this.log) {
      const link = /https?:\/\/\S+/.exec(message.text)?.[0] ?? "(no link)";
      this.logger.log(`to=${message.to} subject="${message.subject}" link=${link}`);
    }
    return Promise.resolve();
  }

  get outbox(): ReadonlyArray<MailMessage & { at: Date; idempotencyKey: string }> {
    return this.sent;
  }

  clear(): void {
    this.sent.length = 0;
  }
}
