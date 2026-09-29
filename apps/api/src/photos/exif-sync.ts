/**
 * apps/api/src/photos/exif-sync.ts
 *
 * 「全量 EXIF（-n 原始 tag）」→「数据库展示列」的映射，以及「数据库 → 待写回 tag」的反向筛选。
 *
 * 【为什么需要单独一层】前台卡片、时间线、查看器读的是 exif_metadata 的展示列
 * （cam/lens/focal/aperture/iso/speed/temp/wb）与 media 的拍摄日期，
 * 而后台编辑写的是 exif_metadata.extra 里的原始 tag（数据库是唯一事实源，不再写照片文件）。
 * 两边一旦不同步，就会出现「后台改了快门、前台卡片还是旧值」的假象：
 * 因此 edit 链路每次改完 extra 都立刻用这里的映射回填展示列。
 *
 * 口径：输入是 exiftool `-n` 的原始值（FNumber=4、ExposureTime=0.005），
 * 输出是**给人看**的展示值（f/4.0、1/200）—— 与导入管线 toExifData 的口径保持一致。
 */
import type { ExifFull, ExifWriteValue } from '@shaping-memory/exif';
import type { MediaInsert } from '@shaping-memory/db';
import { EXIF_EDITABLE_TAGS } from '@shaping-memory/core';

/** exif_metadata 中需要随文件同步的展示列 */
export interface ExifDisplayPatch {
  cam: string | null;
  lens: string | null;
  focal: string | null;
  aperture: string | null;
  iso: number | null;
  speed: string | null;
  temp: string | null;
  wb: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  gpsAlt: number | null;
}

/** 白平衡：EXIF 里是 0/1 枚举，展示成「自动 / 手动」 */
const WHITE_BALANCE_LABEL: Record<string, string> = { '0': '自动', '1': '手动' };

const num = (raw: string | undefined): number | null => {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** 经纬度/海拔本体无符号，南纬/西经/海平面以下靠 Ref 表达；与 gpsOf 的 signedGps 同一口径 */
const signed = (raw: string | undefined, ref: string | undefined, negativeRef: string): number | null => {
  const n = num(raw);
  if (n == null) return null;
  return n > 0 && ref === negativeRef ? -n : n;
};

/** 去掉 "50.0" 这种整数尾巴 → "50" */
const trimNumber = (n: number): string => String(Number(n.toFixed(4)));

/** 焦距：50 → "50mm" */
function formatFocal(raw: string | undefined): string | null {
  const n = num(raw);
  return n == null ? null : `${trimNumber(n)}mm`;
}

/** 光圈：4 → "f/4"（保留一位小数：2.8 → "f/2.8"） */
function formatAperture(raw: string | undefined): string | null {
  const n = num(raw);
  return n == null ? null : `f/${Number(n.toFixed(1))}`;
}

/** 快门：0.005 → "1/200"；大于等于 1 秒 → "2s" */
function formatSpeed(raw: string | undefined): string | null {
  const n = num(raw);
  if (n == null || n <= 0) return null;
  if (n >= 1) return `${trimNumber(n)}s`;
  return `1/${Math.round(1 / n)}`;
}

/** 色温：5226 → "5226K" */
function formatTemp(raw: string | undefined): string | null {
  const n = num(raw);
  return n == null ? null : `${Math.round(n)}K`;
}

/** 把全量 EXIF 映射成 exif_metadata 的展示列（缺失字段给 null，表示「文件里没有」） */
export function displayPatchOf(fields: ExifFull): ExifDisplayPatch {
  const gpsAlt = signed(fields.GPSAltitude, fields.GPSAltitudeRef, '1');
  return {
    cam: fields.Model?.trim() || null,
    lens: fields.LensModel?.trim() || null,
    focal: formatFocal(fields.FocalLength),
    aperture: formatAperture(fields.FNumber),
    iso: num(fields.ISO),
    speed: formatSpeed(fields.ExposureTime),
    temp: formatTemp(fields.ColorTemperature),
    wb: WHITE_BALANCE_LABEL[fields.WhiteBalance ?? ''] ?? null,
    gpsLat: signed(fields.GPSLatitude, fields.GPSLatitudeRef, 'S'),
    gpsLon: signed(fields.GPSLongitude, fields.GPSLongitudeRef, 'W'),
    gpsAlt: gpsAlt == null ? null : Number(gpsAlt.toFixed(2)),
  };
}

/**
 * 从 EXIF 的 DateTimeOriginal 解析出 media 的两个日期列。
 * 输入是 exiftool 原生格式 "2024:05:01 10:23:45"（与导入管线 parseTakenAt 同一口径）。
 * 改拍摄时间会改变照片在时间线里的位置，因此这一步必须跟着写。
 */
export function mediaDatePatchOf(fields: ExifFull): Partial<MediaInsert> {
  const raw = fields.DateTimeOriginal ?? fields.CreateDate ?? '';
  const matched = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!matched) return {};
  const [, y, mo, d, h, mi, s] = matched;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return {};
  return { captureAt: `${y}-${mo}-${d}`, takenAt: parsed };
}

/** GPS 的三个本体 tag + 三个方向 tag：由地图选点写入，不在 EXIF_FIELDS 清单里，需单独放行 */
const GPS_COMPANION_TAGS = [
  'GPSLatitude',
  'GPSLongitude',
  'GPSAltitude',
  'GPSLatitudeRef',
  'GPSLongitudeRef',
  'GPSAltitudeRef',
];

/** 允许写回文件的 tag 集合：用户可编辑项 ∪ GPS 伴随项 */
const WRITABLE_TAGS: ReadonlySet<string> = new Set([...EXIF_EDITABLE_TAGS, ...GPS_COMPANION_TAGS]);

/**
 * 数据库里的全量 EXIF → 待写回文件的 tag 表（下载时注入副本用）。
 *
 * 【为什么只挑可编辑 tag】extra 里还躺着 FileType / MIMEType / ImageWidth 这类**只读** tag，
 * 写回去只会换来 exiftool 告警；原片副本本就带着它们，跳过即等于原样保留。
 */
export function exifWritesOf(
  extra: Record<string, string> | null | undefined,
): Record<string, ExifWriteValue> {
  const writes: Record<string, ExifWriteValue> = {};
  for (const [tag, value] of Object.entries(extra ?? {})) {
    if (value != null && value !== '' && WRITABLE_TAGS.has(tag)) writes[tag] = value;
  }
  return writes;
}
