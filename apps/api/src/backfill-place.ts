/**
 * apps/api/src/backfill-place.ts
 *
 * 一次性回填（两个阶段）：
 *   1. GPS 落列：把 exif_metadata.extra 里的定位原文补进 gps_lat / gps_lon / gps_alt
 *      （仅填空缺，不覆盖已有值）—— 早期数据的 GPS 只存在于 EXIF 原文里，
 *      而逆地理与地图读的都是 gps 列，不先落列就没有坐标可反解。
 *   2. 逆地理：把定位反解成「省 · 市」地名写进 place，并落结构化的 province / city
 *      两列（搜索面板的地点筛选读它们）。
 * 用法：`npm run backfill:place -w @shaping-memory/api`
 *
 * 【之后还需要再跑吗】不需要。新照片与「改定位」都由写入链路自己维护
 * （见 PhotosService.syncFromExtra → placeOf），本脚本只为补历史数据而存在。
 * 重复执行也是安全的：GPS 只填空缺；反解按坐标桶归并后逐个进行，同一机位只问一次高德。
 */
import './env';
import { eq } from 'drizzle-orm';
import { loadConfig } from '@shaping-memory/config';
import { createDb, exifMetadata } from '@shaping-memory/db';
import type { ExifFull } from '@shaping-memory/exif';
import { reverseGeocode } from './geo/regeo';
import { displayPatchOf } from './photos/exif-sync';

/** 与 regeo 的缓存桶精度一致（4 位小数约 11 米）：归并口径不同会让缓存白建 */
const BUCKET_DIGITS = 4;

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);

  const rows = await db
    .select({
      mediaId: exifMetadata.mediaId,
      lat: exifMetadata.gpsLat,
      lon: exifMetadata.gpsLon,
      alt: exifMetadata.gpsAlt,
      extra: exifMetadata.extra,
    })
    .from(exifMetadata);

  /* 先按坐标桶归并：一处机位往往躺着几十张照片，逐张反解是白花配额。
     归并后每个机位只发一次请求，结果一次写给桶里的所有照片。 */
  const buckets = new Map<string, { lat: number; lon: number; ids: string[] }>();
  let lifted = 0;
  for (const row of rows) {
    let { lat, lon } = row;

    // 阶段 1：GPS 列为空时从 EXIF 原文补（解析口径与写入链路共用 displayPatchOf，不另写一份）
    if (lat == null && lon == null) {
      const patch = displayPatchOf((row.extra ?? {}) as ExifFull);
      if (patch.gpsLat != null && patch.gpsLon != null) {
        await db
          .update(exifMetadata)
          .set({ gpsLat: patch.gpsLat, gpsLon: patch.gpsLon, gpsAlt: patch.gpsAlt })
          .where(eq(exifMetadata.mediaId, row.mediaId));
        lat = patch.gpsLat;
        lon = patch.gpsLon;
        lifted += 1;
      }
    }

    if (lat == null || lon == null) continue;
    const key = `${lat.toFixed(BUCKET_DIGITS)},${lon.toFixed(BUCKET_DIGITS)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.ids.push(row.mediaId);
    else buckets.set(key, { lat, lon, ids: [row.mediaId] });
  }

  // eslint-disable-next-line no-console
  console.log(`[place] 阶段 1 完成：GPS 落列 ${lifted} 张；归并为 ${buckets.size} 个机位`);

  let resolved = 0;
  let unresolved = 0;
  for (const bucket of buckets.values()) {
    const place = await reverseGeocode(config.AMAP_KEY, bucket.lat, bucket.lon);
    if (place === null) {
      unresolved += bucket.ids.length;
      continue;
    }
    for (const id of bucket.ids) {
      await db
        .update(exifMetadata)
        .set({ place: place.label, province: place.province, city: place.city })
        .where(eq(exifMetadata.mediaId, id));
    }
    resolved += bucket.ids.length;
    // eslint-disable-next-line no-console
    console.log(`[place] ${place.label} ← ${bucket.ids.length} 张`);
  }

  // eslint-disable-next-line no-console
  console.log(`[place] 完成：写入 ${resolved} 张，未解出 ${unresolved} 张`);
}

void main();