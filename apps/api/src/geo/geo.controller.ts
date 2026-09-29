/**
 * apps/api/src/geo/geo.controller.ts
 *
 * 地点搜索接口：
 *   GET /geo/places?q=上海外滩
 *
 * 【为什么公开无鉴权】地图选点在**前台工具模块**里是匿名可用的（用户没登录也要能改
 * 自己的照片定位），加鉴权会把这条路径整个堵死。代价只是「谁能搜地名」这一条极低风险的能力。
 * 【为什么独立成模块而不是挂在 /search 下】/search 的语义是「检索站内内容（照片、字典）」，
 * 这里是「向外部地图服务查地名」—— 数据来源、失败模式、缓存策略都不同，放一起会互相牵扯。
 */
import { Controller, Get, Query } from '@nestjs/common';
import { GeoService } from './geo.service';
import type { GeoPlaceHit } from './geo.service';

@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  /** 关键词搜地点：返回 WGS-84 坐标，空关键词返回空数组（不算错误） */
  @Get('places')
  places(@Query('q') q?: string): Promise<GeoPlaceHit[]> {
    return this.geo.searchPlaces(q ?? '');
  }
}