/**
 * apps/api/src/theme/theme.module.ts
 *
 * 主题配置模块。独立于 SettingsModule —— 那个服务的白名单是有意做窄的，
 * 不该为了主题再放宽（放宽就给了后台覆盖 privacy.* 的机会）。
 */
import { Module } from '@nestjs/common';
import { ThemeController } from './theme.controller';
import { ThemeService } from './theme.service';

@Module({
  controllers: [ThemeController],
  providers: [ThemeService],
})
export class ThemeModule {}