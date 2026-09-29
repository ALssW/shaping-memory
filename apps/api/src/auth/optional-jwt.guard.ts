/**
 * apps/api/src/auth/optional-jwt.guard.ts
 *
 * 「认得出就认，认不出也放行」的软认证守卫。
 * 与 JwtAuthGuard 的唯一区别：缺少 / 无效凭证时**不抛 401**，只是不挂 req.user。
 *
 * 【用在哪】「匿名能看，登录后能看更多」的读接口 —— 例如相册列表：
 * 匿名只应看到公开相册，后台带上 token 则应看到全部（含私有）。
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { JwtPayload } from './auth.service';

/** 认证是可选的：user 可能存在，也可能没有 */
export type MaybeAuthedRequest = Request & { user?: JwtPayload };

@Injectable()
export class OptionalJwtGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MaybeAuthedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return true;
    try {
      request.user = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
    } catch {
      // 凭证过期 / 被篡改时按匿名处理即可，不该因此打断一次公开读取
    }
    return true;
  }
}

/** 能看私有内容的角色：后台编辑者与管理员 */
const PRIVATE_ROLES = new Set(['admin', 'editor']);

/** 由可选认证结果推导「是否可读私有相册」 */
export function canSeePrivate(req: MaybeAuthedRequest): boolean {
  return req.user != null && PRIVATE_ROLES.has(req.user.role);
}
