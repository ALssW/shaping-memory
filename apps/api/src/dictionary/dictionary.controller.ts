/**
 * apps/api/src/dictionary/dictionary.controller.ts
 *
 * 字典接口：
 *   - GET 公开（前后台的搜索下拉都要读候选值，匿名内部页面级也要能读）
 *   - 增删改 + 「从现有数据整理」需 admin
 *
 * 【为什么联想接口不在这里】联想属于「检索行为」，统一放在 /search 模块下
 * （见 SearchController）；本控制器只管字典内容本身。职责一条线：这里是仓库，那里是检索。
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { DictionaryService } from './dictionary.service';
import type { ApiDictionaryEntry, CreateDictionaryDto, DictionarySyncReport, UpdateDictionaryDto } from './dictionary.service';

@Controller('dictionary')
export class DictionaryController {
  constructor(private readonly dictionary: DictionaryService) {}

  /** 字典内容：?kind= 可选，不传即全部 */
  @Get()
  list(@Query('kind') kind?: string): Promise<ApiDictionaryEntry[]> {
    return this.dictionary.list(kind);
  }

  /**
   * 把现有照片数据整理进字典（幂等，可反复执行）。
   * 【为什么是 POST 而不是 GET】它会写库，必须走审计拦截器留痕，也让「谁整理的」有据可查。
   */
  @Post('sync')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  sync(): Promise<DictionarySyncReport[]> {
    return this.dictionary.sync();
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  create(@Body() dto: CreateDictionaryDto): Promise<ApiDictionaryEntry> {
    return this.dictionary.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(@Param('id') id: string, @Body() dto: UpdateDictionaryDto): Promise<ApiDictionaryEntry> {
    return this.dictionary.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async remove(@Param('id') id: string): Promise<{ removed: number }> {
    await this.dictionary.remove(id);
    return { removed: 1 };
  }
}