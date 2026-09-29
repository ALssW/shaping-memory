/**
 * apps/api/src/photos/photos.module.ts
 */
import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { PhotosController } from './photos.controller';
import { PhotosService } from './photos.service';
import { UploadController } from './upload.controller';
import { ChunkUploadController } from './chunk-upload.controller';

@Module({
  // 上传接口的「体积上限 / 扩展名白名单 / 回退分类」来自站点设置
  imports: [SettingsModule],
  controllers: [PhotosController, UploadController, ChunkUploadController],
  providers: [PhotosService],
  // 导出给 CatalogModule 复用（相册详情要按 id 批量取照片）
  exports: [PhotosService],
})
export class PhotosModule {}