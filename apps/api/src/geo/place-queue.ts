/**
 * apps/api/src/geo/place-queue.ts
 *
 * 拍摄地名的异步反解队列：上传 / 导入只负责把坐标落库，地名交给这里的后台任务补。
 *
 * 【为什么异步】逆地理解析要走高德网络请求（单次上限 8 秒），放进上传请求会把
 * 「传完就走」拖成「传完还要等地图」；批量导入几百张时更会把总耗时放大数倍。
 * 【为什么串行】反解按坐标桶缓存（见 regeo.ts），同机位成组照片共用一次配额 ——
 * 并发跑只会让同桶请求撞车、缓存白白失效，串行反而更快更省配额。
 * 【失败怎么办】任务内异常一律吞掉（与 regeo 的「失败返回 null」同一口径）：
 * 地名只是展示增强，缺失不影响照片本身可用；漏补的可随时 `npm run backfill:place` 幂等补齐。
 * 【进程退出】API 进程重启会丢掉队列里未跑完的任务，属可接受损耗 —— 同上，补跑脚本兜底。
 */
import { and, eq } from 'drizzle-orm';
import { exifMetadata } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import type { AppConfig } from '@shaping-memory/config';

import { reverseGeocode } from './regeo';
import { placeIsEmpty } from './place-candidates';

/** 一个待补地名的任务：照片 id + 它的 WGS-84 坐标（批量补地名的候选集复用同一形状） */
export interface PlaceTask {
  mediaId: string;
  lat: number;
  lon: number;
}

/* 任务串成一条 Promise 链：前一个跑完才跑下一个。链尾恒为 resolved ——
   runTask 内部吞掉全部异常，链条不会 reject，某个任务失败不会堵死后续任务。 */
let queueChain: Promise<void> = Promise.resolve();

/**
 * 排入一个「补地名」任务并立即返回：调用方不等反解结果，上传 / 导入因此零额外网络耗时。
 * 坐标缺失的照片不排队 —— 没有坐标就没有可反解的对象。
 */
export function enqueuePlaceResolve(config: AppConfig, db: Db, task: PlaceTask): void {
  queueChain = queueChain.then(() => runTask(config, db, task));
}

/** 等队列跑干净（CLI 退出前调用）：进程直接退出会把排在队里的任务整个丢掉 */
export async function drainPlaceQueue(): Promise<void> {
  await queueChain;
}

/**
 * 单个任务：反解坐标 → 只在地名仍为空时写库。
 * 【为什么只写空值】地名列一旦有值就是后台「保存拍摄参数」写入的人工结果，
 * 异步补录不允许把它悄悄改掉。
 */
async function runTask(config: AppConfig, db: Db, task: PlaceTask): Promise<void> {
  try {
    const place = await reverseGeocode(config.AMAP_KEY, task.lat, task.lon);
    if (place === null) return;
    await db
      .update(exifMetadata)
      .set({ place: place.label, province: place.province, city: place.city })
      // 「地名为空」的判定与批量补地名、回填脚本共用一份（见 place-candidates）
      .where(and(eq(exifMetadata.mediaId, task.mediaId), placeIsEmpty()));
  } catch (err) {
    console.warn(`[geo] 地名异步补录失败（${task.mediaId}）：`, (err as Error).message);
  }
}
