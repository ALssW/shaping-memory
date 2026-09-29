/**
 * apps/api/src/auth/auth.controller.ts
 *
 * POST /auth/login：账号密码换 JWT。手动校验入参（不引 class-validator，少一层依赖）。
 */
import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() body: { username?: string; password?: string }) {
    if (!body.username || !body.password) {
      throw new BadRequestException('账号与密码均为必填');
    }
    return this.auth.login(body.username, body.password);
  }
}