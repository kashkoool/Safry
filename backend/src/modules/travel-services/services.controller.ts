import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { PageQueryDto } from "../../common/pagination.js";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthUser } from "../../common/security/auth-user.js";
import { CurrentUser } from "../../common/security/current-user.decorator.js";
import { RequirePermissions } from "../../common/security/permissions.decorator.js";
import { CreateServiceDto } from "./dto/create-service.dto.js";
import { UpdateServiceDto } from "./dto/update-service.dto.js";
import { CatalogService } from "./catalog.service.js";
import { ExchangeRatesService } from "./exchange-rates.service.js";

@ApiTags("travel / services")
@ApiBearerAuth()
@Controller("services")
export class ServicesController {
  constructor(private readonly travel: CatalogService, private readonly exchangeRates: ExchangeRatesService) {}

  @Get("exchange-rates")
  @RequirePermissions("catalog.service.read")
  exchangeRatesLatest(): Promise<unknown> {
    return this.exchangeRates.latest();
  }

  @Get()
  @RequirePermissions("catalog.service.read")
  list(
    @CurrentUser() user: AuthUser,
    @Query() page: PageQueryDto,
    @Res({ passthrough: true }) response: Response
  ): Promise<unknown> {
    return this.travel.listServices(user, page, response);
  }

  @Get("marketplace")
  @RequirePermissions("catalog.service.read")
  marketplace(
    @CurrentUser() user: AuthUser,
    @Query() page: PageQueryDto,
    @Res({ passthrough: true }) response: Response
  ): Promise<unknown> {
    return this.travel.listServices(user, page, response, true);
  }

  @Post()
  @RequirePermissions("catalog.service.manage")
  create(@CurrentUser() user: AuthUser, @Body() input: CreateServiceDto): Promise<unknown> {
    return this.travel.createService(user, input);
  }

  @Patch(":id")
  @RequirePermissions("catalog.service.manage")
  update(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: UpdateServiceDto
  ): Promise<unknown> {
    return this.travel.updateService(user, id, input);
  }
}
