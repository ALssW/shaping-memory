/**
 * apps/api/src/backfill-place-trim.ts
 *
 * 一次性回填：把地点三列（place / province / city）结尾的省级、市级行政层级后缀去掉。
 * 用法：`npm run backfill:place-trim -w @shaping-memory/api`
 *
 * 【为什么需要】早期逆地理解析直接存高德返回的行政区全名（「广东省 · 深圳市」），
 * 现口径统一为「去后缀的专名」（「广东 · 深圳」），存量数据按同一口径修剪一遍。
 * 【处理边界】只动行政区名称结尾的层级后缀（省 / 自治区 / 特别行政区 / 市 / 自治州 / 盟 / 地区），
 * 分隔符、空值、不含后缀的自由文本一律原样保留；三列的字段结构不变。
 * 【之后还需要再跑吗】不需要。写入链路已同步为去后缀口径（见 geo/regeo 的 buildPlace）。
 * 重复执行是安全的：修剪幂等，第二次起不会再有任何行变化。
 */
import './env';
import { eq } from 'drizzle-orm';
import { loadConfig } from '@shaping-memory/config';
import { createDb, exifMetadata } from '@shaping-memory/db';
import { trimAdminSuffix, trimPlaceLabel } from './geo/regeo';

/** 地点三列的取值（结构与表列一致，只是内容按口径修剪） */
interface PlaceTriple {
  place: string | null;
  province: string | null;
  city: string | null;
}

/** 对一行的三列做去后缀修剪；null 原样保留 */
function trimTriple(row: PlaceTriple): PlaceTriple {
  return {
    place: row.place == null ? null : trimPlaceLabel(row.place),
    province: row.province == null ? null : trimAdminSuffix(row.province),
    city: row.city == null ? null : trimAdminSuffix(row.city),
  };
}

/**
 * 这一行是否还带行政层级后缀：修剪一次后值仍在变，就说明原值没修干净。
 * 「待修剪判定」与「残留自检」共用它，两步口径必然一致。
 */
function needsTrim(row: PlaceTriple): boolean {
  const next = trimTriple(row);
  return next.place !== row.place || next.province !== row.province || next.city !== row.city;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);

  const rows = await db
    .select({
      mediaId: exifMetadata.mediaId,
      place: exifMetadata.place,
      province: exifMetadata.province,
      city: exifMetadata.city,
    })
    .from(exifMetadata);

  let updated = 0;
  for (const row of rows) {
    if (!needsTrim(row)) continue;
    const next = trimTriple(row);
    await db.update(exifMetadata).set(next).where(eq(exifMetadata.mediaId, row.mediaId));
    updated += 1;
    // eslint-disable-next-line no-console
    console.log(`[place-trim] ${row.place ?? '—'} → ${next.place ?? '—'}`);
  }

  /* 校验：回读数据库确认三列再无行政层级后缀残留 —— 不信内存信落库值 */
  const after = await db
    .select({
      place: exifMetadata.place,
      province: exifMetadata.province,
      city: exifMetadata.city,
    })
    .from(exifMetadata);
  const residual = after.filter(needsTrim).length;

  // eslint-disable-next-line no-console
  console.log(`[place-trim] 完成：修剪 ${updated} 行；回读校验后缀残留 ${residual} 行（应为 0）`);
}

void main();
