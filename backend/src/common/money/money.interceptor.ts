import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { map, type Observable } from "rxjs";
import { serializeMoney } from "./money.js";

/** Global: turns bigint money columns into JSON numbers (with a safe-integer check) so the API shape is unchanged. */
@Injectable()
export class MoneySerializationInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(serializeMoney));
  }
}
