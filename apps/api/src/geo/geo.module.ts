/**
 * apps/api/src/geo/geo.module.ts
 *
 * 地理编码模块：目前只有「地名搜索」一件事。
 * AppConfig 由 @Global 的 InfraModule 提供，这里无需 import。
 */
import { Module } from '@nestjs/common';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';

@Module({
  controllers: [GeoController],
  providers: [GeoService],
})
export class GeoModule {}