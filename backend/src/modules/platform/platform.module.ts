import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { PlatformController } from "./platform.controller.js";
import { PlatformService } from "./platform.service.js";
@Module({ imports: [IdentityModule], controllers: [PlatformController], providers: [PlatformService] })
export class PlatformModule {}
