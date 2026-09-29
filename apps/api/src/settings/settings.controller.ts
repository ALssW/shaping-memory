/**
 * apps/api/src/settings/settings.controller.ts
 *
 * 站点设置：读公开（前台页头要显示站点标题与标语），写需 admin。
 */
import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SettingsService } from './settings.service';
import type { SiteSettings } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** 读全部设置（公开：不含任何敏感项，键名已在服务层的白名单里限定） */
  @Get()
  all(): Promise<SiteSettings> {
    return this.settings.all();
  }

  /** 改设置（需 admin）：只接受白名单内的键，返回改后的全量 */
  @Put()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(@Body() patch: Record<string, unknown>): Promise<SiteSettings> {
    return this.settings.update(patch);
  }
}