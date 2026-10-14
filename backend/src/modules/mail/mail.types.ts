export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Delivery backend. Implementations must never log the message body or any credential. */
export interface MailTransport {
  readonly name: "resend" | "console";
  send(message: MailMessage, idempotencyKey: string): Promise<void>;
}

export const MAIL_TRANSPORT = Symbol("MAIL_TRANSPORT");

export class MailDeliveryError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MailDeliveryError";
  }
}
