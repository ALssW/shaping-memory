/**
 * apps/api/src/backfill-taken-at.ts
 *
 * 一次性回填：按中国标准时间（UTC+8）重新解析 EXIF 拍摄时间，覆盖 media.taken_at 与 capture_at。
 * 用法：`npm run backfill:taken-at -w @shaping-memory/api`
 *
 * 【为什么需要】早期解析未显式携带时区偏移，`new Date(...)` 会按服务器本地时区解读 ——
 * 服务器时区不同，存量的 taken_at 就会整体偏移。现在口径统一为「EXIF 时间即 UTC+8 墙钟时间」，
 * 存量数据需要按同一口径重写一遍。
 * 【为什么不读照片文件】EXIF 的时间原文（DateTimeOriginal / CreateDate）在导入时
 * 已整份保存在 exif_metadata.extra，重解析从库里取即可，慢且易错的文件 IO 全部省掉。
 * 【之后还需要再跑吗】不需要。新照片与「改拍摄时间」都由写入链路自己维护
 * （见 exif-sync 的 mediaDatePatchOf）。重复执行是安全的：解析结果幂等。
 */
import './env';
import { eq, isNotNull } from 'drizzle-orm';
import { loadConfig } from '@shaping-memory/config';
import { createDb, exifMetadata, media } from '@shaping-memory/db';
import { parseTakenAt } from './import/infer';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);

  const rows = await db
    .select({ mediaId: exifMetadata.mediaId, extra: exifMetadata.extra })
    .from(exifMetadata)
    .where(isNotNull(exifMetadata.extra));
  // eslint-disable-next-line no-console
  console.log(`[taken-at] 带 EXIF 原文的照片 ${rows.length} 张`);

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const raw = row.extra?.DateTimeOriginal ?? row.extra?.CreateDate ?? '';
    const { captureAt, takenAt } = parseTakenAt(raw);
    // 两张照片都没有解析出任何时间口径时不动原值，避免把仅有的日期抹掉
    if (captureAt == null && takenAt == null) {
      skipped += 1;
      continue;
    }
    await db.update(media).set({ captureAt, takenAt }).where(eq(media.id, row.mediaId));
    updated += 1;
    // eslint-disable-next-line no-console
    console.log(`[taken-at] ${row.mediaId} → ${takenAt?.toISOString() ?? '(仅日期)'} ${captureAt ?? ''}`);
  }

  // eslint-disable-next-line no-console
  console.log(`[taken-at] 完成：更新 ${updated} 张，无时间原文 ${skipped} 张`);
}

void main();
