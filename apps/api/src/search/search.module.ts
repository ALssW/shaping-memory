/**
 * apps/api/src/search/search.module.ts
 *
 * 专用检索模块：照片检索复用 PhotosService 的 SQL（唯一实现），
 * 字典联想复用 DictionaryService（唯一实现），本模块只负责「检索」这个入口的语义。
 */
import { Module } from '@nestjs/common';
import { DictionaryModule } from '../dictionary/dictionary.module';
import { PhotosModule } from '../photos/photos.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [PhotosModule, DictionaryModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}