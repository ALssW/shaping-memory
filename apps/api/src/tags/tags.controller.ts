/**
 * apps/api/src/tags/tags.controller.ts
 *
 * 标签接口：只有 GET，且公开。
 * 与 /categories、/dictionary 同属「只读目录」——前台筛选器要拉候选，因此不加 guard。
 */
import { Controller, Get } from '@nestjs/common';
import { TagsService } from './tags.service';
import type { ApiTag } from './tags.service';

@Controller('tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  list(): Promise<ApiTag[]> {
    return this.tags.list();
  }
}