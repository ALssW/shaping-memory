/**
 * apps/api/src/admin/admin.module.ts
 *
 * 后台管理模块：账号、概览。两者都只依赖 InfraModule 提供的 DB，不需要别的模块。
 */
import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController, StatsController],
  providers: [UsersService, StatsService],
})
export class AdminModule {}