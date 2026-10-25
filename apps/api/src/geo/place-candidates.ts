/**
 * apps/api/src/geo/place-candidates.ts
 *
 * 「补地名」的候选判定（全项目唯一口径）：有坐标（gps_lat / gps_lon 非空）且地名为空的照片。
 *
 * 【为什么单独成模块】批量补地名接口、异步队列写库、回填脚本三处都要回答同一个问题
 * 「这张照片的地名算不算还没获取」—— 各判各的必然出现口径分叉（排进队却补不上、
 * 补上了又被判成缺），因此判定与查询只在这里写一份，其余位置一律引用。
 */
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { exifMetadata } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import type { PlaceTask } from './place-queue';

/**
 * 「地名为空」判定：place 为 NULL 或空串都视为未获取（历史数据两种形态并存，
 * 只判 NULL 会把空串行永远漏在外面）。
 */
export function placeIsEmpty(): SQL {
  return or(isNull(exifMetadata.place), eq(exifMetadata.place, ''))!;
}

/**
 * 坐标已落列且地名为空的照片清单：批量补地名的入队候选。
 * 坐标缺失的照片不入选 —— 没有坐标就没有可反解的对象。
 */
export async function listPlaceBackfillTargets(db: Db): Promise<PlaceTask[]> {
  const rows = await db
    .select({ mediaId: exifMetadata.mediaId, lat: exifMetadata.gpsLat, lon: exifMetadata.gpsLon })
    .from(exifMetadata)
    .where(and(isNotNull(exifMetadata.gpsLat), isNotNull(exifMetadata.gpsLon), placeIsEmpty()));
  // isNotNull 只约束查询条件、不收窄返回类型：这里再收敛一次，保证出参坐标恒为数字
  return rows.flatMap((row) =>
    row.lat != null && row.lon != null ? [{ mediaId: row.mediaId, lat: row.lat, lon: row.lon }] : [],
  );
}
