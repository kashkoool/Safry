import { Module } from "@nestjs/common";
import { CatalogService } from "./catalog.service.js";
import { ExchangeRatesService } from "./exchange-rates.service.js";
import { ServicesController } from "./services.controller.js";

/** Travel Services: service catalog and marketplace. */
@Module({
  controllers: [ServicesController],
  providers: [CatalogService, ExchangeRatesService]
})
export class TravelServicesModule {}
