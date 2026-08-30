import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  RequestTimeoutException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, throwError, TimeoutError } from "rxjs";
import { catchError, timeout } from "rxjs/operators";
import { LONG_RUNNING_KEY } from "../decorators/long-running.decorator";

const DEFAULT_TIMEOUT_MS = 60000;
// Các route đánh dấu @LongRunning() (vd: parse-document xử lý AI/convert ảnh) được cấp 5 phút
// thay vì 60s mặc định — đủ thời gian cho convert nhiều ảnh WMF + gọi OpenRouter nhiều lần.
const LONG_RUNNING_TIMEOUT_MS = 9 * 60 * 1000;

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const isLongRunning = this.reflector.getAllAndOverride<boolean>(LONG_RUNNING_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const timeoutMs = isLongRunning ? LONG_RUNNING_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

    return next.handle().pipe(
      timeout(timeoutMs),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(() => new RequestTimeoutException());
        }
        return throwError(() => err);
      })
    );
  }
}
