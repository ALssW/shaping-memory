/**
 * apps/api/src/import/pipeline.ts
 *
 * 照片导入管线：扫描源目录 → exiftool 抽取 → Sharp 缩略图 → 幂等入库。
 * 独立于 NestJS 运行（import-cli 直接调用），便于脚本化与再执行。
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb, exifMetadata, media } from '@shaping-memory/db';
import type { Db, MediaInsert } from '@shaping-memory/db';
import { extractEmbeddedVideo, extractExifDirectory, extractFullDirectory } from '@shaping-memory/exif';
import type { ExifData, ExifFull } from '@shaping-memory/exif';
import {
  generateThumbnail,
  CARD_MAX,
  THUMB_DIR_NAME,
  cardPathForThumb,
  thumbPathFor,
} from '@shaping-memory/image';
import { liveVideoPathFor } from '@shaping-memory/storage';
import type { ObjectStore } from '@shaping-memory/storage';
import type { AppConfig } from '@shaping-memory/config';

import { uploadPhotoObjects } from '../photo-objects';
import type { ObjectSyncResult, PhotoObjectSource } from '../photo-objects';
import { cleanupUploadedAssets } from '../local-assets';
import { createConfiguredStore, remoteStoreOf } from '../storage-config';
import { inferCategory, inferFormat, inferOrientation, inferTitle, mediaIdOf, parseTakenAt } from './infer';

export interface ImportReport {
  total: number;
  imported: number;
  failed: number;
  errors: string[];
  /** 成功推到对象存储的对象数（本机模式恒为 0）：原片 + 生成物逐项计数 */
  uploaded: number;
  /** 上传失败的对象数 —— 照片本身已导入，只是少了一份云端副本 */
  uploadFailed: number;
  /** 上传失败的明细，与 errors 分开，避免把「未上云」与「未导入」混为一谈 */
  uploadErrors: string[];
}

/** importOne 的可选入参：源目录 / 回退分类 / 远端存储 / 全量 EXIF */
export interface ImportOneOptions {
  /** 源目录，缺省用 PHOTO_SOURCE_DIR */
  sourceDir?: string;
  /** 回退分类，缺省走 inferCategory() */
  category?: string;
  /** 远端对象存储；null / 缺省 = 本机模式，一个远端请求都不发 */
  store?: ObjectStore | null;
  /** 该文件的**全量** EXIF（-n 原始口径）；有值时写进 exif_metadata.extra 作为事实源 */
  fields?: ExifFull;
  /**
   * 上传时的原始文件名（含扩展名）。给了它就同时做两件事：
   *   1) 落进 media.original_name / original_size，供「同名文件」比对；
   *   2) 标题改由它推断 —— 落盘名带随机前缀，拿它当标题会得到一串 upload-3f2a1b- 般的编号。
   * 批量导入（没有上传动作）不传，这两列保持原值不动。
   */
  originalName?: string;
  /** 上传时的原始字节数，与 originalName 成对写入 */
  originalSize?: number;
  /**
   * 覆盖上传（同一个落盘名重传），语义是「只换文件、不动人工维护过的元数据」：
   *   1) 缩略图 / 实况视频这些按 id 命名的衍生品已存在，幂等检查会跳过 —— 需先删除以触发重新生成；
   *   2) 标题 / 分类 / 点赞是用户在后台编辑过的，替换文件不应将其覆盖回文件名推断值，也不应把点赞清零。
   */
  regenerate?: boolean;
}

/** 本机模式的返回值：什么都没上云 */
const NOTHING_UPLOADED: ObjectSyncResult = { uploaded: 0, failed: 0, errors: [] };

const isImage = (name: string): boolean => /\.(jpe?g|png)$/i.test(name);

/** 有并发上限的 map：串行时 limit=1，保留并发参数便于后续把 Sharp 缩略图这一步放开 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const current = next;
      next += 1;
      await fn(items[current]!);
    }
  });
  await Promise.all(workers);
}

/**
 * 实况照片：把照片尾部内嵌的 MP4 提到 STORAGE_DIR/live/ 下（幂等，已存在即复用）。
 * 提取失败不算导入失败 —— 照片本身仍然可用，只是没有「实况」效果。
 */
async function ensureLiveVideo(config: AppConfig, id: string, sourcePath: string): Promise<string | null> {
  const target = liveVideoPathFor(config.STORAGE_DIR, id);
  if (existsSync(target)) return target;
  const ok = await extractEmbeddedVideo(config.TOOLS_DIR, sourcePath, target);
  return ok ? target : null;
}

/**
 * 单张入库：生成两档缩略图 + 幂等 upsert，随后按需把资产推到对象存储。
 * 导入与上传接口复用这一份，避免重复管线。
 * category 缺省走 inferCategory()（批量导入没有分类信号）；上传接口会把站点设置里的
 * 回退分类传入，使「后台修改默认分类」真正生效。
 *
 * 返回本张的上传结果（本机模式恒为空），由调用方汇总进报告。
 */
export async function importOne(
  config: AppConfig,
  db: Db,
  name: string,
  exif: ExifData,
  options: ImportOneOptions = {},
): Promise<ObjectSyncResult> {
  const sourceDir = options.sourceDir ?? config.PHOTO_SOURCE_DIR;
  const category = options.category ?? inferCategory();
  const sourcePath = path.join(sourceDir, name);
  const id = mediaIdOf(name);

  // 分级缩略图幂等：详情档 + 卡片档都生成，任一缺失即补（真发生损坏可手动删 cache 重跑）
  const thumbPath = thumbPathFor(sourcePath, config.STORAGE_DIR);
  const cardPath = cardPathForThumb(thumbPath);
  /* 覆盖上传：衍生品都按 id 命名，旧文件存在即永远判定为「已存在」—— 先清除，使下方幂等检查重新生成，
     否则替换原图后，缩略图与实况视频仍为上一张。 */
  if (options.regenerate) {
    await rm(thumbPath, { force: true });
    await rm(cardPath, { force: true });
    await rm(liveVideoPathFor(config.STORAGE_DIR, id), { force: true });
  }
  if (!existsSync(thumbPath)) {
    await generateThumbnail(sourcePath, thumbPath);
  }
  if (!existsSync(cardPath)) {
    await generateThumbnail(sourcePath, cardPath, CARD_MAX);
  }
  // 实况照片才提取内嵌视频（非实况照片连 spawn 都不必发生）
  const liveVideoPath = exif.motionPhoto ? await ensureLiveVideo(config, id, sourcePath) : null;

  const capture = parseTakenAt(exif.takenAt);
  const mediaRow: MediaInsert = {
    id,
    /* 有原始文件名就用它推断标题：落盘名带随机前缀（upload-3f2a1b-…），
       直接拿来当标题，前台看到的就是一串编号。 */
    title: inferTitle(options.originalName ?? name),
    category,
    format: inferFormat(exif.fileType),
    captureAt: capture.captureAt,
    takenAt: capture.takenAt,
    width: exif.width || null,
    height: exif.height || null,
    orientation: inferOrientation(exif.width, exif.height),
    sourcePath,
    thumbPath,
    liveVideoPath,
    likes: 0,
    /* 没传 originalName 时**整个键都不出现**：upsert 的 set 只覆盖出现过的键，
       批量导入重复跑不该把已经记下来的原文件名与大小抹成 NULL。 */
    ...(options.originalName === undefined
      ? {}
      : { originalName: options.originalName, originalSize: options.originalSize ?? null }),
  };
  const exifRow = {
    mediaId: id,
    cam: exif.cam || null,
    lens: exif.lens || null,
    focal: exif.focal || null,
    aperture: exif.aperture || null,
    iso: exif.iso,
    speed: exif.speed || null,
    temp: exif.temp || null,
    wb: exif.wb || null,
  };

  // 幂等 upsert：主键冲突时更新，避免重复导入产生重复行；set 需剔除主键
  const { id: _mid, ...mediaRowUpdate } = mediaRow;
  const mediaUpdate: Partial<typeof mediaRowUpdate> = { ...mediaRowUpdate };
  /* 覆盖上传只换文件：标题 / 分类 / 点赞是人工维护过的，保留原值 ——
     否则「原地替换」会把后台编辑好的标题覆盖为文件名推断值，并把点赞数清零。 */
  if (options.regenerate) {
    delete mediaUpdate.title;
    delete mediaUpdate.category;
    delete mediaUpdate.likes;
  }
  await db.insert(media).values(mediaRow).onConflictDoUpdate({ target: media.id, set: mediaUpdate });

  const { mediaId: _pk, ...exifUpdate } = exifRow;
  await db
    .insert(exifMetadata)
    .values(exifRow)
    .onConflictDoUpdate({ target: exifMetadata.mediaId, set: exifUpdate });

  // 全量 EXIF 只在 extra 为空时落库：重复导入不该把用户在后台改过的 EXIF 冲掉。
  // 「DB 是唯一事实源」要求这份 extra 必须有值，否则旧照片切换云端后全量 EXIF 将丢失。
  if (options.fields && Object.keys(options.fields).length > 0) {
    await db
      .update(exifMetadata)
      .set({ extra: options.fields })
      .where(and(eq(exifMetadata.mediaId, id), isNull(exifMetadata.extra)));
  }

  return uploadToStore(config, { id, sourcePath, thumbPath, liveVideoPath }, options);
}

/**
 * 双写：本地已落盘之后，再往对象存储放一份原片 + 实况视频副本。
 *
 * 【隐私照片也上云】桶保持私有、且照片地址永不出 URL（API 全代理），因此隐私性由
 * 代理层承担，不再在这一步做「非 visible 就不上传」的判定 —— 隐私照片同样需要云副本。
 * 【本机模式无远端开销】store 为 null 时直接返回，不发送任何远端请求。
 * 【先上云、再清本机】只有确认全部 put 成功（failed=0 且 uploaded>0）才回收本机副本，
 * 且只清原片暂存与 live，衍生品（thumbs/blur）一律保留（见 local-assets.ts）。
 */
async function uploadToStore(
  config: AppConfig,
  row: PhotoObjectSource,
  options: ImportOneOptions,
): Promise<ObjectSyncResult> {
  if (!options.store) return NOTHING_UPLOADED;
  const sync = await uploadPhotoObjects(options.store, row);
  if (sync.failed === 0 && sync.uploaded > 0) {
    await cleanupUploadedAssets(config, row);
  }
  return sync;
}

export async function importPhotos(config: AppConfig): Promise<ImportReport> {
  const db = createDb(config.DATABASE_URL);
  // 生成物目录先建好：Sharp 写图不会自动创建父目录
  await mkdir(path.join(config.STORAGE_DIR, THUMB_DIR_NAME), { recursive: true });

  const names = (await readdir(config.PHOTO_SOURCE_DIR)).filter(isImage);
  // 一次性抽取全目录 EXIF（避免逐张 spawn 触发启动器竞态）：
  // 展示口径（extractExifDirectory）与全量原始口径（extractFullDirectory）各扫一次，
  // 后者落进 exif_metadata.extra，让数据库成为 EXIF 的唯一事实源。
  const exifMap = await extractExifDirectory(config.TOOLS_DIR, config.PHOTO_SOURCE_DIR);
  const fullMap = await extractFullDirectory(config.TOOLS_DIR, config.PHOTO_SOURCE_DIR);

  // 本机模式下 store 为 null（见 storage-config.ts）：整轮导入一个远端请求都不发
  const store = remoteStoreOf(config, createConfiguredStore(config));

  const report: ImportReport = {
    total: names.length,
    imported: 0,
    failed: 0,
    errors: [],
    uploaded: 0,
    uploadFailed: 0,
    uploadErrors: [],
  };

  // 缩略图 + 入库可以并发（Sharp 是 node 库，不 spawn）；exiftool 已在上一步一次性完成
  await mapWithConcurrency(names, 4, async (name) => {
    try {
      const exif = exifMap.get(name);
      if (!exif) throw new Error('未抽取到 EXIF');
      const sync = await importOne(config, db, name, exif, {
        store,
        fields: fullMap.get(name),
      });
      report.imported += 1;
      // 上传失败不算导入失败：照片已经在本地了，只是少一份云端副本
      report.uploaded += sync.uploaded;
      report.uploadFailed += sync.failed;
      report.uploadErrors.push(...sync.errors.map((detail) => `${name}: ${detail}`));
    } catch (err) {
      report.failed += 1;
      report.errors.push(`${name}: ${(err as Error).message}`);
    }
  });

  return report;
}