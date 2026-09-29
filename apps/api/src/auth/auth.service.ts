/**
 * apps/api/src/auth/auth.service.ts
 *
 * 认证核心：校验凭据、签发 JWT。密码只存 bcrypt 哈希（见 users 表），绝不落明文。
 * JWT payload 只放「够判权限」的三项：sub / username / role。
 */
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import { users } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import { DB } from '../infra.module';

/** JWT 负载：sub 是用户 id，role 是角色 id（admin/editor/viewer） */
export interface JwtPayload {
  sub: string;
  username: string;
  role: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jwt: JwtService,
  ) {}

  /** 校验账号密码，成功则签发 7 天有效的 JWT */
  async login(username: string, password: string): Promise<{ token: string; username: string; role: string }> {
    const row = await this.db.query.users.findFirst({ where: eq(users.username, username) });
    if (!row || !(await bcrypt.compare(password, row.passwordHash))) {
      throw new UnauthorizedException('账号或密码错误');
    }
    const payload: JwtPayload = { sub: row.id, username: row.username, role: row.roleId };
    return { token: await this.jwt.signAsync(payload), username: row.username, role: row.roleId };
  }
}