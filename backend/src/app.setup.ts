import { Logger, ValidationPipe, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { Express } from "express";
import compression from "compression";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { productionLike } from "./config/environment.js";

/** Shared HTTP configuration for the server entry point and the integration tests. */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  const prefix = config.get<string>("API_PREFIX", "api/v1");
  const production = productionLike(config);
  if (config.get<string>("NODE_ENV") === "staging" && !production)
    new Logger("Config").warn("NODE_ENV=staging with ALLOW_NON_PRODUCTION_DEFAULTS=true: development defaults are active (console mail, open API docs, localhost CORS, non-Secure cookies). Never use this on an internet-facing or production-data environment.");

  configureTrustProxy(app, config.get<string>("TRUST_PROXY"));
  app.use(helmet());
  app.use(noStoreMiddleware(prefix));
  app.use(compression({ filter: compressionFilter }));
  // Every JSON payload in this API is small; a hard cap keeps one request from pinning memory and the event loop.
  const bodyLimit = config.get<string>("BODY_LIMIT", "100kb");
  const express = app as NestExpressApplication;
  express.useBodyParser("json", { limit: bodyLimit });
  express.useBodyParser("urlencoded", { limit: bodyLimit, extended: false });
  app.enableCors(corsOptions(config.get<string>("CORS_ORIGINS"), production));
  app.setGlobalPrefix(prefix);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true
    })
  );
  app.enableShutdownHooks();
  configureSwagger(app, prefix, swaggerEnabled(config.get<string>("SWAGGER_ENABLED"), production));
}

/** Marks the response as the BREACH-sensitive kind (token bearing); set by noStoreMiddleware, read by compressionFilter. */
const SENSITIVE = Symbol("safry.noCompress");

/**
 * Authenticated API answers must never be stored by browsers or shared caches. Everything under
 * the API prefix gets `Cache-Control: no-store` + `Pragma: no-cache` (docs and health are served elsewhere / are public).
 * Auth routes (tokens in the body) are additionally excluded from compression (BREACH hygiene).
 */
export function noStoreMiddleware(prefix: string): (req: Request, res: Response, next: NextFunction) => void {
  const base = `/${prefix.replace(/^\/+|\/+$/g, "")}`;
  return (req, res, next) => {
    const path = req.path;
    if (path.startsWith(`${base}/`) && !path.startsWith(`${base}/docs`)) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      if (path.startsWith(`${base}/auth/`)) (res as unknown as Record<symbol, boolean>)[SENSITIVE] = true;
    }
    next();
  };
}

function compressionFilter(req: Request, res: Response): boolean {
  if ((res as unknown as Record<symbol, boolean>)[SENSITIVE]) return false;
  return compression.filter(req, res);
}

const PROXY_TOKEN = /^(loopback|linklocal|uniquelocal|[0-9a-fA-F:.]+(\/\d{1,3})?)$/;

/**
 * TRUST_PROXY: unset or "false" = no proxy; "true" = one hop (nginx in docker-compose);
 * an integer = that many hops (e.g. 2 for TLS terminator -> nginx -> API);
 * or a comma-separated list of proxy addresses/CIDRs/"loopback|linklocal|uniquelocal".
 * The right value depends on the hosting topology; a wrong one lets clients spoof their IP (rate limits).
 */
export function trustProxySetting(raw: string | undefined): boolean | number | string[] {
  const value = raw?.trim() ?? "";
  if (value === "" || value === "false") return false;
  if (value === "true") return 1;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops > 10) throw new Error("TRUST_PROXY hop count must be between 0 and 10");
    return hops;
  }
  const list = value.split(",").map((entry) => entry.trim());
  if (list.some((entry) => !PROXY_TOKEN.test(entry)))
    throw new Error("TRUST_PROXY must be true, false, a hop count, or a comma-separated list of proxy IPs/CIDRs");
  return list;
}

function configureTrustProxy(app: INestApplication, raw: string | undefined): void {
  const setting = trustProxySetting(raw);
  if (setting !== false) (app.getHttpAdapter().getInstance() as Express).set("trust proxy", setting);
}

/**
 * CORS is only needed when the SPA is served from a different origin than the API. The shipped
 * stack is same-origin (nginx proxies /api), so production allows no cross-origin callers unless
 * CORS_ORIGINS lists exact https origins. Access tokens are bearer tokens; the refresh token is an HttpOnly cookie, so
 * cross-origin callers need credentials. They are granted only together with an explicit origin list (the cors middleware
 * then echoes the one matching origin, never `*`), and the cookie endpoints re-check Origin themselves.
 */
export function corsOptions(raw: string | undefined, production: boolean): { origin: string[] | false; credentials: boolean } {
  const configured = raw?.trim() ? raw.split(",").map((origin) => origin.trim()) : [];
  const origins = configured.length > 0 || production ? configured : ["http://localhost:3001"];
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CORS_ORIGINS entry "${origin}" is not a valid origin`);
    }
    if (url.origin !== origin) throw new Error(`CORS_ORIGINS entry "${origin}" must be a bare origin (scheme://host[:port], no path or trailing slash)`);
    if (production && url.protocol !== "https:") throw new Error(`CORS_ORIGINS entry "${origin}" must use https in production`);
  }
  return { origin: origins.length > 0 ? origins : false, credentials: origins.length > 0 };
}

/** API docs are on by default outside production and off in production unless SWAGGER_ENABLED=true. */
export function swaggerEnabled(raw: string | undefined, production: boolean): boolean {
  if (raw !== undefined && raw !== "" && raw !== "true" && raw !== "false") throw new Error("SWAGGER_ENABLED must be true or false");
  return raw === "true" || (raw !== "false" && !production);
}

function configureSwagger(app: INestApplication, prefix: string, enabled: boolean): void {
  if (!enabled) return;
  const swaggerConfig = new DocumentBuilder()
    .setTitle("Safry Platform API")
    .setDescription("Safry modular backend API")
    .setVersion("0.1.0")
    .addBearerAuth()
    .addApiKey({ type: "apiKey", name: "x-tenant-id", in: "header" }, "tenant")
    .build();
  SwaggerModule.setup(`${prefix}/docs`, app, SwaggerModule.createDocument(app, swaggerConfig));
  new Logger("Swagger").log(`API docs served at /${prefix}/docs`);
}
