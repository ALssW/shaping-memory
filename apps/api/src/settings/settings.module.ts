/**
 * apps/api/src/settings/settings.module.ts
 *
 * 站点设置模块。导出 SettingsService：上传接口要读它来校验体积与扩展名。
 */
import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}