/**
 * apps/api/src/catalog/categories.controller.ts
 *
 * 分类接口：GET 公开（前台筛选条要拉），增删改需 admin。
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { CategoriesService } from './categories.service';
import type { ApiCategory, CreateCategoryDto, UpdateCategoryDto } from './categories.service';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  list(): Promise<ApiCategory[]> {
    return this.categories.list();
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  create(@Body() dto: CreateCategoryDto): Promise<ApiCategory> {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto): Promise<ApiCategory> {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async remove(@Param('id') id: string): Promise<{ removed: number }> {
    await this.categories.remove(id);
    return { removed: 1 };
  }
}
