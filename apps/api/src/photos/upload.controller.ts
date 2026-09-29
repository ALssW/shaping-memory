/**
 * apps/api/src/photos/upload.controller.ts
 *
 * 照片上传（后台）：multipart 单文件 → 落盘到 STORAGE_DIR/uploads → 抽 EXIF → 复用导入管线入库。
 * 需 admin / editor。一期不做分片/断点/秒传（高效上传依赖 Worker 队列，属后续里程碑）。
 *
 * 体积上限与允许的扩展名来自站点设置（后台可改），分类回退同理。
 */
import {
  BadRequestException,
  Controller,
  Inject,
  NotFoundException,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { extractExif, readExifFull } from '@shaping-memory/exif';
import type { ExifData } from '@shaping-memory/exif';
import type { Db } from '@shaping-memory/db';
import type { ObjectStore } from '@shaping-memory/storage';
import type { AppConfig } from '@shaping-memory/config';
import { APP_CONFIG, DB, OBJECT_STORE } from '../infra.module';
import { remoteStoreOf } from '../storage-config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { MaybeAuthedRequest } from '../auth/optional-jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SettingsService } from '../settings/settings.service';
import { importOne } from '../import/pipeline';
import { mediaIdOf } from '../import/infer';
import { PhotosService } from './photos.service';
import { UPLOAD_CEILING_MB, assertAllowed, persistName } from './upload-common';
import type { PhotoUploadResult } from './upload-common';

/** FileInterceptor 落进内存后的文件形态（只声明本模块用到的字段，不依赖 @types/multer 的全局命名空间） */
interface UploadedImage {
  originalname: string;
  buffer: Buffer;
}

@Controller('photos')
export class UploadController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    private readonly photos: PhotosService,
    private readonly settings: SettingsService,
  ) {}

  @Post('upload')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_CEILING_MB * 1024 * 1024 } }))
  async upload(
    @UploadedFile() file: UploadedImage | undefined,
    @Req() req: MaybeAuthedRequest,
  ): Promise<PhotoUploadResult> {
    if (!file) throw new BadRequestException('请先选择要上传的照片');

    const limits = await this.settings.uploadLimits();
    assertAllowed(file.originalname, file.buffer.length, limits);

    // 上传目录独立于只读的 PHOTO_SOURCE_DIR：源目录是导入管线的只读来源，写进去会污染档案
    const uploadsDir = path.join(this.config.STORAGE_DIR, 'uploads');
    await mkdir(uploadsDir, { recursive: true });

    const name = persistName(file.originalname, path.extname(file.originalname).toLowerCase());
    const sourcePath = path.join(uploadsDir, name);
    await writeFile(sourcePath, file.buffer);

    let exif: ExifData;
    try {
      exif = await extractExif(this.config.TOOLS_DIR, sourcePath);
    } catch {
      throw new BadRequestException('无法读取这张照片的拍摄信息，请确认它是有效的图片文件');
    }
    // 全量原始 EXIF（-n 口径）单独读一次，落进 exif_metadata.extra —— 数据库是 EXIF 的唯一事实源
    const fields = await readExifFull(this.config.TOOLS_DIR, sourcePath);

    // 本机模式（store 为 null）下不碰对象存储，行为与只存本地时一致
    const store = remoteStoreOf(this.config, this.store);
    /* 保留返回的同步结果：该结果原本被丢弃，导致「本机存在、云端缺失」对用户完全不可见。
       现交由前端，使其明确提示哪些照片未上云。 */
    const upload = await importOne(this.config, this.db, name, exif, {
      sourceDir: uploadsDir,
      category: limits.defaultCategory,
      store,
      fields,
      /* 记录原始文件名与体积：后台的「同名文件」比对依赖它 —— 整包上传的照片
         若遗漏这一条，在文件夹上传中将被判定为「库中不存在」，导致重复上传。 */
      originalName: file.originalname,
      originalSize: file.buffer.length,
    });

    // 文件名 → id 是确定性映射（mediaIdOf），直接反查，不依赖标题/列表回退
    const id = mediaIdOf(name);
    const photo = await this.photos.get(id, await this.photos.pass(req));
    if (!photo) throw new NotFoundException('照片保存失败');

    return { photo, upload };
  }
}