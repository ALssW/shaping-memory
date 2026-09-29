/**
 * apps/admin/src/lib/exif-values.ts
 *
 * EXIF 值在「文件原始字符串」与「AntD 表单控件值」之间的双向转换 —— **core 之上的薄封装**。
 *
 * 【为什么只剩薄封装】转换规则（canonical 化、语义比较、日期解析、tag 校验）已经全部迁至
 * `@shaping-memory/core` 的 exif-values.ts，前台与后台共用同一份实现，从编译期保证一致。
 * 这里只负责把 core 的「canonical 文本」与后台控件要求的形态（Dayjs / number / string[]）对接。
 *
 * 【铁律：不做任何美化 / 还原】读写两侧都走 exiftool 的 `-n`，所以 fields 里的值就是原始值字符串
 * （FNumber 是 "2.8"、WhiteBalance 是 "1"、ExposureTime 是 "0.005"），表单里原样进出。
 */
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import type { ExifField } from '@shaping-memory/core';
import { exifRawToText, exifSameText, exifTextToSubmit } from '@shaping-memory/core';

/** exiftool 的日期时间格式（不是 ISO！） */
export const EXIF_DATETIME_FORMAT = 'YYYY:MM:DD HH:mm:ss';

/** 提交给后端的单个字段值：null / 空串表示清除该 tag，数组表示多值 tag */
export type ExifSubmitValue = string | string[] | null;

/**
 * 文件里的 "2026:03:18 15:28:47" → Dayjs；解析不出来返回 null（当空值处理，不报错）。
 *
 * 【为什么不再回退到 `dayjs(raw)`】core 的 canonical 文本是**无时区**的墙钟时间（`YYYY-MM-DDTHH:mm:ss`），
 * dayjs 按本地时区解析它不会产生任何偏移。而原先对非 exiftool 口径的串直接 `dayjs(raw)`，
 * 遇到 `2026-03-18T15:28:47.000Z` 这类带时区后缀的值会**按本地时区平移 +8 小时** ——
 * EXIF 的时间没有时区语义，平移即产生错误。现在后缀在 core 里被丢弃，墙钟时间原样保留。
 */
export function parseExifDatetime(raw: string | undefined): Dayjs | null {
  const text = exifRawToText('datetime', raw);
  return text === '' ? null : dayjs(text);
}

/** Dayjs → 文件格式字符串；空值返回 null（提交时即「清除该 tag」） */
export function formatExifDatetime(value: Dayjs | null | undefined): string | null {
  return value ? value.format(EXIF_DATETIME_FORMAT) : null;
}

/** 后端读回来的多值 tag（", " 拼接）→ 表单用的数组 */
export function splitTagValues(raw: string | undefined): string[] {
  const canonical = exifRawToText('tags', raw);
  return canonical === '' ? [] : canonical.split(', ');
}

/** Dayjs / null → core 的 canonical 墙钟文本（比较用），空值 → 空串 */
function dayjsToCanonicalText(value: unknown): string {
  const picked = value as Dayjs | null | undefined;
  return picked ? exifRawToText('datetime', picked.format('YYYY-MM-DD HH:mm:ss')) : '';
}

/** 文件原始字符串 → 表单控件的初始值（类型随 ExifField.type 变） */
export function rawToFormValue(spec: ExifField, raw: string | undefined): unknown {
  switch (spec.type) {
    case 'datetime':
      return parseExifDatetime(raw);
    case 'tags':
      return splitTagValues(raw);
    case 'number': {
      const canonical = exifRawToText('number', raw);
      return canonical === '' ? null : Number(canonical);
    }
    default:
      return raw ?? '';
  }
}

/** 表单控件值 → 提交值（空值一律归一成 null，后端据此删除该 tag） */
export function formToSubmitValue(spec: ExifField, value: unknown): ExifSubmitValue {
  switch (spec.type) {
    case 'datetime':
      return formatExifDatetime(value as Dayjs | null | undefined);
    case 'tags': {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return exifTextToSubmit('tags', list.join(','));
    }
    case 'number':
      return exifTextToSubmit('number', value == null ? '' : String(value));
    default: {
      const text = value == null ? '' : String(value);
      return exifTextToSubmit('text', text);
    }
  }
}

/**
 * 表单值是否与文件里的原值「语义等价」。
 * 用语义比较而非字符串比较，是为了「没改就不提交」—— 例如文件里是 "2.80"
 * 而表单回填成 2.8，不该被误判成用户改了光圈；datetime 带时区后缀同理。
 */
export function isSameFormValue(spec: ExifField, a: unknown, b: unknown): boolean {
  switch (spec.type) {
    case 'datetime':
      return dayjsToCanonicalText(a) === dayjsToCanonicalText(b);
    case 'tags': {
      const left = ((a as string[] | undefined) ?? []).join(',');
      const right = ((b as string[] | undefined) ?? []).join(',');
      return exifSameText('tags', left, right);
    }
    case 'number':
      return exifSameText(
        'number',
        a == null ? '' : String(a),
        b == null ? '' : String(b),
      );
    default:
      return exifSameText(
        'text',
        a == null ? '' : String(a),
        b == null ? '' : String(b),
      );
  }
}