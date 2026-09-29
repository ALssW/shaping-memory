/**
 * apps/api/src/search/search.controller.ts
 *
 * 专用检索接口（公开读，与 /photos 同为软认证口径）：
 *   GET /search/photos   照片多维检索
 *   GET /search/suggest  字典联想（搜索框的「输入即联想」）
 *
 * 前台搜索面板与后台照片检索都只走这里，/photos 留给「整份档案读取」。
 */
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import type { MaybeAuthedRequest } from '../auth/optional-jwt.guard';
import { buildListFilter, parsePage } from '../photos/filter-params';
import type { ApiPhoto } from '../photos/photos.service';
import type { ApiDictionaryEntry } from '../dictionary/dictionary.service';
import { SearchService } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /**
   * 照片检索：分类 / 关键词 / 拍摄日期范围 / 机身 / 镜头 / 光圈 / 快门 / 感光度 / 有无定位 / 标签。
   * 全部维度可选且可叠加；一个都不传就是「整份档案按拍摄时间排序」。
   * 分页用 limit/offset（与 /photos 同一份解析器）：不传 limit 即整份档案。
   */
  @Get('photos')
  @UseGuards(OptionalJwtGuard)
  async photos(
    @Req() req: MaybeAuthedRequest,
    @Query() query: Record<string, string | undefined>,
  ): Promise<ApiPhoto[]> {
    return this.search.listPhotos(buildListFilter(query), parsePage(query), await this.search.pass(req));
  }

  /** 字典联想：kind 必传（camera / lens / aperture / shutter / iso） */
  @Get('suggest')
  suggest(
    @Query('kind') kind: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): Promise<ApiDictionaryEntry[]> {
    return this.search.suggest(kind, q ?? '', limit == null || limit === '' ? undefined : Number(limit));
  }
}