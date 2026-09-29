/**
 * apps/api/src/dictionary/dictionary.module.ts
 *
 * 通用字典（机身 / 镜头 / 光圈 / 快门 / ISO …）。
 * SearchModule 要用它的 suggest 做联想，因此这里把服务导出。
 */
import { Module } from '@nestjs/common';
import { DictionaryController } from './dictionary.controller';
import { DictionaryService } from './dictionary.service';

@Module({
  controllers: [DictionaryController],
  providers: [DictionaryService],
  exports: [DictionaryService],
})
export class DictionaryModule {}