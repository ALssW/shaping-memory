/**
 * apps/api/src/admin/stats.controller.ts
 *
 * 数据概览接口。只读的聚合数字，admin 与 editor 都能看（后台上首页时不必因角色不同而空白）。
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { StatsService } from './stats.service';
import type { AdminStats } from './stats.service';

@Controller('stats')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'editor')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  overview(): Promise<AdminStats> {
    return this.stats.overview();
  }
}