/**
 * apps/api/src/auth/roles.guard.ts
 *
 * RBAC 守卫：配合 @Roles('admin') 使用，校验 JWT payload 里的 role 是否在允许列表内。
 * 它假定 JwtAuthGuard 已先行把 req.user 挂上 —— 两者务必同时用在 @UseGuards(JwtAuthGuard, RolesGuard)。
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtPayload } from './auth.service';

export const ROLES_KEY = 'roles';
/** 标记接口需要的角色，如 @Roles('admin') */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    if (!request.user || !required.includes(request.user.role)) {
      throw new ForbiddenException('权限不足');
    }
    return true;
  }
}