import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthPrincipalCache, InMemoryAuthPrincipalCache } from "../common/cache/auth-principal-cache.js";
import { PrismaService } from "./prisma.service.js";

@Global()
@Module({
  providers: [
    {
      provide: AuthPrincipalCache,
      inject: [ConfigService],
      // Staleness bound for a revoked session / changed role on OTHER replicas; 0 disables the cache.
      useFactory: (config: ConfigService): AuthPrincipalCache =>
        new InMemoryAuthPrincipalCache(
          config.get<number>("AUTH_CACHE_TTL_MS", 5000),
          config.get<number>("AUTH_CACHE_MAX_ENTRIES", 10_000)
        )
    },
    PrismaService
  ],
  exports: [PrismaService, AuthPrincipalCache]
})
export class DatabaseModule {}
