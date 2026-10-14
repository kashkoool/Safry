import type { ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { MiddlewareConsumer, Module, NestModule, RequestMethod } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { validateEnvironment } from "./config/environment.js";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter.js";
import { MoneySerializationInterceptor } from "./common/money/money.interceptor.js";
import { RequestContextMiddleware } from "./common/middleware/request-context.middleware.js";
import { TenantContextMiddleware } from "./common/middleware/tenant-context.middleware.js";
import { HttpSupportModule } from "./common/http/http.module.js";
import { RequestLoggerMiddleware } from "./common/http/request-logger.middleware.js";
import { createThrottlerStorage, accountOf, accountTracker, UserRateLimitGuard } from "./common/http/rate-limit.js";
import { JwtAuthGuard } from "./common/security/jwt-auth.guard.js";
import { PermissionsGuard } from "./common/security/permissions.guard.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { IdentityModule } from "./modules/identity/identity.module.js";
import { EntitiesModule } from "./modules/entities/entities.module.js";
import { OperationsModule } from "./modules/operations/operations.module.js";
import { TravelServicesModule } from "./modules/travel-services/travel-services.module.js";
import { PlatformModule } from "./modules/platform/platform.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnvironment }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // Rate limiting is bypassed only in the automated test environment.
      useFactory: (config: ConfigService) => {
        const skipIf = (): boolean => config.get<string>("NODE_ENV") === "test";
        return {
          storage: createThrottlerStorage(config),
          throttlers: [
            // Per client address (the real one: see TRUST_PROXY); generous because offices and mobile carriers share one.
            { name: "default", ttl: 60_000, limit: config.get<number>("RATE_LIMIT_IP_PER_MINUTE", 300), skipIf },
            // Per (account named in the body, client address): one source hammering one account. Many addresses against one account is the database lockout's job; an e-mail-only key would let a stranger lock the owner out.
            {
              name: "account", ttl: 60_000, limit: config.get<number>("RATE_LIMIT_ACCOUNT_PER_MINUTE", 20),
              skipIf: (context: ExecutionContext): boolean => skipIf() || !accountOf(context.switchToHttp().getRequest<Request>()),
              getTracker: (request: Record<string, unknown>): string => accountTracker(request as unknown as Request)
            }
          ]
        };
      }
    }),
    DatabaseModule,
    HttpSupportModule,
    HealthModule,
    IdentityModule,
    EntitiesModule,
    TravelServicesModule,
    OperationsModule,
    PlatformModule
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: MoneySerializationInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserRateLimitGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard }
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestContextMiddleware, RequestLoggerMiddleware, TenantContextMiddleware)
      .forRoutes({ path: "{*path}", method: RequestMethod.ALL });
  }
}
