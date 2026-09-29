/**
 * apps/api/src/photos/chunk-upload.controller.ts
 *
 * 分片上传（后台「文件夹上传」专用）：一个大文件切成若干片分别送，断网 / 关页面后
 * 只补传缺失的分片，无需从头重传。
 *
 * 【为什么临时分片直接放磁盘，而不是建表】分片活在「传完即合并、合并完即删」这段极短的
 * 生命周期里，没有查询与事务需求；一个 uploadId 一个目录，「已收到哪几片」用 readdir 就能回答。
 * 少一张表、少一次迁移，也少一处可能与磁盘不一致的状态。
 *
 * 【uploadId 是算出来的，不是发出来的】sha1(原始名 | 大小 | 修改时间)。客户端刷新页面后
 * 拿同样三个值重新 init，必然算出同一个 id，于是自动接上上次传了一半的分片 ——
 * 服务端因此不需要记住「谁在传什么」。
 *
 * 【合并后与整包上传走同一条管线】仍然调用 importOne：EXIF 抽取、缩略图、对象存储、
 * 幂等 upsert 的行为与单文件上传完全一致，两个入口不会出现两套行为。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

/** 分片临时目录：挂在 uploads 下并以点开头，避免被当作「待导入的照片」扫描进去 */
const UPLOAD_DIR_NAME = 'uploads';
const CHUNK_DIR_NAME = '.chunks';
const MANIFEST_NAME = 'manifest.json';
const PART_SUFFIX = '.part';
/** 分片数上限：按默认 8MB 一片算约 160GB，足够大，同时可拦截异常填写的 totalChunks */
const MAX_CHUNKS = 20000;
/** uploadId 的形状（'u' + sha1 前 24 位）：用于防御路径穿越，避免入参拼接出 ../ */
const UPLOAD_ID_RE = /^u[0-9a-f]{24}$/;

type UploadLimits = Awaited<ReturnType<SettingsService['uploadLimits']>>;

/** FileInterceptor 落进内存后的分片形态 */
interface UploadedChunk {
  buffer: Buffer;
}

/** 一次分片上传的清单（落在分片目录里），服务端因此不必为「谁在传什么」另建状态 */
interface ChunkManifest {
  name: string;
  size: number;
  lastModified: number;
  chunkBytes: number;
  totalChunks: number;
}

/** 客户端报的文件身份：这三个值共同决定 uploadId */
interface FileIdentity {
  name?: unknown;
  size?: unknown;
  lastModified?: unknown;
}

/** 续传入口的返回：分片口径 + 已收到哪些片，客户端据此只补缺失的那些 */
export interface InitChunkUploadResult {
  uploadId: string;
  chunkBytes: number;
  concurrency: number;
  received: number[];
}

/** 文件身份 → uploadId：同三个值必得同一个 id，刷新页面后因此能自动接上未完成的分片 */
function uploadIdOf(name: string, size: number, lastModified: number): string {
  return 'u' + createHash('sha1').update(`${name}|${size}|${lastModified}`).digest('hex').slice(0, 24);
}

/** 第 index 片应有的字节数：最后一片是「剩下的那一截」，其余都是完整片 */
function chunkLengthOf(manifest: ChunkManifest, index: number): number {
  return index === manifest.totalChunks - 1
    ? manifest.size - manifest.chunkBytes * (manifest.totalChunks - 1)
    : manifest.chunkBytes;
}

/**
 * 把分片按序拼成一个文件。
 * 【为什么逐片读】一次 readFile 整个文件会把几 GB 堆进内存；单片默认 8MB，读一片写一片，
 * 内存占用因此与文件大小无关。write 返回 false 表示内核缓冲已满，等 drain 再继续。
 */
async function mergeChunks(parts: readonly string[], dest: string): Promise<void> {
  const out = createWriteStream(dest);
  // 先把监听挂上：events.once 在流报 'error' 时会让这个 promise reject，因此不必另写 try/catch 收尾
  const finished = once(out, 'finish');
  for (const part of parts) {
    const buffer = await readFile(part);
    if (!out.write(buffer)) await once(out, 'drain');
  }
  out.end();
  await finished;
}

@Controller('photos/upload')
export class ChunkUploadController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    private readonly photos: PhotosService,
    private readonly settings: SettingsService,
  ) {}

  /** 开一次分片上传（同时也是续传入口）：返回分片口径与「已经收到哪些片」 */
  @Post('init')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  async init(@Body() body: FileIdentity): Promise<InitChunkUploadResult> {
    const limits = await this.settings.uploadLimits();
    const { uploadId, manifest } = this.identityOf(body, limits);
    const dir = this.chunkDir(uploadId);
    const existing = await this.readManifest(dir);
    /* 分片大小被后台改过时，磁盘上那些片是按旧口径切的，拼起来必然错位 —— 只能作废重来 */
    if (existing && existing.chunkBytes !== manifest.chunkBytes) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
    }
    await mkdir(dir, { recursive: true });
    await writeFile(this.manifestPath(dir), JSON.stringify(manifest));
    return {
      uploadId,
      chunkBytes: manifest.chunkBytes,
      concurrency: limits.concurrency,
      received: await this.receivedOf(dir, manifest),
    };
  }

  /** 收一片 */
  @Put(':uploadId/chunks/:index')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  @UseInterceptors(FileInterceptor('chunk', { limits: { fileSize: UPLOAD_CEILING_MB * 1024 * 1024 } }))
  async chunk(
    @Param('uploadId') uploadId: string,
    @Param('index') index: string,
    @UploadedFile() file: UploadedChunk | undefined,
  ): Promise<{ received: boolean }> {
    const dir = this.chunkDir(uploadId);
    const manifest = await this.requireManifest(dir);
    const position = this.positionOf(index, manifest);
    if (!file) throw new BadRequestException('缺少分片数据');
    /* 逐片校验长度：缺片、截断、多传都能在这里当场发现，
       比等到合并时才报「体积对不上」精确得多（客户端能直接重传这一片）。 */
    const expected = chunkLengthOf(manifest, position);
    if (file.buffer.length !== expected) {
      throw new BadRequestException(`第 ${position + 1} 片应为 ${expected} 字节，实收 ${file.buffer.length} 字节`);
    }
    await writeFile(path.join(dir, `${position}${PART_SUFFIX}`), file.buffer);
    return { received: true };
  }

  /** 合并 + 入库：与整包上传共用导入管线 */
  @Post(':uploadId/complete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  async complete(
    @Req() req: MaybeAuthedRequest,
    @Param('uploadId') uploadId: string,
    @Body() body: FileIdentity & { overwriteId?: unknown },
  ): Promise<PhotoUploadResult> {
    const limits = await this.settings.uploadLimits();
    const dir = this.chunkDir(uploadId);
    const manifest = await this.requireManifest(dir);
    this.assertMatches(manifest, body, uploadId);

    const parts = await this.requireAllChunks(dir, manifest);
    const uploadsDir = path.join(this.config.STORAGE_DIR, UPLOAD_DIR_NAME);
    await mkdir(uploadsDir, { recursive: true });

    /* 覆盖：沿用旧照片的落盘文件名 —— 落盘名就是 media.id 的来源，名字不动 id 就不动，
       相册归属 / 点赞数 / 分享链接这些引用因此全部保住。 */
    const overwriteId = typeof body.overwriteId === 'string' && body.overwriteId ? body.overwriteId : null;
    const name = overwriteId
      ? await this.nameForOverwrite(overwriteId)
      : persistName(manifest.name, path.extname(manifest.name).toLowerCase());
    const sourcePath = path.join(uploadsDir, name);

    await mergeChunks(parts, sourcePath);
    // 合并结果与声明的体积对不上 → 分片有缺失或截断，宁可报错让客户端重传，也不要入库一张坏图
    const merged = await stat(sourcePath);
    if (merged.size !== manifest.size) {
      await rm(sourcePath, { force: true });
      throw new BadRequestException('分片合并后的体积与源文件不符，请重新上传这个文件');
    }

    const exif = await this.readExif(sourcePath);
    const fields = await readExifFull(this.config.TOOLS_DIR, sourcePath);
    /* 保留返回的同步结果：该结果原本被丢弃，导致「本机存在、云端缺失」对用户完全不可见。
       现交由前端，使其在上传报告中明确提示哪些照片未上云。 */
    const upload = await importOne(this.config, this.db, name, exif, {
      sourceDir: uploadsDir,
      category: limits.defaultCategory,
      store: remoteStoreOf(this.config, this.store),
      fields,
      originalName: manifest.name,
      originalSize: manifest.size,
      // 覆盖时必须重生成缩略图与实况视频，否则画面仍为上一张
      regenerate: overwriteId != null,
    });
    // 分片已无用处，保留只会占用磁盘空间（下一轮同名上传会重新切片）
    await rm(dir, { recursive: true, force: true });

    const photo = await this.photos.get(mediaIdOf(name), await this.photos.pass(req));
    if (!photo) throw new NotFoundException('照片保存失败');
    return { photo, upload };
  }

  /** 放弃这次上传：清掉临时分片。「取消」与「放弃续传」都走这里 */
  @Delete(':uploadId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  async abort(@Param('uploadId') uploadId: string): Promise<{ removed: number }> {
    await rm(this.chunkDir(uploadId), { recursive: true, force: true });
    return { removed: 1 };
  }

  /* ------------------------------------------------------------------ 内部 */

  /** 入参 →（uploadId, 清单）：三个身份值缺一不可，体积与扩展名先按站点设置挡一道 */
  private identityOf(body: FileIdentity, limits: UploadLimits): { uploadId: string; manifest: ChunkManifest } {
    const { name, size, lastModified } = body;
    if (typeof name !== 'string' || !name) throw new BadRequestException('缺少文件名');
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
      throw new BadRequestException('文件体积不合法');
    }
    if (typeof lastModified !== 'number' || !Number.isFinite(lastModified)) {
      throw new BadRequestException('缺少文件的修改时间');
    }
    assertAllowed(name, size, limits);
    const totalChunks = Math.ceil(size / limits.chunkBytes);
    if (totalChunks > MAX_CHUNKS) throw new BadRequestException('文件过大，分片数超出上限');
    return {
      uploadId: uploadIdOf(name, size, lastModified),
      manifest: { name, size, lastModified, chunkBytes: limits.chunkBytes, totalChunks },
    };
  }

  private chunkDir(uploadId: string): string {
    if (!UPLOAD_ID_RE.test(uploadId)) throw new BadRequestException('上传标识不合法');
    return path.join(this.config.STORAGE_DIR, UPLOAD_DIR_NAME, CHUNK_DIR_NAME, uploadId);
  }

  private manifestPath(dir: string): string {
    return path.join(dir, MANIFEST_NAME);
  }

  /** 没有清单 = 这次上传从没开过（或已被合并清理），不是错误 */
  private async readManifest(dir: string): Promise<ChunkManifest | null> {
    try {
      return JSON.parse(await readFile(this.manifestPath(dir), 'utf8')) as ChunkManifest;
    } catch {
      return null;
    }
  }

  /** 缺清单说明这个 uploadId 从未 init 过（或已完成）—— 让客户端重新 init，而不是静默收片 */
  private async requireManifest(dir: string): Promise<ChunkManifest> {
    const manifest = await this.readManifest(dir);
    if (!manifest) throw new NotFoundException('这次上传不存在或已完成，请重新发起');
    return manifest;
  }

  /** 已收到的分片号：片文件存在**且长度正确**才算数（长度不对的是上次中断留下的半截） */
  private async receivedOf(dir: string, manifest: ChunkManifest): Promise<number[]> {
    const names = await readdir(dir).catch(() => [] as string[]);
    const entries = await Promise.all(
      names
        .filter((entry) => entry.endsWith(PART_SUFFIX))
        .map(async (entry) => [Number.parseInt(entry, 10), (await stat(path.join(dir, entry))).size] as const),
    );
    return entries
      .filter(
        ([index, bytes]) =>
          Number.isInteger(index) && index >= 0 && index < manifest.totalChunks && bytes === chunkLengthOf(manifest, index),
      )
      .map(([index]) => index)
      .sort((a, b) => a - b);
  }

  private positionOf(index: string, manifest: ChunkManifest): number {
    const position = Number.parseInt(index, 10);
    if (!Number.isInteger(position) || position < 0 || position >= manifest.totalChunks) {
      throw new BadRequestException('分片序号超出范围');
    }
    return position;
  }

  /** complete 重报的身份必须与 init 时一致 —— 不一致说明要拼的不是同一个文件 */
  private assertMatches(manifest: ChunkManifest, body: FileIdentity, uploadId: string): void {
    const same = body.name === manifest.name && body.size === manifest.size && body.lastModified === manifest.lastModified;
    if (!same || uploadIdOf(manifest.name, manifest.size, manifest.lastModified) !== uploadId) {
      throw new BadRequestException('文件信息与本次上传不符，请重新发起');
    }
  }

  /** 缺任何一片都直接告诉客户端缺哪一片，而不是强行拼接出一个残缺文件 */
  private async requireAllChunks(dir: string, manifest: ChunkManifest): Promise<string[]> {
    const received = new Set(await this.receivedOf(dir, manifest));
    const missing = Array.from({ length: manifest.totalChunks }, (_, index) => index).filter(
      (index) => !received.has(index),
    );
    if (missing.length > 0) {
      throw new BadRequestException(`还缺 ${missing.length} 个分片（如第 ${missing[0]! + 1} 片），请续传后再合并`);
    }
    return Array.from({ length: manifest.totalChunks }, (_, index) => path.join(dir, `${index}${PART_SUFFIX}`));
  }

  /** 覆盖目标的落盘文件名：它就是 media.id 的来源，沿用即可保住 id 与所有引用 */
  private async nameForOverwrite(id: string): Promise<string> {
    const row = await this.db.query.media.findFirst({ where: (table, { eq }) => eq(table.id, id) });
    if (!row) throw new NotFoundException('要覆盖的照片不存在');
    const name = path.basename(row.sourcePath);
    // 交叉验证：若 basename 与 id 不一致（历史数据），宁可报错也不写出 id 错位的文件
    if (mediaIdOf(name) !== id) throw new BadRequestException('这张照片的文件名与标识不匹配，无法覆盖');
    return name;
  }

  private async readExif(sourcePath: string): Promise<ExifData> {
    try {
      return await extractExif(this.config.TOOLS_DIR, sourcePath);
    } catch {
      await rm(sourcePath, { force: true });
      throw new BadRequestException('无法读取这张照片的拍摄信息，请确认它是有效的图片文件');
    }
  }
}