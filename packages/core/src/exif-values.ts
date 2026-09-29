/**
 * packages/core/src/exif-values.ts
 *
 * EXIF 值在「文件原始字符串」与「表单编辑值」之间的转换与比较 —— 前后台共用同一份实现。
 *
 * 【为什么要抽到 core】需求要求前台的 EXIF 编辑在功能参数、处理逻辑、校验规则上与后台
 * 「完全一致」。把转换规则写在两处，就只能依赖人工同步；写在 core 里，是编译期保证的一致。
 *
 * 【铁律一：不做任何美化 / 还原】读写两侧都带 exiftool 的 `-n`，fields 里的值就是原始值
 * （FNumber 是 "2.8"、WhiteBalance 是 "1"、ExposureTime 是 "0.005"），前端原样进出。
 *
 * 【铁律二：中间表示是「canonical 文本」】把每种类型的值摊平成一种可字符串化、可比对的形态：
 *   - text / textarea / select：原样，**不 trim**（trim 会让「文件里是 "Make " 尾空格」永远删不掉）
 *   - number ：可解析为有限数 → `String(Number(x))`（"2.80" 与 "2.8" 视为同一值）
 *   - datetime：宽松解析成无时区的墙钟文本 `YYYY-MM-DDTHH:mm:ss`
 *   - tags ：按半角逗号切分后 trim 去空，再用 ", " 重新拼接
 * 有了统一中间表示，「有没有改」就退化成一次朴素字符串比较，不会再出现「改了却被判没改」。
 *
 * 【铁律三：datetime 是墙钟时间，绝不做时区平移】EXIF 的 DateTimeOriginal 没有时区语义，
 * 任何「按本地时区解析 + 偏移」都会把时间改错。因此这里自行实现纯字符串解析，
 * 只取前缀、丢弃亚秒与时区后缀，不借任何日期库。
 */
import type { ExifFieldType } from './exif-fields';

/* -------------------------------------------------------------------------- */
/* 自定义 tag 的字段名校验                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 自定义 tag 字段名的安全边界。
 * 【为什么必须是「字母开头」】tag 会直接拼进 exiftool 命令行参数，
 * 放行 `-foo` 就等于把任意命令行开关交给了前端输入。
 */
export const EXIF_TAG_PATTERN = /^[A-Za-z][A-Za-z0-9_:.]*$/;

/** 自定义 tag 的一行输入 */
export interface CustomTagRow {
  /** React key，与 tag 名解耦（tag 名可能为空或重复） */
  key: string;
  tag: string;
  value: string;
}

/** 新增一行的初始值 */
export function emptyExifCustomTagRow(): CustomTagRow {
  return { key: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, tag: '', value: '' };
}

/**
 * 逐行校验，返回第一条错误信息；全部合法返回 null（提交前调用）。
 * 与后端 photos.service.ts 的 EXIF_TAG_PATTERN 校验同规则，前端先拦一道，
 * 用户不用等一次失败请求才知道写错了。
 */
export function validateExifCustomTags(
  rows: readonly CustomTagRow[],
  specTags: ReadonlySet<string>,
): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    // 整行留空的当作没填，直接忽略
    if (row.tag === '' && row.value === '') continue;
    if (row.tag === '') return '自定义 tag 的字段名不能为空';
    if (!EXIF_TAG_PATTERN.test(row.tag)) {
      return `字段名「${row.tag}」非法：需以字母开头，只能包含字母、数字、下划线、冒号、点`;
    }
    if (seen.has(row.tag)) return `字段名「${row.tag}」重复`;
    if (specTags.has(row.tag)) return `字段名「${row.tag}」已在上方表单里，请直接改上面的字段`;
    seen.add(row.tag);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 各类型的 canonical 化                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 匹配日期时间前缀。捕获组：年 月 日 时 分 [秒]
 *
 * 【为什么分隔符是 `[-:]` 而不是只认冒号】exiftool 输出 `2026:03:18 15:28:47`，
 * 而原生 `<input type="datetime-local">` 与 ISO 串用连字符 `2026-03-18T15:28:47`。
 * 两种口径都要能解析。
 * 【为什么秒可选】datetime-local 可能只精确到分钟，缺省补 "00"。
 * 正则只匹配前缀，因此 `.000` 亚秒与 `Z` / `+08:00` 时区后缀被自然丢弃 —— 这正是所需的行为。
 */
const EXIF_DATETIME_RE = /^(\d{4})[-:](\d{2})[-:](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

/** 日期时间 → canonical `YYYY-MM-DDTHH:mm:ss`；解析不出或越界返回空串（当「未设置」） */
function canonicalizeDatetime(text: string): string {
  const matched = EXIF_DATETIME_RE.exec(text.trim());
  if (!matched) return '';
  const [, year, month, day, hour, minute, second = '00'] = matched;
  // 范围校验：exiftool 对「缺失时间」会写 0000:00:00 00:00:00，必须把它判成空值
  if (Number(month) < 1 || Number(month) > 12) return '';
  if (Number(day) < 1 || Number(day) > 31) return '';
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return '';
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

/** 数值 → canonical；非有限数或空 → 空串（当「未设置」） */
function canonicalizeNumber(text: string): string {
  if (text.trim() === '') return '';
  const num = Number(text);
  return Number.isFinite(num) ? String(num) : '';
}

/** 多值 tag 文本 → 字符串数组（半角逗号切分、逐项 trim、去空，不去重） */
function splitTagText(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/* -------------------------------------------------------------------------- */
/* 对外三件套：原始 → 文本 / 文本 → 提交值 / 文本是否相等                        */
/* -------------------------------------------------------------------------- */

/** 文件里的原始值 → 表单编辑用的 canonical 文本 */
export function exifRawToText(type: ExifFieldType, raw: string | undefined): string {
  const text = raw ?? '';
  switch (type) {
    case 'number':
      return canonicalizeNumber(text);
    case 'datetime':
      return canonicalizeDatetime(text);
    case 'tags':
      return splitTagText(text).join(', ');
    default:
      // text / textarea / select：原样，不 trim
      return text;
  }
}

/** canonical 文本 → 提交给后端的值；null / 空串表示清除该 tag，数组表示多值 tag */
export function exifTextToSubmit(type: ExifFieldType, text: string): string | string[] | null {
  switch (type) {
    case 'number': {
      const canonical = canonicalizeNumber(text);
      return canonical === '' ? null : canonical;
    }
    case 'datetime': {
      const canonical = canonicalizeDatetime(text);
      if (canonical === '') return null;
      // canonical 是定长 19：YYYY-MM-DDTHH:mm:ss → 拼回 exiftool 口径 YYYY:MM:DD HH:mm:ss
      return `${canonical.slice(0, 4)}:${canonical.slice(5, 7)}:${canonical.slice(8, 10)} ${canonical.slice(
        11,
        13,
      )}:${canonical.slice(14, 16)}:${canonical.slice(17, 19)}`;
    }
    case 'tags': {
      const list = splitTagText(text);
      return list.length > 0 ? list : null;
    }
    default:
      // text / textarea / select：不 trim，空串即清除
      return text === '' ? null : text;
  }
}

/**
 * 两个 canonical 文本是否「语义等价」。
 * 【为什么不用朴素字符串比较】文件里可能是 "2.80"、表单回填成 "2.8"，
 * 朴素比较会判成「用户改了」，于是每次保存都白写一次文件。
 */
export function exifSameText(type: ExifFieldType, aText: string, bText: string): boolean {
  switch (type) {
    case 'number':
      return canonicalizeNumber(aText) === canonicalizeNumber(bText);
    case 'datetime':
      // canonical 是秒级定长文本，字符串相等即秒级相等
      return canonicalizeDatetime(aText) === canonicalizeDatetime(bText);
    case 'tags': {
      const left = splitTagText(aText);
      const right = splitTagText(bText);
      return left.length === right.length && left.every((value, index) => value === right[index]);
    }
    default:
      return aText === bText;
  }
}