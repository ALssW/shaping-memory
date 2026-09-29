/**
 * apps/api/src/tags/tags.module.ts
 *
 * 标签目录（只读）。Db 由 @Global 的 InfraModule 提供，这里无需 import 任何业务模块。
 */
import { Module } from '@nestjs/common';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';

@Module({
  controllers: [TagsController],
  providers: [TagsService],
})
export class TagsModule {}