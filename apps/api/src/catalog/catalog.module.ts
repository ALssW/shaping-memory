/**
 * apps/api/src/catalog/catalog.module.ts
 *
 * 分类 + 相册 + 相册分组（M2 分类相册动态化）。
 * 相册详情复用 PhotosService，故 import PhotosModule；
 * 相册新建 / 改分组要读写「默认分组」，故 AlbumsService 依赖 AlbumGroupsService。
 */
import { Module } from '@nestjs/common';
import { PhotosModule } from '../photos/photos.module';
import { AlbumGroupsController } from './album-groups.controller';
import { AlbumGroupsService } from './album-groups.service';
import { AlbumsController } from './albums.controller';
import { AlbumsService } from './albums.service';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

@Module({
  imports: [PhotosModule],
  controllers: [CategoriesController, AlbumsController, AlbumGroupsController],
  providers: [CategoriesService, AlbumsService, AlbumGroupsService],
})
export class CatalogModule {}
