import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createMailRetryPolicy, createMailTransport } from "./mail.config.js";
import { MailBudget } from "./mail-budget.js";
import { MailService } from "./mail.service.js";
import { MAIL_RETRY, MAIL_TRANSPORT } from "./mail.types.js";

@Global()
@Module({
  providers: [{ provide: MAIL_TRANSPORT, inject: [ConfigService], useFactory: createMailTransport },
    { provide: MAIL_RETRY, inject: [ConfigService], useFactory: createMailRetryPolicy },
    MailBudget,
    MailService
  ],
  exports: [MailService, MAIL_TRANSPORT]
})
export class MailModule {}
