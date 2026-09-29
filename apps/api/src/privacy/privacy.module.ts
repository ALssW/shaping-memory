/**
 * apps/api/src/privacy/privacy.module.ts
 *
 * 隐私与授权模块。只单向依赖 PhotosModule（分享链接要按 id 批量取照片），
 * 反向不依赖 —— 照片读接口所需的隐私判定走 privacy/policy.ts 的纯函数，不经这个模块，
 * 因此不存在模块循环。
 */
import { Module } from '@nestjs/common';
import { PhotosModule } from '../photos/photos.module';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';

@Module({
  imports: [PhotosModule],
  controllers: [PrivacyController],
  providers: [PrivacyService],
  exports: [PrivacyService],
})
export class PrivacyModule {}