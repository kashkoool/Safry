import { randomUUID } from "node:crypto";
import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { requestContext } from "../context/request-context.js";

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const incoming = request.header("x-request-id");
    const requestId = incoming && /^[0-9a-f-]{36}$/i.test(incoming) ? incoming : randomUUID();
    response.setHeader("x-request-id", requestId);
    requestContext.run({ requestId }, next);
  }
}
