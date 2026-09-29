/**
 * apps/api/src/photos/photos.controller.ts
 *
 * 读接口（list/get）公开；写接口（编辑/删除）套 JWT + RBAC：
 *   - 编辑（PATCH）需要 admin 或 editor
 *   - 删除（DELETE/batch）需要 admin
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import type { MaybeAuthedRequest } from '../auth/optional-jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { buildListFilter, parsePage } from './filter-params';
import { ApiPhoto, OriginalExifResult, PhotoExifResult, PhotosService, UpdateExifDto, UpdatePhotoDto } from './photos.service';

@Controller('photos')
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  /**
   * 整份档案读取（公开）。带筛选条件时与 /search/photos 完全等价 ——
   * 参数解析共用一份（见 filter-params.ts），因此从哪里进来都得到同一批照片。
   * 专用检索入口见 /search/photos（前台搜索面板与后台照片检索走那条）。
   *
   * 用 OptionalJwtGuard（软认证）：匿名也能读，但只看得到公开照片；
   * 带上授权账号的 token 或 URL 上的隐私票据，就能看到（或解锁）隐私照片。
   *
   * 分页用 limit/offset（见 parsePage）：**不传 limit 即整份档案**，后台管理端因此不受影响。
   */
  @Get()
  @UseGuards(OptionalJwtGuard)
  async list(
    @Req() req: MaybeAuthedRequest,
    @Query() query: Record<string, string | undefined>,
  ): Promise<ApiPhoto[]> {
    return this.photos.list(buildListFilter(query), parsePage(query), await this.photos.pass(req));
  }

  @Get(':id')
  @UseGuards(OptionalJwtGuard)
  async get(@Param('id') id: string, @Req() req: MaybeAuthedRequest): Promise<ApiPhoto> {
    const photo = await this.photos.get(id, await this.photos.pass(req));
    // 被隐藏的隐私照片对无权者也走这条 404：不透露「这张存在但被藏了」
    if (!photo) throw new NotFoundException('照片不存在');
    return photo;
  }

  /**
   * 批量改元数据（标题/分类/点赞/标签/隐私标记）。
   * 【为什么必须声明在 @Patch(':id') 之前】Express 按声明顺序匹配路由，
   * 放在后面的话 PATCH /photos/batch 会被 :id 抢先吃掉（id = 'batch'）而变成 404。
   */
  @Patch('batch')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  async updateBatch(@Body() body: { ids?: string[]; patch?: UpdatePhotoDto }): Promise<{ updated: number }> {
    if (!body.ids || body.ids.length === 0) throw new BadRequestException('请先选择要处理的照片');
    const updated = await this.photos.updateBatch(body.ids, body.patch ?? {});
    return { updated };
  }

  /** 批量写回同一份 EXIF 补丁（含地图选点写入的定位）；同上一段，必须排在 :id 之前 */
  @Patch('batch-exif')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  async updateBatchExif(
    @Body() body: { ids?: string[] } & UpdateExifDto,
  ): Promise<{ updated: number }> {
    if (!body.ids || body.ids.length === 0) throw new BadRequestException('请先选择要处理的照片');
    const { ids, ...payload } = body;
    const updated = await this.photos.updateExifBatch(ids, payload);
    return { updated };
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  async update(
    @Param('id') id: string,
    @Body() patch: UpdatePhotoDto,
    @Req() req: MaybeAuthedRequest,
  ): Promise<ApiPhoto> {
    return this.photos.update(id, patch, await this.photos.pass(req));
  }

  /**
   * 全量 EXIF 读取 / 写入（数据库是唯一事实源，不再改写照片文件）。
   * 读写都要求登录：这是「元数据编辑面」，不是前台展示面（前台展示走 GET /photos/:id）。
   */
  @Get(':id/exif')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  async exif(@Param('id') id: string, @Req() req: MaybeAuthedRequest): Promise<PhotoExifResult> {
    return this.photos.exifOf(id, await this.photos.pass(req));
  }

  /**
   * 「查看原片 EXIF」：读**原片本体**里的 EXIF（只读，不写库、不改文件），
   * 供后台与「库里记的」对照 —— 云端原片自上传起不可变，这里读到的才是原始信息。
   */
  @Get(':id/original-exif')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  async originalExif(@Param('id') id: string): Promise<OriginalExifResult> {
    return this.photos.originalExifOf(id);
  }

  @Patch(':id/exif')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  async updateExif(
    @Param('id') id: string,
    @Body() payload: UpdateExifDto,
    @Req() req: MaybeAuthedRequest,
  ): Promise<PhotoExifResult> {
    return this.photos.updateExif(id, payload, await this.photos.pass(req));
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async remove(@Param('id') id: string): Promise<{ removed: number }> {
    await this.photos.remove(id);
    return { removed: 1 };
  }

  @Post('batch-delete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async removeBatch(@Body() body: { ids?: string[] }): Promise<{ removed: number }> {
    if (!body.ids || body.ids.length === 0) throw new BadRequestException('请先选择要处理的照片');
    const removed = await this.photos.removeBatch(body.ids);
    return { removed };
  }
}