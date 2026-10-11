import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { OrganizationController } from "./organizations/organization.controller.js";
import { OrganizationService } from "./organizations/organization.service.js";
import { ProvidersController } from "./providers/providers.controller.js";
import { ProvidersService } from "./providers/providers.service.js";

/** Business Entities: service providers and their staff and departments. */
@Module({
  imports: [IdentityModule],
  controllers: [ProvidersController, OrganizationController],
  providers: [ProvidersService, OrganizationService]
})
export class EntitiesModule {}
