import { ConsoleLogger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true, colors: false })
  });
  configureApp(app);
  const config = app.get(ConfigService);
  await app.listen(config.get<number>("PORT", 3000));
  // Slow-client protection and keep-alive that outlives a typical 60 s load-balancer idle timeout.
  const server = app.getHttpServer() as import("node:http").Server;
  server.keepAliveTimeout = config.get<number>("HTTP_KEEP_ALIVE_TIMEOUT_MS", 65_000);
  server.headersTimeout = server.keepAliveTimeout + 1000;
  server.requestTimeout = config.get<number>("HTTP_REQUEST_TIMEOUT_MS", 30_000);
}

await bootstrap();
