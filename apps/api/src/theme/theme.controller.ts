/**
 * apps/api/src/theme/theme.controller.ts
 *
 * 主题配置：读公开（前台要在首屏渲染前套用样式），写需 admin。
 */
import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { ThemeService } from './theme.service';
import type { ThemeConfig } from '@shaping-memory/core';

@Controller('theme')
export class ThemeController {
  constructor(private readonly theme: ThemeService) {}

  /** 读主题配置（公开：不含任何敏感项，且返回值一定经过归一化） */
  @Get()
  get(): Promise<ThemeConfig> {
    return this.theme.get();
  }

  /** 改主题配置（需 admin）：局部补丁语义，返回归一化后的全量 */
  @Put()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(@Body() patch: Record<string, unknown>): Promise<ThemeConfig> {
    return this.theme.update(patch);
  }

  /** 恢复出厂（需 admin）：整体替换为出厂值 */
  @Post('reset')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  reset(): Promise<ThemeConfig> {
    return this.theme.reset();
  }
}