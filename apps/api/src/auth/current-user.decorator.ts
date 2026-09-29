/**
 * apps/api/src/auth/current-user.decorator.ts
 *
 * @CurrentUser() 参数装饰器：直接从 req.user 取 JWT payload，避免每个接口都手写 switchToHttp。
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from './auth.service';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): JwtPayload =>
    context.switchToHttp().getRequest<{ user: JwtPayload }>().user,
);