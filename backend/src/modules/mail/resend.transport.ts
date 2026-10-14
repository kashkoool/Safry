import { MailDeliveryError, type MailMessage, type MailTransport } from "./mail.types.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Resend HTTP API over `fetch` (no SDK dependency). The request is bounded by a timeout. Errors carry the HTTP status or the
 * failure kind only: never the API key, the recipient or the message body.
 */
export class ResendTransport implements MailTransport {
  readonly name = "resend" as const;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly timeoutMs: number,
    private readonly endpoint: string = RESEND_ENDPOINT,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async send(message: MailMessage, idempotencyKey: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          // Resend de-duplicates a retried request carrying the same key (valid for 24 hours).
          "idempotency-key": idempotencyKey
        },
        body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new MailDeliveryError(timedOut ? "mail provider timed out" : "mail provider unreachable");
    }
    if (!response.ok) {
      // Drain without reading: the provider's error text can echo the recipient.
      await response.body?.cancel().catch(() => undefined);
      throw new MailDeliveryError(`mail provider answered HTTP ${response.status}`, response.status);
    }
    await response.body?.cancel().catch(() => undefined);
  }
}
