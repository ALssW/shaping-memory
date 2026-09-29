/**
 * apps/api/src/backfill-place.ts
 *
 * 一次性回填：把已有照片的定位反解成可读地名，写进 exif_metadata.place。
 * 用法：`npm run backfill:place -w @shaping-memory/api`
 *
 * 【之后还需要再跑吗】不需要。新照片与「改定位」都由写入链路自己维护
 * （见 PhotosService.syncFromExtra → placeOf），本脚本只为补历史数据而存在。
 * 重复执行也是安全的：按坐标桶归并后逐个反解，同一机位的几十张照片只问一次高德。
 */
import './env';
import { and, eq, isNotNull } from 'drizzle-orm';
import { loadConfig } from '@shaping-memory/config';
import { createDb, exifMetadata } from '@shaping-memory/db';
import { reverseGeocode } from './geo/regeo';

/** 与 regeo 的缓存桶精度一致（4 位小数约 11 米）：归并口径不同会让缓存白建 */
const BUCKET_DIGITS = 4;

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);

  const rows = await db
    .select({ mediaId: exifMetadata.mediaId, lat: exifMetadata.gpsLat, lon: exifMetadata.gpsLon })
    .from(exifMetadata)
    .where(and(isNotNull(exifMetadata.gpsLat), isNotNull(exifMetadata.gpsLon)));

  /* 先按坐标桶归并：一处机位往往躺着几十张照片，逐张反解是白花配额。
     归并后每个机位只发一次请求，结果一次写给桶里的所有照片。 */
  const buckets = new Map<string, { lat: number; lon: number; ids: string[] }>();
  for (const row of rows) {
    if (row.lat == null || row.lon == null) continue;
    const key = `${row.lat.toFixed(BUCKET_DIGITS)},${row.lon.toFixed(BUCKET_DIGITS)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.ids.push(row.mediaId);
    else buckets.set(key, { lat: row.lat, lon: row.lon, ids: [row.mediaId] });
  }

  // eslint-disable-next-line no-console
  console.log(`[place] 有定位的照片 ${rows.length} 张，归并为 ${buckets.size} 个机位`);

  let resolved = 0;
  let unresolved = 0;
  for (const bucket of buckets.values()) {
    const place = await reverseGeocode(config.AMAP_KEY, bucket.lat, bucket.lon);
    if (place === null) {
      unresolved += bucket.ids.length;
      continue;
    }
    for (const id of bucket.ids) {
      await db.update(exifMetadata).set({ place }).where(eq(exifMetadata.mediaId, id));
    }
    resolved += bucket.ids.length;
    // eslint-disable-next-line no-console
    console.log(`[place] ${place} ← ${bucket.ids.length} 张`);
  }

  // eslint-disable-next-line no-console
  console.log(`[place] 完成：写入 ${resolved} 张，未解出 ${unresolved} 张`);
}

void main();