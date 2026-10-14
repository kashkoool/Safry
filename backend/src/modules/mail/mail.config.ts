import type { ConfigService } from "@nestjs/config";
import { ConsoleTransport } from "./console.transport.js";
import { ResendTransport } from "./resend.transport.js";
import { DEFAULT_MAIL_RETRY, type MailRetryPolicy, type MailTransport } from "./mail.types.js";

export type MailTransportName = "resend" | "console";

/** The transport the environment asks for: explicit MAIL_TRANSPORT, else resend in production and console elsewhere. */
export function mailTransportName(config: { get<T = string>(key: string): T | undefined }): MailTransportName {
  const explicit = config.get<string>("MAIL_TRANSPORT");
  if (explicit === "resend" || explicit === "console") return explicit;
  return config.get<string>("NODE_ENV") === "production" ? "resend" : "console";
}

export function createMailTransport(config: ConfigService): MailTransport {
  if (mailTransportName(config) === "console") return new ConsoleTransport(200, config.get<string>("NODE_ENV") !== "test");
  return new ResendTransport(
    config.getOrThrow<string>("RESEND_API_KEY"),
    config.getOrThrow<string>("MAIL_FROM"),
    config.get<number>("MAIL_TIMEOUT_MS", 8000)
  );
}

/** Frontend origin that links point to, without a trailing slash. */
export function appBaseUrl(config: { get<T = string>(key: string, fallback?: T): T | undefined }): string {
  return (config.get<string>("APP_BASE_URL") ?? "http://localhost:3001").replace(/\/+$/, "");
}

export function createMailRetryPolicy(config: ConfigService): MailRetryPolicy {
  return {
    attempts: config.get<number>("MAIL_RETRY_ATTEMPTS", DEFAULT_MAIL_RETRY.attempts),
    baseDelayMs: config.get<number>("MAIL_RETRY_BASE_MS", DEFAULT_MAIL_RETRY.baseDelayMs)
  };
}
