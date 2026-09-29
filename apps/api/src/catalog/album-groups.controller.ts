/**
 * apps/api/src/catalog/album-groups.controller.ts
 *
 * 分组接口：GET 匿名可读（前台影集页要拿它做导航）；
 * 增 / 改 / 排序 / 删一律需 admin —— 需求明确「只有管理员可进行分组管理」，
 * 因此这里与相册写接口（admin + editor）不同，把 editor 挡在外面。
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AlbumGroupsService } from './album-groups.service';
import type { ApiAlbumGroup, CreateAlbumGroupDto, UpdateAlbumGroupDto } from './album-groups.service';

@Controller('album-groups')
export class AlbumGroupsController {
  constructor(private readonly groups: AlbumGroupsService) {}

  /** 分组列表（公开）：前台导航条与后台分组管理页共用 */
  @Get()
  list(): Promise<ApiAlbumGroup[]> {
    return this.groups.list();
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  create(@Body() dto: CreateAlbumGroupDto): Promise<ApiAlbumGroup> {
    return this.groups.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(@Param('id') id: string, @Body() dto: UpdateAlbumGroupDto): Promise<ApiAlbumGroup> {
    return this.groups.update(id, dto);
  }

  /** 全量重写排序：body.ids 的顺序即新的 sortOrder（后台拖拽结束后整体上传） */
  @Put('order')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  reorder(@Body() body: { ids?: string[] }): Promise<ApiAlbumGroup[]> {
    return this.groups.reorder(body.ids ?? []);
  }

  /** 删除分组：body.moveTo 指定组内相册的去处，缺省落「默认分组」 */
  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  remove(@Param('id') id: string, @Body() body: { moveTo?: string }): Promise<{ removed: number; moved: number }> {
    return this.groups.remove(id, body.moveTo);
  }
}