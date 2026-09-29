/**
 * apps/api/src/admin/users.controller.ts
 *
 * 账号管理接口，整体只对 admin 开放。
 * operator（当前操作者用户名）由 JWT 负载提供 —— 服务层靠它拦住
 * 「删掉自己 / 把自己降级」这类会立刻把后台锁死的操作。
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { MaybeAuthedRequest } from '../auth/optional-jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { UsersService } from './users.service';
import type { AdminUser, UserCreateDto, UserPatchDto } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(): Promise<AdminUser[]> {
    return this.users.list();
  }

  @Post()
  create(@Body() dto: UserCreateDto): Promise<AdminUser> {
    return this.users.create(dto);
  }

  /** 改角色 / 重置密码：只改传进来的字段 */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UserPatchDto,
    @Req() req: MaybeAuthedRequest,
  ): Promise<AdminUser> {
    return this.users.update(id, dto, req.user?.username ?? '');
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: MaybeAuthedRequest): Promise<{ removed: number }> {
    await this.users.remove(id, req.user?.username ?? '');
    return { removed: 1 };
  }
}