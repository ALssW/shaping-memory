/**
 * apps/web/src/lib/localExif.ts
 *
 * 「本地 EXIF 工作台」的纯逻辑层：导入项模型、字段汇总、草稿 → patch、导出命名与下载。
 *
 * 【为什么抽到组件之外】这几条规则（多张「值不一致」怎么判定、「留空」与「清除」怎么区分、
 * 无边界字段的滑块保底区间怎么算）是整个工作台最容易出错的地方，集中一处便于阅读与核对；
 * 组件里只保留渲染与交互，同时把组件行数控制在 200 行以内。
 *
 * 【重活已搬进 Worker】本文件只剩「流程编排 + 纯计算」：读字节、解析、改写都通过
 * exifWorkerClient 派给 `workers/exif.worker.ts`，主线程不持有完整文件字节。
 */
import {
  canonicalExposureText,
  exposureKindOfTag,
  exifRawToText,
  exifSameText,
  isValidLatLon,
  parseGpsValue,
} from '@shaping-memory/core';
import type { ContainerKind, ExifField, GeoPoint, LocalExifDocument } from '@shaping-memory/core';

import { loadExifItem } from './exifWorkerClient';

/* -------------------------------------------------------------------------- */
/* 导入项                                                                       */
/* -------------------------------------------------------------------------- */

/** 工作台里的一张照片：字节在 Worker 的字节库里，这里只留句柄与摘要 */
export interface LocalExifItem {
  id: string;
  name: string;
  /** 缩略图用的临时对象 URL（RAW 用内嵌预览、JPEG/PNG 用原文件；离开工作台必须回收） */
  previewUrl: string;
  /** 原文件句柄：导出时按名字与容器算扩展名，字节本身不进主线程 */
  file: File;
  /** 文件字节数（列表展示体积信息，不读字节就能拿到） */
  sizeBytes: number;
  /** 容器类型：决定导出扩展名、MIME 与「能不能编辑」 */
  container: ContainerKind;
  /** 解析出的 EXIF；只读行没有 */
  doc: LocalExifDocument | null;
  /** 只读原因（格式不支持 / 解析失败）；null 表示可编辑 */
  readOnlyReason: string | null;
}

/** 自增序号：同名同大小的两张文件也要有各自的 id，不能靠名字去重 */
let itemSeq = 0;

/** 内嵌预览字节 → 对象 URL；没有预览时退回原文件 URL（<img> 认不出会自动隐藏，露出相机占位） */
function previewUrlOf(file: File, preview: Uint8Array | null): string {
  if (!preview) return URL.createObjectURL(file);
  return URL.createObjectURL(new Blob([new Uint8Array(preview)], { type: 'image/jpeg' }));
}

/** 读一个本地文件成工作台导入项：任何失败都落成「只读 + 中文原因」，不中断整批导入 */
export async function readLocalItem(file: File): Promise<LocalExifItem> {
  const id = `local-${itemSeq++}`;
  const result = await loadExifItem(id, file);
  return {
    id,
    name: file.name,
    previewUrl: previewUrlOf(file, result.preview),
    file,
    sizeBytes: result.sizeBytes,
    container: result.container,
    doc: result.doc,
    readOnlyReason: result.readOnlyReason,
  };
}

/* -------------------------------------------------------------------------- */
/* 写不了的字段（诚实置灰，而不是让用户填完再报错）                                */
/* -------------------------------------------------------------------------- */

/**
 * 归类「值住在 XMP / IPTC 容器里、纯 TIFF 编解码器装不下」的字段。
 * 【为什么在前端再列一份】core 的 exif-io.ts 把这张表私有化了（那是编码器内部细节），
 * 工作台需要的是「界面先置灰」这一层判断，因此按同一口径在这里显式列出。
 */
const CONTAINER_ONLY_TAGS: ReadonlyMap<string, string> = new Map([
  ['ColorTemperature', 'XMP-crs'],
  ['Category', 'IPTC'],
  ['Subject', 'XMP-dc'],
  ['Rating', 'XMP-xmp'],
]);

/** 该字段所属的容器名；null 表示能正常读写 */
export function containerOnlyOf(tag: string): string | null {
  return CONTAINER_ONLY_TAGS.get(tag) ?? null;
}

/* -------------------------------------------------------------------------- */
/* 草稿：三态语义                                                               */
/* -------------------------------------------------------------------------- */

/**
 * skip = 不改动（留空即此态）、set = 写入新值、clear = 删除该 tag（导出时写 null）。
 * 【为什么必须三态】「留空」表示不修改，「清除」表示把字段从文件里删掉 —— 两者语义相反，
 * 若只用空串表达，用户永远说不清自己想要哪一个。
 */
export type DraftAction = 'skip' | 'set' | 'clear';

export interface FieldDraft {
  action: DraftAction;
  text: string;
}

export const SKIP_DRAFT: FieldDraft = { action: 'skip', text: '' };

/** 草稿 → 供 applyLocalExifPatch 的 patch：skip 不入表，clear → null */
export function buildPatch(drafts: Record<string, FieldDraft>): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  for (const [tag, draft] of Object.entries(drafts)) {
    if (draft.action === 'skip') continue;
    patch[tag] = draft.action === 'clear' ? null : draft.text;
  }
  return patch;
}

/* -------------------------------------------------------------------------- */
/* 字段值归一                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 字段值的 canonical 文本。
 * 【为什么曝光三要素要单独走一道】core 读出的快门是摄影写法（`1/200`），
 * 而 `exifRawToText('number', '1/200')` 会按数值解析、非有限就退回空串 ——
 * 直接用会让工作台里的快门永远是空值，「多张值不一致」也永远判不出来。
 */
export function canonicalFieldText(spec: ExifField, raw: string | undefined): string {
  const kind = exposureKindOfTag(spec.tag);
  return kind === null ? exifRawToText(spec.type, raw) : canonicalExposureText(kind, raw ?? '');
}

/* -------------------------------------------------------------------------- */
/* 多张汇总：值一致 / 不一致                                                     */
/* -------------------------------------------------------------------------- */

export interface FieldSummary {
  /** 各张 canonical 值一致时的公共值；不一致或没选时为 '' */
  base: string;
  /** 出现过几种不同的 canonical 值 */
  distinct: number;
  /** 多张选中且取值不同 —— 此时绝不能拿第一张的值冒充 */
  inconsistent: boolean;
  /**
   * 勾选的照片里至少有张带这个 tag。
   * 【为什么单独记一位】「清除」是否有意义，取决于文件里到底有没有这个 tag ——
   * 不能拿 base 是否为空来判断：多张取值不同时 base 也是空，但 tag 明明存在，
   * 用户完全可能想把它们统一删掉。
   */
  present: boolean;
}

const EMPTY_SUMMARY: FieldSummary = { base: '', distinct: 0, inconsistent: false, present: false };

export function summarizeField(items: readonly LocalExifItem[], spec: ExifField): FieldSummary {
  if (items.length === 0) return EMPTY_SUMMARY;
  const seen = new Set<string>();
  for (const item of items) seen.add(canonicalFieldText(spec, item.doc?.values[spec.tag]));
  const values = [...seen];
  return {
    base: values.length === 1 ? values[0] : '',
    distinct: values.length,
    inconsistent: values.length > 1,
    present: values.some((value) => value !== ''),
  };
}

/** 一次算完全部字段：字段数固定（41），按选中集合 memo 就够 */
export function summarizeAll(
  items: readonly LocalExifItem[],
  specs: readonly ExifField[],
): ReadonlyMap<string, FieldSummary> {
  return new Map(specs.map((spec) => [spec.tag, summarizeField(items, spec)]));
}

/* -------------------------------------------------------------------------- */
/* 数字字段：滑块保底区间                                                         */
/* -------------------------------------------------------------------------- */

/** 清理浮点噪声：html range 的 value 常带 0.30000000000000004 这类尾巴 */
export function cleanNumberText(raw: string): string {
  const num = Number(raw);
  if (!Number.isFinite(num)) return '';
  return String(Number(num.toPrecision(12)));
}

/**
 * 滑块的 min / max / step。
 * 【为什么保底区间只看 base】base 来自文件里的一致性公共值，不来自用户正在拖的草稿值。
 * 若区间跟着实时值走，拖动滑块会改区间、区间又改滑块可落点，形成自反馈 —— 移动端实测过
 * 「滑块拖不动」就是这个原因。所以这里只按 step 与 base 的基准值放大出一个粗略区间，
 * 精度仍然交给旁边的数字框（它带 step，且不受保底区间限制）。
 */
export function numberRange(spec: ExifField, base: string): { min: number; max: number; step: number } {
  const step = spec.step != null && spec.step > 0 ? spec.step : 1;
  const anchor = Number(base);
  const magnitude = Math.max(Number.isFinite(anchor) ? Math.abs(anchor) : 0, step);
  const span = magnitude * 10;
  const min = spec.min ?? Number((anchor - span).toPrecision(12));
  const max = spec.max ?? Number((anchor + span).toPrecision(12));
  // min 来自 spec、max 走保底时可能反了，修正一下保证 range 可用
  return { min, max: max > min ? max : min + span * 2, step };
}

/* -------------------------------------------------------------------------- */
/* 应用前校验                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 逐条校验 patch（返回首条中文错误，null 表示可以应用）。
 * 【为什么要先拦一道】applyLocalExifPatch 写入失败是在导出/应用的中途抛错，
 * 用户拿到的是一句底层异常；这里按字段规格先校验，错误能精确指到具体字段。
 */
export function validatePatch(patch: Record<string, string | null>, specs: readonly ExifField[]): string | null {
  const byTag = new Map(specs.map((spec) => [spec.tag, spec]));
  for (const [tag, value] of Object.entries(patch)) {
    const spec = byTag.get(tag);
    if (!spec || value === null) continue;
    if (spec.type === 'number') {
      const num = Number(value);
      // exif-io 的有理数解析只认十进制字面量，科学计数法（1e3）会直接抛错，提前挡住
      if (!Number.isFinite(num) || /[eE]/.test(value)) return `「${spec.label}」需要填一个普通数字（不要用科学计数法）`;
      if ((spec.min != null && num < spec.min) || (spec.max != null && num > spec.max)) {
        return `「${spec.label}」需在 ${spec.min} ~ ${spec.max} 之间`;
      }
    }
  }
  return null;
}

/** 该字段的草稿是否与「不修改」等价（用于把改回原值的操作自动收成 skip） */
export function draftMatchesBase(spec: ExifField, text: string, summary: FieldSummary | undefined): boolean {
  if (summary === undefined || summary.inconsistent) return false;
  // 曝光三要素的 base 已是 canonical（秒 / f 数 / 整数），草稿也得先归一再比，
  // 否则用户手输 `0.005` 会被判成「有改动」，白写一遍字节
  if (exposureKindOfTag(spec.tag) !== null) return canonicalFieldText(spec, text) === summary.base;
  return exifSameText(spec.type, text, summary.base);
}

/* -------------------------------------------------------------------------- */
/* 定位（地图选点）                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 定位所涉及的一组 tag。
 * 【为什么连方向字段一起列】core 的 GPS 联动只「补」不「删」—— 坐标写成 null 时
 * 它对方向字段直接跳过，只清坐标会留下「有方向没坐标」的残缺 GPS 段。
 */
export const GPS_LOCATION_TAGS = ['GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef'] as const;

/** 勾选照片的公共定位 */
export interface GpsSummary {
  /** 各张定位一致时的公共点（WGS-84）；不一致 / 都没有 / 未勾选时为 null */
  base: GeoPoint | null;
  /** 已选多张且定位不完全相同 —— 此时绝不能拿第一张的定位冒充 */
  inconsistent: boolean;
  /** 勾选的照片里至少有张带定位（决定「清除定位」是否有意义） */
  present: boolean;
}

const EMPTY_GPS_SUMMARY: GpsSummary = { base: null, inconsistent: false, present: false };

/** 读一张照片已有的定位；坐标缺一半或非法一律当作「没有」 */
function gpsOf(item: LocalExifItem): GeoPoint | null {
  const lat = parseGpsValue(item.doc?.values.GPSLatitude);
  const lon = parseGpsValue(item.doc?.values.GPSLongitude);
  return isValidLatLon(lat, lon) ? { lat: lat as number, lon: lon as number } : null;
}

export function summarizeGps(items: readonly LocalExifItem[]): GpsSummary {
  if (items.length === 0) return EMPTY_GPS_SUMMARY;
  // 用「lat,lon」做键同时完成去重与「是不是同一处」的判定
  const seen = new Map<string, GeoPoint | null>();
  for (const item of items) {
    const point = gpsOf(item);
    seen.set(point ? `${point.lat},${point.lon}` : '', point);
  }
  const entries = [...seen.entries()];
  return {
    base: entries.length === 1 ? entries[0][1] : null,
    inconsistent: entries.length > 1,
    present: entries.some(([key]) => key !== ''),
  };
}

/** 按 tag 合并草稿：值为 undefined 表示撤掉该 tag 的草稿（回到「不修改」） */
export type DraftMerge = Record<string, FieldDraft | undefined>;

/** 清除态草稿：四个定位 tag 共用同一份（内容相同且只读使用） */
const CLEAR_DRAFT: FieldDraft = { action: 'clear', text: '' };

/**
 * 选点 / 清除定位要落的草稿。
 * 【为什么选点时要「撤掉」方向字段的草稿】坐标非 null 时 core 会按正负自动补 N/S、E/W，
 * 留一条 clear 只会让界面凭空挂一个「将清除」徽标。
 */
export function gpsDraftMerge(point: GeoPoint | null): DraftMerge {
  if (point === null) {
    return {
      GPSLatitude: CLEAR_DRAFT,
      GPSLongitude: CLEAR_DRAFT,
      GPSLatitudeRef: CLEAR_DRAFT,
      GPSLongitudeRef: CLEAR_DRAFT,
    };
  }
  return {
    GPSLatitude: { action: 'set', text: String(point.lat) },
    GPSLongitude: { action: 'set', text: String(point.lon) },
    GPSLatitudeRef: undefined,
    GPSLongitudeRef: undefined,
  };
}

/** 撤销定位改动：四个 tag 的草稿全部撤掉 */
export function gpsDraftReset(): DraftMerge {
  return { GPSLatitude: undefined, GPSLongitude: undefined, GPSLatitudeRef: undefined, GPSLongitudeRef: undefined };
}

/**
 * 草稿 → 地图上该显示的选点。
 * pending 为 true 表示用户已动过定位（草稿存在），此时即使选出来是 null 也不能回落到文件里的旧定位。
 */
export function draftGpsPoint(drafts: Record<string, FieldDraft>, fallback: GeoPoint | null): { point: GeoPoint | null; pending: boolean } {
  const latDraft = drafts.GPSLatitude;
  const lonDraft = drafts.GPSLongitude;
  const pending = [latDraft, lonDraft].some((draft) => draft !== undefined && draft.action !== 'skip');
  if (!pending) return { point: fallback, pending: false };
  if (latDraft?.action !== 'set' || lonDraft?.action !== 'set') return { point: null, pending: true };
  const lat = Number(latDraft.text);
  const lon = Number(lonDraft.text);
  return { point: isValidLatLon(lat, lon) ? { lat, lon } : null, pending: true };
}
