/**
 * apps/api/src/audit/audit.interceptor.ts
 *
 * 全局拦截器：把每一次**写操作**留进审计表。
 *
 * 【为什么用拦截器而不是在各个 service 里手动记】写操作分散在照片、相册、分类、账号、
 * 隐私等十几个接口上，逐个埋点既容易漏、又会在加新接口时被忘记；挂在全局则天然覆盖。
 *
 * 【执行顺序】Nest 的链路是 中间件 → 守卫 → 拦截器 → 管道 → handler，
 * 因此拦截器里读 req.user 时，JwtAuthGuard 已经挂好了「谁在操作」。
 *
 * 【只记方法 + 路径 + 状态码，不记请求体】请求体可能含密码，也可能很大；
 * 而路径里的 query 同样要剥掉 —— 隐私票据（?pt=）与提取码都在 query 里，绝不能进日志表。
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Request } from 'express';
import type { JwtPayload } from '../auth/auth.service';
import { AuditService } from './audit.service';

/** 只审计写操作：GET 是只读，记下来只会把日志表灌满 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    if (!WRITE_METHODS.has(request.method)) return next.handle();

    const entry = {
      actor: request.user?.username ?? null,
      method: request.method,
      // 剥掉 query：票据与提取码都在 query 里，不进日志
      path: (request.originalUrl || request.url).split('?')[0] ?? '',
    };
    const response = context.switchToHttp().getResponse<{ statusCode: number }>();

    return next.handle().pipe(
      // 成功与失败都要留痕：失败的那次往往才是要追查的
      tap({
        next: () => void this.audit.record({ ...entry, status: response.statusCode }),
        error: (err: { status?: number }) => void this.audit.record({ ...entry, status: err?.status ?? 500 }),
      }),
    );
  }
}