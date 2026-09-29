/**
 * apps/api/src/catalog/albums.controller.ts
 *
 * 相册接口：GET 匿名可读但只返回公开相册，带 admin/editor 凭证时可读私有；
 * 创建 / 改信息 / 改成员需 admin 或 editor；删除需 admin。
 */
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { canSeePrivate, OptionalJwtGuard } from '../auth/optional-jwt.guard';
import type { MaybeAuthedRequest } from '../auth/optional-jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AlbumsService } from './albums.service';
import type { ApiAlbum, ApiAlbumDetail, CreateAlbumDto, UpdateAlbumDto } from './albums.service';

@Controller('albums')
export class AlbumsController {
  constructor(private readonly albums: AlbumsService) {}

  /** 软认证：匿名只看公开，后台凭证可见全部（含私有） */
  @Get()
  @UseGuards(OptionalJwtGuard)
  list(@Req() req: MaybeAuthedRequest): Promise<ApiAlbum[]> {
    return this.albums.list(canSeePrivate(req));
  }

  @Get(':id')
  @UseGuards(OptionalJwtGuard)
  async detail(@Req() req: MaybeAuthedRequest, @Param('id') id: string): Promise<ApiAlbumDetail> {
    return this.albums.detail(id, canSeePrivate(req), await this.albums.privacyPass(req));
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  create(@Body() dto: CreateAlbumDto): Promise<ApiAlbum> {
    return this.albums.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  update(@Param('id') id: string, @Body() dto: UpdateAlbumDto): Promise<ApiAlbum> {
    return this.albums.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async remove(@Param('id') id: string): Promise<{ removed: number }> {
    await this.albums.remove(id);
    return { removed: 1 };
  }

  /** 批量调整分组：把多个相册一次性移到目标分组（与其它相册写操作同权限） */
  @Put('group')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  assignGroup(@Body() body: { ids?: string[]; groupId?: string }): Promise<{ moved: number }> {
    if (!body.groupId) throw new BadRequestException('请先选择目标分组');
    return this.albums.assignGroup(body.ids ?? [], body.groupId);
  }

  /** 全量替换相册成员：ids 的顺序即新的 sortOrder（增 / 删 / 排序一次完成） */
  @Put(':id/media')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  setMedia(@Param('id') id: string, @Body() body: { ids?: string[] }): Promise<ApiAlbum> {
    return this.albums.setMedia(id, body.ids ?? []);
  }
}
