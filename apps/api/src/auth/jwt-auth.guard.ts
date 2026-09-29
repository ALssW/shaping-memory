/**
 * apps/api/src/auth/jwt-auth.guard.ts
 *
 * JWT 守卫：从 Authorization: Bearer 头取出凭证并校验，通过则把 payload 挂到 req.user。
 * 不经 passport —— 直接调 JwtService.verifyAsync，少一层中间件。
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { JwtPayload } from './auth.service';

export type AuthedRequest = Request & { user: JwtPayload };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('缺少登录凭证');
    try {
      request.user = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
      return true;
    } catch {
      throw new UnauthorizedException('凭证无效或已过期');
    }
  }
}