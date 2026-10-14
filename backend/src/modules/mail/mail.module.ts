import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createMailTransport } from "./mail.config.js";
import { MailService } from "./mail.service.js";
import { MAIL_TRANSPORT } from "./mail.types.js";

@Global()
@Module({
  providers: [{ provide: MAIL_TRANSPORT, inject: [ConfigService], useFactory: createMailTransport }, MailService],
  exports: [MailService, MAIL_TRANSPORT]
})
export class MailModule {}
