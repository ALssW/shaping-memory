/**
 * apps/api/src/backfill-objects.ts
 *
 * 一次性回填：把已有照片的原片（+ 实况视频）推到对象存储，并一并补齐 exif_metadata.extra。
 * 用法：`npm run backfill:objects -w @shaping-memory/api`
 *
 * 【什么时候必须跑】从本机存储切到云端（STORAGE_PROVIDER=s3）之前必须跑一次：
 * 切换后原片/实况不再读本机文件，未上过云端的旧照片会直接返回 404。
 *
 * 【为什么隐私照片也要推】混合存储决策已明确：隐私照片同样上云（桶私有、API 全代理），
 * 因此这里不过滤 privacy，只要 media.deleted=false 就处理。
 *
 * 【为什么本机原片不上传删除】批量导入的原片来自 PHOTO_SOURCE_DIR，那是用户的档案本身，
 * 一个字节都不碰；cleanupUploadedAssets 只会回收 STORAGE_DIR 内的 uploads/ 暂存副本与 live。
 *
 * 【重复执行安全】对象 put 是覆盖写，extra 只在为空时补，已上云的照片再次执行只是重复上传一遍。
 */
import './env';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { loadConfig } from '@shaping-memory/config';
import { createDb, exifMetadata, media } from '@shaping-memory/db';
import { readExifFull } from '@shaping-memory/exif';
import { uploadPhotoObjects } from './photo-objects';
import { cleanupUploadedAssets } from './local-assets';
import { createConfiguredStore } from './storage-config';

async function main(): Promise<void> {
  const config = loadConfig();
  // 本机模式没有任何云端对象要补齐：直接说明并退出，避免被误判为「已执行但无效果」
  if (config.STORAGE_PROVIDER !== 's3') {
    // eslint-disable-next-line no-console
    console.log(
      `[backfill] 当前 STORAGE_PROVIDER=${config.STORAGE_PROVIDER}，本机模式无需回填；` +
        '请把 STORAGE_PROVIDER 设为 s3 后再运行。',
    );
    return;
  }

  const db = createDb(config.DATABASE_URL);
  const store = createConfiguredStore(config);

  // 只处理未软删除的照片（含隐私照片）：软删除的行保留在库里，但没有回填的必要
  const rows = await db
    .select({
      id: media.id,
      sourcePath: media.sourcePath,
      thumbPath: media.thumbPath,
      liveVideoPath: media.liveVideoPath,
    })
    .from(media)
    .where(eq(media.deleted, false));

  // eslint-disable-next-line no-console
  console.log(`[backfill] 待处理 ${rows.length} 张（含隐私照片），存储：${config.STORAGE_BUCKET}`);

  let objectsUploaded = 0;
  let photosUploaded = 0;
  let extraFilled = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of rows) {
    // 原片是本机唯一的字节来源：文件不在就无从上传，也无从抽取 EXIF
    if (!existsSync(row.sourcePath)) {
      failed += 1;
      errors.push(`${row.id}: 原片不在本机（${row.sourcePath}）`);
      continue;
    }

    // ① 一并回填全量 EXIF：extra 为空才写，避免把后台已编辑过的结果冲掉（与导入管线同一口径）
    const meta = await db
      .select({ extra: exifMetadata.extra })
      .from(exifMetadata)
      .where(eq(exifMetadata.mediaId, row.id));
    const extra = meta[0]?.extra;
    if (extra == null || Object.keys(extra).length === 0) {
      try {
        const fields = await readExifFull(config.TOOLS_DIR, row.sourcePath);
        if (Object.keys(fields).length > 0) {
          await db.update(exifMetadata).set({ extra: fields }).where(eq(exifMetadata.mediaId, row.id));
          extraFilled += 1;
        }
      } catch (err) {
        // 抽 EXIF 失败不影响上云，只记一行明细。
        // 【只打 stderr】err.message 是 Node 拼的 "Command failed: exiftool.exe -j -s ... <一整条命令>"，
        // 真正的失败原因（exiftool 输出的错误信息）只在 stderr 里；缺少该信息将无法排查。
        const stderr = (err as { stderr?: string }).stderr?.trim().split('\n')[0];
        errors.push(`${row.id}: 回填 EXIF 失败 —— ${stderr || (err as Error).message}`);
      }
    }

    // ② 推原片 + 实况视频（uploadPhotoObjects 只认这两类，衍生品恒本机）
    const sync = await uploadPhotoObjects(store, row);
    objectsUploaded += sync.uploaded;
    errors.push(...sync.errors.map((detail) => `${row.id}: ${detail}`));

    if (sync.failed > 0) {
      failed += 1;
      continue;
    }
    photosUploaded += 1;
    // ③ 确认全部 put 成功后才回收本机副本（只清 uploads/ 暂存与 live，衍生品保留）
    if (sync.uploaded > 0) await cleanupUploadedAssets(config, row);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[backfill] 完成：共 ${rows.length} 张，已上云 ${photosUploaded} 张（${objectsUploaded} 个对象），` +
      `回填 EXIF ${extraFilled} 张，失败 ${failed} 张`,
  );
  for (const detail of errors) {
    // eslint-disable-next-line no-console
    console.error(`  - ${detail}`);
  }
}

void main();