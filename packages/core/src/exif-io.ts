/**
 * packages/core/src/exif-io.ts
 *
 * 本地 JPEG EXIF 编解码器 —— 「工具模块 · EXIF 编辑」的地基。
 *
 * 【为什么自行实现】本地工具要在浏览器与 RN（Hermes）两端跑同一份逻辑，还要能改字节：
 *   - 不能依赖 Buffer / Node API（RN 没有）；
 *   - 不能依赖 atob / btoa / TextDecoder / TextEncoder（Hermes 支持度不可靠）；
 *   因此 ASCII / UTF-8 / UTF-16 的编解码全部在本文件内自实现，只用到
 *   Uint8Array / DataView / String / Map 这几样。
 *
 * 【写入策略：原 TIFF 整段留存 + 新 IFD 追加到末尾】——本文件最关键的一处设计。
 *   TIFF 规范允许 IFD 表出现在任意偏移。因此采取如下做法：
 *     1) 原 TIFF 字节按原偏移原样保留（只重写前 8 字节的 TIFF 头）；
 *     2) 把新的 IFD0 / ExifIFD / GPS 表追加到原 TIFF 之后；
 *     3) 每条条目按需二选一：值域继续指向**原偏移**（数据没动，字节级不变），
 *        或指向新增的数据块。
 *   由此得到两个硬性保证：
 *     - 未涉及的 tag（含未知 tag、MakerNote、厂商私有 IFD、Interoperability IFD）
 *       数据仍在原来的偏移上，**内部绝对偏移全部继续成立**；
 *     - IFD1 缩略图位置未动，只需让新 IFD0 的 next 指针继续指向它即可原样带回。
 *   代价：文件里会留下少量不再被引用的旧表 / 旧值（几十~几百字节），这是换取
 *   「未知私有结构绝对偏移不失效」的必要成本。
 *
 * 【不做静默降级】非 JPEG 抛 NotJpegError；TIFF/IFD 结构越界抛可读 Error；
 *   patch 里出现 EXIF APP1(TIFF) 装不下的字段（XMP/IPTC 容器字段）也明确报错。
 */
import { EXIF_FIELDS } from './exif-fields';

/* ========================================================================== */
/* 1. 对外错误与类型                                                           */
/* ========================================================================== */

/** 非 JPEG 文件（PNG / HEIC / …）：两端据此给出可读提示 */
export class NotJpegError extends Error {
  constructor(message = '仅支持 JPEG 的 EXIF 读写') {
    super(message);
    this.name = 'NotJpegError';
  }
}

/** 解析结果：既能给出可编辑的文本值，也保留未识别 tag 以便原样回写 */
export interface LocalExifDocument {
  /**
   * 容器类型。`other` = 认不出的格式（HEIC / WebP / GIF…），调用方据此说明「为什么只读」。
   * 【为什么不是布尔】前端要按容器给出不同文案与导出扩展名（NEF 要保住 .NEF），一个枚举比 isJpeg 更有用。
   */
  format: 'jpeg' | 'png' | 'tiff' | 'other';
  byteOrder: 'II' | 'MM';
  /** tag 名 → 人类可读文本（口径对齐 exif-values.ts 的 exifRawToText） */
  values: Record<string, string>;
  /** 未在 EXIF_FIELDS 中登记、但文件里真实存在的 tag 数（「原样保留 N 个未知字段」提示） */
  unknownCount: number;
}

/* ========================================================================== */
/* 2. 常量：TIFF 类型与 tag 归属                                                */
/* ========================================================================== */

const TYPE_BYTE = 1;
const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const TYPE_UNDEFINED = 7;
const TYPE_SLONG = 9;
const TYPE_SRATIONAL = 10;

/** 每种 TIFF 类型的单元素字节数（1..12 全覆盖，未列出的类型视为不可识别 → 条目原样透传） */
const TYPE_SIZE = new Map<number, number>([
  [1, 1], [2, 1], [3, 2], [4, 4], [5, 8], [6, 1], [7, 1], [8, 2], [9, 4], [10, 8], [11, 4], [12, 8],
]);

/** 结构指针 tag：不是内容，重算偏移时特殊处理，也不计入「未知字段」 */
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_GPS_IFD_POINTER = 0x8825;
const TAG_INTEROP_POINTER = 0xa005;
const TAG_GPS_VERSION_ID = 0x0000;
const TAG_GPS_LATITUDE = 0x0002;
const TAG_GPS_LATITUDE_REF = 0x0001;
const TAG_GPS_LONGITUDE = 0x0004;
const TAG_GPS_LONGITUDE_REF = 0x0003;
const TAG_GPS_ALTITUDE = 0x0006;
const TAG_GPS_ALTITUDE_REF = 0x0005;

/** 主表三兄弟：EXIF APP1 中实际读写的那几张 IFD */
type TiffIfd = 'ifd0' | 'exif' | 'gps';
const IFD_NAMES: readonly TiffIfd[] = ['ifd0', 'exif', 'gps'];

/** 值文本形态：决定读怎么写、写怎么解析 */
type ValueFormat =
  | 'text' | 'datetime' | 'int' | 'number' | 'fraction'
  | 'gpsCoord' | 'gpsAltitude' | 'ref' | 'userComment';

interface TagSpec {
  /** TIFF tag 编号 */
  id: number;
  /** 归属的 IFD（按 TIFF/Exif 规范，不允许随意挪） */
  ifd: TiffIfd;
  /** 落盘类型 */
  type: number;
  format: ValueFormat;
}

/**
 * exiftool 短名 → tag 归属与类型。
 * 顺序即 `values` 的键顺序（保证往返输出稳定可比）。
 * 只登记 **EXIF APP1(TIFF) 真正装得下** 的 tag；XMP / IPTC 容器字段（见下方 NOT_TIFF_TAGS）不在表内。
 */
const TAG_TABLE = new Map<string, TagSpec>([
  /* --- IFD0 --- */
  ['ImageDescription', { id: 0x010e, ifd: 'ifd0', type: TYPE_ASCII, format: 'text' }],
  ['Make', { id: 0x010f, ifd: 'ifd0', type: TYPE_ASCII, format: 'text' }],
  ['Model', { id: 0x0110, ifd: 'ifd0', type: TYPE_ASCII, format: 'text' }],
  ['Orientation', { id: 0x0112, ifd: 'ifd0', type: TYPE_SHORT, format: 'int' }],
  ['Software', { id: 0x0131, ifd: 'ifd0', type: TYPE_ASCII, format: 'text' }],
  ['ModifyDate', { id: 0x0132, ifd: 'ifd0', type: TYPE_ASCII, format: 'datetime' }],
  ['Artist', { id: 0x013b, ifd: 'ifd0', type: TYPE_ASCII, format: 'text' }],
  ['Copyright', { id: 0x8298, ifd: 'ifd0', type: TYPE_ASCII, format: 'text' }],
  /* --- ExifIFD --- */
  ['ExposureTime', { id: 0x829a, ifd: 'exif', type: TYPE_RATIONAL, format: 'fraction' }],
  ['FNumber', { id: 0x829d, ifd: 'exif', type: TYPE_RATIONAL, format: 'number' }],
  ['ExposureProgram', { id: 0x8822, ifd: 'exif', type: TYPE_SHORT, format: 'int' }],
  ['ISO', { id: 0x8827, ifd: 'exif', type: TYPE_SHORT, format: 'int' }],
  ['DateTimeOriginal', { id: 0x9003, ifd: 'exif', type: TYPE_ASCII, format: 'datetime' }],
  ['CreateDate', { id: 0x9004, ifd: 'exif', type: TYPE_ASCII, format: 'datetime' }],
  ['OffsetTimeOriginal', { id: 0x9011, ifd: 'exif', type: TYPE_ASCII, format: 'text' }],
  ['ExposureCompensation', { id: 0x9204, ifd: 'exif', type: TYPE_SRATIONAL, format: 'number' }],
  ['MaxApertureValue', { id: 0x9205, ifd: 'exif', type: TYPE_RATIONAL, format: 'number' }],
  ['SubjectDistance', { id: 0x9206, ifd: 'exif', type: TYPE_RATIONAL, format: 'number' }],
  ['MeteringMode', { id: 0x9207, ifd: 'exif', type: TYPE_SHORT, format: 'int' }],
  ['Flash', { id: 0x9209, ifd: 'exif', type: TYPE_SHORT, format: 'int' }],
  ['FocalLength', { id: 0x920a, ifd: 'exif', type: TYPE_RATIONAL, format: 'number' }],
  ['UserComment', { id: 0x9286, ifd: 'exif', type: TYPE_UNDEFINED, format: 'userComment' }],
  ['WhiteBalance', { id: 0xa403, ifd: 'exif', type: TYPE_SHORT, format: 'int' }],
  ['DigitalZoomRatio', { id: 0xa404, ifd: 'exif', type: TYPE_RATIONAL, format: 'number' }],
  ['FocalLengthIn35mmFormat', { id: 0xa405, ifd: 'exif', type: TYPE_SHORT, format: 'int' }],
  ['SceneCaptureType', { id: 0xa406, ifd: 'exif', type: TYPE_SHORT, format: 'int' }],
  ['Contrast', { id: 0xa408, ifd: 'exif', type: TYPE_SHORT, format: 'int' }],
  ['Saturation', { id: 0xa409, ifd: 'exif', type: TYPE_SHORT, format: 'int' }],
  ['Sharpness', { id: 0xa40a, ifd: 'exif', type: TYPE_SHORT, format: 'int' }],
  ['OwnerName', { id: 0xa430, ifd: 'exif', type: TYPE_ASCII, format: 'text' }],
  ['SerialNumber', { id: 0xa431, ifd: 'exif', type: TYPE_ASCII, format: 'text' }],
  ['LensMake', { id: 0xa433, ifd: 'exif', type: TYPE_ASCII, format: 'text' }],
  ['LensModel', { id: 0xa434, ifd: 'exif', type: TYPE_ASCII, format: 'text' }],
  ['LensSerialNumber', { id: 0xa435, ifd: 'exif', type: TYPE_ASCII, format: 'text' }],
  /* --- GPS IFD --- */
  ['GPSLatitudeRef', { id: TAG_GPS_LATITUDE_REF, ifd: 'gps', type: TYPE_ASCII, format: 'ref' }],
  ['GPSLatitude', { id: TAG_GPS_LATITUDE, ifd: 'gps', type: TYPE_RATIONAL, format: 'gpsCoord' }],
  ['GPSLongitudeRef', { id: TAG_GPS_LONGITUDE_REF, ifd: 'gps', type: TYPE_ASCII, format: 'ref' }],
  ['GPSLongitude', { id: TAG_GPS_LONGITUDE, ifd: 'gps', type: TYPE_RATIONAL, format: 'gpsCoord' }],
  ['GPSAltitudeRef', { id: TAG_GPS_ALTITUDE_REF, ifd: 'gps', type: TYPE_BYTE, format: 'ref' }],
  ['GPSAltitude', { id: TAG_GPS_ALTITUDE, ifd: 'gps', type: TYPE_RATIONAL, format: 'gpsAltitude' }],
  ['GPSImgDirectionRef', { id: 0x0010, ifd: 'gps', type: TYPE_ASCII, format: 'ref' }],
  ['GPSImgDirection', { id: 0x0011, ifd: 'gps', type: TYPE_RATIONAL, format: 'number' }],
]);

/** tag 编号 → 名字（按 IFD 分开：同一编号在 IFD0 与 GPS 里含义不同） */
const REVERSE_TABLE = new Map<TiffIfd, Map<number, string>>(
  IFD_NAMES.map((ifd) => [ifd, new Map<number, string>()]),
);
for (const [name, spec] of TAG_TABLE) REVERSE_TABLE.get(spec.ifd)!.set(spec.id, name);

/** EXIF_FIELDS 里的可编辑 tag 名集合 */
const EDITABLE_TAGS: ReadonlySet<string> = new Set(EXIF_FIELDS.map((field) => field.tag));

/** 由本模块与 GPS 本体一并托管的伴随 tag：不参与「未知字段」计数 */
const MANAGED_COMPANION_TAGS: ReadonlySet<string> = new Set([
  'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef', 'GPSAltitudeRef',
]);

/**
 * EXIF_FIELDS 里存在、但**不属于 EXIF APP1(TIFF)** 的字段（实测归属，见 exiftool -G1 探测）：
 *   ColorTemperature → XMP-crs、Category → IPTC、Subject → XMP-dc、Rating → XMP-xmp。
 * 这些值住在 XMP / IPTC 段里，纯 TIFF 编解码器装不下 —— 写入时明确报错，不做静默丢弃。
 */
const NOT_TIFF_HINT = new Map<string, string>([
  ['ColorTemperature', 'XMP-crs'],
  ['Category', 'IPTC'],
  ['Subject', 'XMP-dc'],
  ['Rating', 'XMP-xmp'],
]);

/* ========================================================================== */
/* 3. 字节序读写小工具（全部走 DataView，禁止 Buffer / TextDecoder）             */
/* ========================================================================== */

/** 用 subarray 的绝对范围建 DataView：不能漏掉 byteOffset（Node Buffer 常带池偏移） */
function dataViewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readU16(view: DataView, offset: number, le: boolean): number {
  return view.getUint16(offset, le);
}

function readU32(view: DataView, offset: number, le: boolean): number {
  return view.getUint32(offset, le);
}

function readI32(view: DataView, offset: number, le: boolean): number {
  return view.getInt32(offset, le);
}

function writeU16(view: DataView, offset: number, value: number, le: boolean): void {
  view.setUint16(offset, value, le);
}

function writeU32(view: DataView, offset: number, value: number, le: boolean): void {
  view.setUint32(offset, value, le);
}

function writeI32(view: DataView, offset: number, value: number, le: boolean): void {
  view.setInt32(offset, value, le);
}

/* ---------------- 文本编解码（自实现，不依赖 TextEncoder/Decoder） ------------- */

function isAsciiText(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) > 0x7f) return false;
  return true;
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** code point → 字符串（手动处理代理对，避免 String.fromCodePoint 兼容性顾虑） */
function fromCodePoint(code: number): string {
  if (code <= 0xffff) return String.fromCharCode(code);
  const v = code - 0x10000;
  return String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
}

function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    // 高低代理合成一个 code point，否则中文 emoji 会被拆坏
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(out);
}

/** 宽容 UTF-8 解码：非法序列落 U+FFFD，绝不抛错（EXIF 中非法字节很常见） */
function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) { out += String.fromCharCode(b0); i += 1; continue; }
    let code: number;
    let extra: number;
    if (b0 >= 0xc2 && b0 <= 0xdf) { code = b0 & 0x1f; extra = 1; }
    else if (b0 >= 0xe0 && b0 <= 0xef) { code = b0 & 0x0f; extra = 2; }
    else if (b0 >= 0xf0 && b0 <= 0xf4) { code = b0 & 0x07; extra = 3; }
    else { out += '\uFFFD'; i += 1; continue; }
    if (i + extra >= bytes.length) { out += '\uFFFD'; break; }
    let ok = true;
    for (let k = 1; k <= extra; k += 1) {
      const b = bytes[i + k];
      if ((b & 0xc0) !== 0x80) { ok = false; break; }
      code = (code << 6) | (b & 0x3f);
    }
    if (!ok) { out += '\uFFFD'; i += 1; continue; }
    out += fromCodePoint(code);
    i += extra + 1;
  }
  return out;
}

/** ASCII tag 的文本：以第一个 NUL 截断；含 >=0x80 的字节按 UTF-8 解（很多相机/工具这么写） */
function decodeAsciiText(raw: Uint8Array): string {
  let end = raw.length;
  for (let i = 0; i < raw.length; i += 1) if (raw[i] === 0) { end = i; break; }
  const body = raw.subarray(0, end);
  for (let i = 0; i < body.length; i += 1) if (body[i] >= 0x80) return utf8Decode(body);
  return asciiBytesToString(body);
}

function asciiBytesToString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/** ASCII tag 编码：全 ASCII 走单字节；含非 ASCII 则写 UTF-8（EXIF 里事实上的通用做法）+ NUL 结尾 */
function encodeAsciiText(text: string): Uint8Array {
  const body = isAsciiText(text) ? asciiBytes(text) : utf8Bytes(text);
  const out = new Uint8Array(body.length + 1);
  out.set(body, 0);
  return out;
}

/** UTF-16 解码（UserComment 用）：认 BOM，无 BOM 按大端（Exif 规范口径） */
function utf16Decode(bytes: Uint8Array): string {
  let le = false;
  let start = 0;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) { le = true; start = 2; }
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) { start = 2; }
  const units: number[] = [];
  for (let i = start; i + 1 < bytes.length; i += 2) {
    units.push(le ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
  }
  // 末尾 0 是补位，不是字符
  while (units.length > 0 && units[units.length - 1] === 0) units.pop();
  let out = '';
  for (const unit of units) out += String.fromCharCode(unit);
  return out;
}

/** UTF-16BE 编码（UserComment 用，不含 BOM，与 exiftool 一致） */
function utf16beBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out[i * 2] = (code >> 8) & 0xff;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

const USERCOMMENT_ASCII = [0x41, 0x53, 0x43, 0x49, 0x49, 0x00, 0x00, 0x00]; // 'ASCII\0\0\0'
const USERCOMMENT_UNICODE = [0x55, 0x4e, 0x49, 0x43, 0x4f, 0x44, 0x45, 0x00]; // 'UNICODE\0'

/** UserComment：8 字节字符集前缀 + 正文；前缀不认识就整体当 ASCII/UTF-8 解 */
function decodeUserComment(raw: Uint8Array): string {
  if (raw.length >= 8) {
    const head = raw.subarray(0, 8);
    if (sameBytes(head, USERCOMMENT_UNICODE)) return utf16Decode(raw.subarray(8));
    if (sameBytes(head, USERCOMMENT_ASCII)) return decodeAsciiText(raw.subarray(8));
  }
  return decodeAsciiText(raw);
}

function encodeUserComment(text: string): Uint8Array {
  const useUnicode = !isAsciiText(text);
  const prefix = useUnicode ? USERCOMMENT_UNICODE : USERCOMMENT_ASCII;
  const body = useUnicode ? utf16beBytes(text) : asciiBytes(text);
  const out = new Uint8Array(prefix.length + body.length + 1);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

function sameBytes(a: Uint8Array, b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/* ========================================================================== */
/* 4. 数值文本格式化                                                           */
/* ========================================================================== */

/** 去掉小数尾零：'5.60' → '5.6'、'130.0' → '130'；同时把 '-0' 归一成 '0' */
function trimZero(text: string): string {
  const trimmed = text.includes('.') ? text.replace(/\.?0+$/, '') : text;
  return trimmed === '-0' ? '0' : trimmed;
}

function fmtDecimal(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '';
  return trimZero(value.toFixed(digits));
}

/** 快门口径：小于 1 秒且倒数恰为整数 → `1/200`；否则走小数 */
function fmtFraction(num: number, den: number): string {
  if (!den) return '';
  const value = num / den;
  if (!Number.isFinite(value)) return '';
  if (value > 0 && value < 1) {
    const inverse = den / num;
    if (Number.isInteger(inverse)) return `1/${inverse}`;
  }
  return fmtDecimal(value, 6);
}

/* ========================================================================== */
/* 5. TIFF 解析                                                                */
/* ========================================================================== */

interface ParsedEntry {
  tag: number;
  type: number;
  count: number;
  /** 12 字节原始条目（未改动时整条复用 → 逐字节保留） */
  entryBytes: Uint8Array;
  /** 值数据；类型不可识别时为 undefined（此时只做原样透传） */
  raw?: Uint8Array;
}

interface ParsedIfd {
  offset: number;
  next: number;
  entries: ParsedEntry[];
}

interface ParsedTiff {
  byteOrder: 'II' | 'MM';
  bytes: Uint8Array;
  ifd0?: ParsedIfd;
  exif?: ParsedIfd;
  gps?: ParsedIfd;
}

function parseIfd(tiff: Uint8Array, offset: number, le: boolean): ParsedIfd | undefined {
  if (offset === 0) return undefined;
  if (offset + 2 > tiff.length) throw new Error('EXIF 段解析失败：IFD 偏移越界');
  const view = dataViewOf(tiff);
  const count = readU16(view, offset, le);
  if (offset + 2 + count * 12 + 4 > tiff.length) throw new Error('EXIF 段解析失败：IFD 条目越界');

  const entries: ParsedEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = offset + 2 + i * 12;
    const entryBytes = tiff.slice(at, at + 12);
    const tag = readU16(view, at, le);
    const type = readU16(view, at + 2, le);
    const fieldCount = readU32(view, at + 4, le);
    const unit = TYPE_SIZE.get(type);
    let raw: Uint8Array | undefined;
    if (unit !== undefined) {
      const size = unit * fieldCount;
      if (size <= 4) raw = entryBytes.slice(8, 8 + size);
      else {
        const dataOffset = readU32(view, at + 8, le);
        if (dataOffset + size > tiff.length) throw new Error('EXIF 段解析失败：条目数据越界');
        raw = tiff.slice(dataOffset, dataOffset + size);
      }
    }
    entries.push({ tag, type, count: fieldCount, entryBytes, raw });
  }
  return { offset, next: readU32(view, offset + 2 + count * 12, le), entries };
}

/** 从 IFD 里取某个指针 tag 指向的偏移（LONG 或 SHORT 都能认） */
function pointerOf(ifd: ParsedIfd | undefined, tag: number, le: boolean): number {
  if (!ifd) return 0;
  for (const entry of ifd.entries) {
    if (entry.tag !== tag || !entry.raw) continue;
    const view = dataViewOf(entry.raw);
    if (entry.type === TYPE_SHORT) return readU16(view, 0, le);
    return readU32(view, 0, le);
  }
  return 0;
}

function parseTiff(tiff: Uint8Array): ParsedTiff {
  if (tiff.length < 8) throw new Error('EXIF 段解析失败：TIFF 头长度不足 8 字节');
  const order: 'II' | 'MM' | null =
    tiff[0] === 0x49 && tiff[1] === 0x49 ? 'II' : tiff[0] === 0x4d && tiff[1] === 0x4d ? 'MM' : null;
  if (!order) throw new Error('EXIF 段解析失败：TIFF 字节序标识无效');
  const le = order === 'II';
  const view = dataViewOf(tiff);
  if (readU16(view, 2, le) !== 42) throw new Error('EXIF 段解析失败：TIFF 魔数不是 42');

  const result: ParsedTiff = { byteOrder: order, bytes: tiff };
  result.ifd0 = parseIfd(tiff, readU32(view, 4, le), le);
  // ExifIFD / GPS IFD 由 IFD0 里的指针 tag 定位
  result.exif = parseIfd(tiff, pointerOf(result.ifd0, TAG_EXIF_IFD_POINTER, le), le);
  result.gps = parseIfd(tiff, pointerOf(result.ifd0, TAG_GPS_IFD_POINTER, le), le);
  return result;
}

/* ========================================================================== */
/* 6. 值 → 文本（读）                                                          */
/* ========================================================================== */

function readRational(raw: Uint8Array, offset: number, signed: boolean, le: boolean): number {
  const view = dataViewOf(raw);
  const num = signed ? readI32(view, offset, le) : readU32(view, offset, le);
  const den = signed ? readI32(view, offset + 4, le) : readU32(view, offset + 4, le);
  if (!den) return 0;
  return num / den;
}

function readIntValue(type: number, raw: Uint8Array, le: boolean): number {
  const view = dataViewOf(raw);
  if (type === TYPE_SHORT) return readU16(view, 0, le);
  if (type === TYPE_SLONG) return readI32(view, 0, le);
  return readU32(view, 0, le);
}

const DATETIME_RE = /^(\d{4})[-:](\d{2})[-:](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

/** 日期时间 → `YYYY-MM-DD HH:mm:ss`；认不出来就原样返回（不丢信息） */
function readDatetime(raw: Uint8Array): string {
  const text = decodeAsciiText(raw);
  const m = DATETIME_RE.exec(text);
  if (!m) return text;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'}`;
}

/** GPS 十进制度：本体是无符号的，方向靠 Ref 归一（东/北为正） */
function readGpsCoordinate(raw: Uint8Array, negative: boolean, le: boolean): string {
  if (raw.length < 24) return '';
  const deg = readRational(raw, 0, false, le);
  const min = readRational(raw, 8, false, le);
  const sec = readRational(raw, 16, false, le);
  const value = (deg * 3600 + min * 60 + sec) / 3600;
  return fmtDecimal(negative ? -value : value, 6);
}

function readValueText(spec: TagSpec, raw: Uint8Array, le: boolean, negative: boolean): string {
  switch (spec.format) {
    case 'text':
    case 'ref':
      return spec.type === TYPE_BYTE ? `${raw[0] ?? 0}` : decodeAsciiText(raw);
    case 'userComment':
      return decodeUserComment(raw);
    case 'datetime':
      return readDatetime(raw);
    case 'int':
      return `${readIntValue(spec.type, raw, le)}`;
    case 'number':
      return fmtDecimal(readRational(raw, 0, spec.type === TYPE_SRATIONAL, le), 6);
    case 'fraction': {
      // 快门要保留分数形态（1/200），所以直接读分子分母，不能只读小数
      const view = dataViewOf(raw);
      return fmtFraction(readU32(view, 0, le), readU32(view, 4, le));
    }
    case 'gpsCoord':
      return readGpsCoordinate(raw, negative, le);
    case 'gpsAltitude':
      return fmtDecimal(negative ? -readRational(raw, 0, false, le) : readRational(raw, 0, false, le), 6);
  }
}

/* ========================================================================== */
/* 7. 文本 → 值（写）                                                          */
/* ========================================================================== */

interface EncodedValue {
  type: number;
  count: number;
  data: Uint8Array;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) { const t = x % y; x = y; y = t; }
  return x || 1;
}

/** 十进制文本 → 有理数（保留全部有效数字，再用 gcd 约分；避免浮点误差） */
function decimalToRational(text: string, allowNegative: boolean): { num: number; den: number } {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`「${text}」不是有效的数字，请重新填写`);
  const sign = m[1] === '-' ? -1 : 1;
  if (sign < 0 && !allowNegative) throw new Error(`「${text}」不能是负数，请重新填写`);
  const frac = m[3] ?? '';
  const den = 10 ** frac.length;
  const num = sign * Number(`${m[2]}${frac}`);
  if (!Number.isFinite(num)) throw new Error(`「${text}」超出可填写的数值范围`);
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

function parseInteger(text: string): number {
  const value = Number(text.trim());
  if (!Number.isFinite(value)) throw new Error(`「${text}」不是有效的数字，请重新填写`);
  return Math.round(value);
}

/** 把值数据切成条目：<= 4 字节内联，否则追加到数据区 */
function toInlineOrAppend(data: Uint8Array): { inline: Uint8Array; append?: Uint8Array } {
  if (data.length <= 4) {
    const inline = new Uint8Array(4);
    inline.set(data, 0);
    return { inline };
  }
  return { inline: new Uint8Array(4), append: data };
}

function bytesOf(size: number, write: (view: DataView) => void): Uint8Array {
  const out = new Uint8Array(size);
  write(dataViewOf(out));
  return out;
}

function encodeIntValue(type: number, text: string, le: boolean): EncodedValue {
  const value = parseInteger(text);
  if (type === TYPE_SHORT) return { type, count: 1, data: bytesOf(2, (v) => writeU16(v, 0, value, le)) };
  if (type === TYPE_SLONG) return { type, count: 1, data: bytesOf(4, (v) => writeI32(v, 0, value, le)) };
  return { type, count: 1, data: bytesOf(4, (v) => writeU32(v, 0, value, le)) };
}

function encodeRationalValue(type: number, num: number, den: number, le: boolean): EncodedValue {
  const signed = type === TYPE_SRATIONAL;
  const data = bytesOf(8, (v) => {
    if (signed) { writeI32(v, 0, num, le); writeI32(v, 4, den, le); }
    else { writeU32(v, 0, num, le); writeU32(v, 4, den, le); }
  });
  return { type, count: 1, data };
}

/** 快门：既收 `1/200` 也收 `0.005`，两种口径都能落盘 */
function encodeFractionValue(text: string, le: boolean): EncodedValue {
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(text.trim());
  if (frac) {
    const den = Number(frac[2]);
    if (!den) throw new Error('分数的分母不能为 0，请重新填写');
    return encodeRationalValue(TYPE_RATIONAL, Number(frac[1]), den, le);
  }
  const { num, den } = decimalToRational(text, false);
  return encodeRationalValue(TYPE_RATIONAL, num, den, le);
}

function encodeDatetimeValue(text: string): EncodedValue {
  const matched = DATETIME_RE.exec(text.trim());
  if (!matched) throw new Error(`「${text}」不是有效的日期时间，请重新填写`);
  const [, year, month, day, hour, minute, second = '00'] = matched;
  // 允许 0000:00:00 这类「空时间」原样往返（cameras/工具会写这种占位值）
  const padded = `${year}:${month}:${day} ${hour}:${minute}:${second}`;
  const data = encodeAsciiText(padded);
  return { type: TYPE_ASCII, count: data.length, data };
}

/** GPS 经纬度：十进制度（东/北为正）→ 无符号的 度/分/秒 三个 RATIONAL */
function encodeGpsCoordValue(text: string, le: boolean): EncodedValue {
  const value = Number(text.trim());
  if (!Number.isFinite(value)) throw new Error(`「${text}」不是有效的数字，请重新填写`);
  if (Math.abs(value) > 180) throw new Error(`纬度 / 经度需在 ±180 度以内：「${text}」`);
  const micro = Math.round(Math.abs(value) * 1e6); // 微度整数，避免浮点拆分出错
  const deg = Math.floor(micro / 1e6);
  const rem = micro - deg * 1e6;
  const min = Math.floor((rem * 60) / 1e6);
  const secMicro = (rem * 60 - min * 1e6) * 60;
  const secGcd = gcd(secMicro, 1e6);
  const data = bytesOf(24, (v) => {
    writeU32(v, 0, deg, le); writeU32(v, 4, 1, le);
    writeU32(v, 8, min, le); writeU32(v, 12, 1, le);
    writeU32(v, 16, secMicro / secGcd, le); writeU32(v, 20, 1e6 / secGcd, le);
  });
  return { type: TYPE_RATIONAL, count: 3, data };
}

function encodeGpsAltitudeValue(text: string, le: boolean): EncodedValue {
  const value = Number(text.trim());
  if (!Number.isFinite(value)) throw new Error(`「${text}」不是有效的数字，请重新填写`);
  const { num, den } = decimalToRational(String(Math.abs(value)), false);
  return encodeRationalValue(TYPE_RATIONAL, num, den, le);
}

function encodeRefValue(type: number, text: string): EncodedValue {
  if (type === TYPE_BYTE) {
    const value = parseInteger(text);
    return { type, count: 1, data: bytesOf(1, (v) => v.setUint8(0, value)) };
  }
  const data = encodeAsciiText(text);
  return { type: TYPE_ASCII, count: data.length, data };
}

function encodeValue(spec: TagSpec, text: string, le: boolean): EncodedValue {
  switch (spec.format) {
    case 'text': {
      const data = encodeAsciiText(text);
      return { type: spec.type, count: data.length, data };
    }
    case 'ref':
      return encodeRefValue(spec.type, text);
    case 'userComment': {
      const data = encodeUserComment(text);
      return { type: TYPE_UNDEFINED, count: data.length, data };
    }
    case 'datetime':
      return encodeDatetimeValue(text);
    case 'int':
      return encodeIntValue(spec.type, text, le);
    case 'number': {
      const { num, den } = decimalToRational(text, spec.type === TYPE_SRATIONAL);
      return encodeRationalValue(spec.type, num, den, le);
    }
    case 'fraction':
      return encodeFractionValue(text, le);
    case 'gpsCoord':
      return encodeGpsCoordValue(text, le);
    case 'gpsAltitude':
      return encodeGpsAltitudeValue(text, le);
  }
}

/* ========================================================================== */
/* 8. JPEG 段定位                                                              */
/* ========================================================================== */

interface JpegLayout {
  /** 已存在的 EXIF APP1 段范围 [start, end)；无则 undefined */
  segment?: { start: number; end: number };
  /** 已存在的 EXIF TIFF 字节；无则空数组 */
  tiff: Uint8Array;
  /** 无 EXIF 段时的插入位置（SOI 之后；若紧跟 APP0/JFIF 则插到它后面） */
  insertAt: number;
}

/**
 * 扫 JPEG marker 链，定位 EXIF APP1。
 * 遇 SOS(0xDA) 即停 —— 之后是压缩数据，按字节扫会被误判成 marker。
 */
function locateJpeg(bytes: Uint8Array): JpegLayout {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new NotJpegError();
  const view = dataViewOf(bytes);
  let pos = 2;
  let insertAt = 2;
  let result: JpegLayout = { tiff: new Uint8Array(0), insertAt };

  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) break;
    let markerAt = pos + 1;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt += 1; // 填充字节
    if (markerAt >= bytes.length) break;
    const marker = bytes[markerAt];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos = markerAt + 1; continue; }
    if (marker === 0xda) break;
    const length = readU16(view, markerAt + 1, false);
    if (length < 2 || markerAt + 1 + length > bytes.length) break;
    const segmentEnd = markerAt + 1 + length;
    if (marker === 0xe1) {
      const payloadAt = markerAt + 3;
      const isExif = payloadAt + 6 <= segmentEnd &&
        bytes[payloadAt] === 0x45 && bytes[payloadAt + 1] === 0x78 &&
        bytes[payloadAt + 2] === 0x69 && bytes[payloadAt + 3] === 0x66 &&
        bytes[payloadAt + 4] === 0x00 && bytes[payloadAt + 5] === 0x00;
      if (isExif) {
        result = {
          segment: { start: pos, end: segmentEnd },
          tiff: bytes.slice(payloadAt + 6, segmentEnd),
          insertAt,
        };
        return result;
      }
    }
    // JFIF 必须排在最前，EXIF 插它后面；不能反过来把 APP0 挤到 APP1 之后
    if (marker === 0xe0 && pos === 2) insertAt = segmentEnd;
    result.insertAt = insertAt;
    pos = segmentEnd;
  }
  return result;
}

/** 拼一个完整的 EXIF APP1 段：FF E1 + 长度 + 'Exif\0\0' + TIFF */
function buildExifSegment(tiff: Uint8Array): Uint8Array {
  const payloadLength = 6 + tiff.length;
  if (payloadLength > 0xfffd) {
    throw new Error('拍摄信息过多（超过 64KB 上限），无法保存；可以先移除内嵌缩略图后重试');
  }
  const out = new Uint8Array(4 + payloadLength);
  const view = dataViewOf(out);
  out[0] = 0xff;
  out[1] = 0xe1;
  writeU16(view, 2, payloadLength + 2, false);
  out.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4);
  out.set(tiff, 10);
  return out;
}

/* ========================================================================== */
/* 9. TIFF 重建                                                                */
/* ========================================================================== */

interface OutEntry {
  tag: number;
  type: number;
  count: number;
  /** 未改动条目：12 字节原样复用（此时 inline/append/tablePointer 均忽略） */
  verbatim?: Uint8Array;
  /** 内联 4 字节值域 */
  inline: Uint8Array;
  /** 需要追加到数据区的值字节（长度 > 4） */
  append?: Uint8Array;
  /** 值域须改写成某张新表的偏移 */
  tablePointer?: 'exif' | 'gps';
  /** append 的数据区偏移（序列化时回填） */
  dataOffset?: number;
}

function entryFromEncoded(tag: number, encoded: EncodedValue): OutEntry {
  const { inline, append } = toInlineOrAppend(encoded.data);
  return { tag, type: encoded.type, count: encoded.count, inline, append };
}

function removeTag(entries: OutEntry[], tag: number): void {
  for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i].tag === tag) entries.splice(i, 1);
}

function keepEntry(entry: ParsedEntry): OutEntry {
  return {
    tag: entry.tag,
    type: entry.type,
    count: entry.count,
    verbatim: entry.entryBytes,
    inline: new Uint8Array(4),
  };
}

function writeIfd(
  out: Uint8Array,
  view: DataView,
  at: number,
  entries: readonly OutEntry[],
  next: number,
  le: boolean,
  tables: { exif?: number; gps?: number },
): void {
  writeU16(view, at, entries.length, le);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const pos = at + 2 + i * 12;
    if (entry.verbatim) { out.set(entry.verbatim, pos); continue; }
    writeU16(view, pos, entry.tag, le);
    writeU16(view, pos + 2, entry.type, le);
    if (entry.tablePointer) {
      writeU32(view, pos + 4, 1, le);
      writeU32(view, pos + 8, tables[entry.tablePointer] ?? 0, le);
      continue;
    }
    writeU32(view, pos + 4, entry.count, le);
    if (entry.append) writeU32(view, pos + 8, entry.dataOffset ?? 0, le);
    else out.set(entry.inline, pos + 8);
  }
  writeU32(view, at + 2 + entries.length * 12, next, le);
}

const ifdSize = (count: number): number => 2 + count * 12 + 4;

/**
 * 重建 TIFF：前 8 字节新头 + 原 TIFF 正文原样 + 新表 + 新数据。
 * `nextIfd0` 沿用原 IFD0 的 next 指针（指向 IFD1 缩略图），缩略图因此免于重建。
 */
function serializeTiff(
  order: 'II' | 'MM',
  originalTiff: Uint8Array,
  ifd0: OutEntry[],
  exif: OutEntry[],
  gps: OutEntry[],
  nextIfd0: number,
  nextExif: number,
  nextGps: number,
): Uint8Array {
  const le = order === 'II';
  const headerLength = 8;
  const ifd0Offset = Math.max(headerLength, originalTiff.length);
  const exifOffset = exif.length > 0 ? ifd0Offset + ifdSize(ifd0.length) : 0;
  const afterExif = exif.length > 0 ? exifOffset + ifdSize(exif.length) : ifd0Offset + ifdSize(ifd0.length);
  const gpsOffset = gps.length > 0 ? afterExif : 0;

  // 数据区紧跟在所有新表之后；2 字节对齐，兼容要求字对齐的老解析器
  let cursor = afterExif + (gps.length > 0 ? ifdSize(gps.length) : 0);
  const groups = [ifd0, exif, gps];
  for (const group of groups) {
    for (const entry of group) {
      if (!entry.append) continue;
      if (cursor % 2 !== 0) cursor += 1;
      entry.dataOffset = cursor;
      cursor += entry.append.length;
    }
  }

  const out = new Uint8Array(cursor);
  const view = dataViewOf(out);
  out[0] = le ? 0x49 : 0x4d;
  out[1] = le ? 0x49 : 0x4d;
  writeU16(view, 2, 42, le);
  writeU32(view, 4, ifd0Offset, le);
  if (originalTiff.length > headerLength) out.set(originalTiff.subarray(headerLength), headerLength);

  writeIfd(out, view, ifd0Offset, ifd0, nextIfd0, le, { exif: exifOffset, gps: gpsOffset });
  if (exif.length > 0) writeIfd(out, view, exifOffset, exif, nextExif, le, {});
  if (gps.length > 0) writeIfd(out, view, gpsOffset, gps, nextGps, le, {});
  for (const group of groups) {
    for (const entry of group) if (entry.append) out.set(entry.append, entry.dataOffset ?? 0);
  }
  return out;
}

/* ========================================================================== */
/* 10. 对外：读                                                               */
/* ========================================================================== */

/** 读：仅支持 JPEG（读 APP1/TIFF）；非 JPEG 抛 NotJpegError */
export function readLocalExif(bytes: Uint8Array): LocalExifDocument {
  const layout = locateJpeg(bytes);
  if (!layout.segment || layout.tiff.length === 0) {
    // 合法 JPEG 但没带 EXIF：返回空文档；字节序给默认小端（这也是新建文档时的既定口径）
    return { format: 'jpeg', byteOrder: 'II', values: {}, unknownCount: 0 };
  }
  const parsed = parseTiff(layout.tiff);
  return { format: 'jpeg', byteOrder: parsed.byteOrder, values: collectValues(parsed), unknownCount: countUnknown(parsed) };
}

/** 某 IFD 内 tag → 条目 */
function indexIfd(ifd: ParsedIfd | undefined): Map<number, ParsedEntry> {
  const map = new Map<number, ParsedEntry>();
  if (ifd) for (const entry of ifd.entries) if (!map.has(entry.tag)) map.set(entry.tag, entry);
  return map;
}

function collectValues(parsed: ParsedTiff): Record<string, string> {
  const le = parsed.byteOrder === 'II';
  const indexes = new Map<TiffIfd, Map<number, ParsedEntry>>([
    ['ifd0', indexIfd(parsed.ifd0)],
    ['exif', indexIfd(parsed.exif)],
    ['gps', indexIfd(parsed.gps)],
  ]);
  const gps = indexes.get('gps')!;
  // 方向 tag 决定本体正负：南纬/西经/海平面以下本体同样是无符号的
  const negativeRef = new Map<string, string>([
    ['GPSLatitude', decodeRefText(gps.get(TAG_GPS_LATITUDE_REF))],
    ['GPSLongitude', decodeRefText(gps.get(TAG_GPS_LONGITUDE_REF))],
    ['GPSAltitude', decodeRefText(gps.get(TAG_GPS_ALTITUDE_REF)) === '1' ? '1' : '0'],
  ]);

  const values: Record<string, string> = {};
  for (const [name, spec] of TAG_TABLE) {
    // 归属表优先；某些机身在「别的表」里也放了同名 tag，此处再回退查找一轮
    const entry = indexes.get(spec.ifd)!.get(spec.id) ??
      IFD_NAMES.map((ifd) => indexes.get(ifd)!.get(spec.id)).find((found) => found !== undefined);
    if (!entry?.raw) continue;
    const isNegative = name === 'GPSLatitude' ? negativeRef.get(name) === 'S'
      : name === 'GPSLongitude' ? negativeRef.get(name) === 'W'
        : name === 'GPSAltitude' ? negativeRef.get(name) === '1'
          : false;
    values[name] = readValueText(spec, entry.raw, le, isNegative);
  }
  return values;
}

function decodeRefText(entry: ParsedEntry | undefined): string {
  if (!entry?.raw) return '';
  return entry.type === TYPE_BYTE ? `${entry.raw[0] ?? 0}` : decodeAsciiText(entry.raw).trim();
}

/** 「原样保留 N 个未知字段」：三者主表里除结构指针外、既不在 EXIF_FIELDS 也不由本模块托管的 tag */
function countUnknown(parsed: ParsedTiff): number {
  const pointers = new Set<number>([TAG_EXIF_IFD_POINTER, TAG_GPS_IFD_POINTER, TAG_INTEROP_POINTER]);
  let count = 0;
  for (const ifd of IFD_NAMES) {
    const parsedIfd = ifd === 'ifd0' ? parsed.ifd0 : ifd === 'exif' ? parsed.exif : parsed.gps;
    if (!parsedIfd) continue;
    for (const entry of parsedIfd.entries) {
      if (pointers.has(entry.tag)) continue;
      const name = REVERSE_TABLE.get(ifd)!.get(entry.tag);
      if (name && (EDITABLE_TAGS.has(name) || MANAGED_COMPANION_TAGS.has(name))) continue;
      count += 1;
    }
  }
  return count;
}

/* ========================================================================== */
/* 11. 对外：写                                                               */
/* ========================================================================== */

/** 未登记的 patch 字段：区分「XMP/IPTC 容器字段」与「拼错/未知字段」，两种都给出可读原因 */
function unsupportedTagError(name: string): Error {
  const container = NOT_TIFF_HINT.get(name);
  if (container) {
    return new Error(`「${name}」保存在 ${container} 分区里，本工具暂不支持修改，它会随照片原样保留`);
  }
  return new Error(`无法识别的拍摄参数名：${name}`);
}

/**
 * 重建 TIFF 字节（**不含容器封装**）：这条逻辑与「文件是 JPEG 还是 PNG」无关，
 * 因此抽出来给两条写路径共用 —— JPEG 写入 APP1 段，PNG 写入 eXIf 块。
 *
 * 返回 null 表示「原本就没有 EXIF，且这次也没写出任何内容」→ 调用方应保持原文件不变，
 * 不应额外构造一个空 TIFF（空表会让部分解析器报错）。
 */
export function buildPatchedTiff(tiff: Uint8Array, patch: Record<string, string | null>): Uint8Array | null {
  const hadExif = tiff.length > 0;
  const parsed = hadExif ? parseTiff(tiff) : undefined;
  const order = parsed?.byteOrder ?? 'II';
  const le = order === 'II';

  // 建表：未涉及的条目一律 verbatim 复用，保证字节级不变
  const table: Record<TiffIfd, OutEntry[]> = {
    ifd0: parsed?.ifd0?.entries.map(keepEntry) ?? [],
    exif: parsed?.exif?.entries.map(keepEntry) ?? [],
    gps: parsed?.gps?.entries.map(keepEntry) ?? [],
  };

  for (const [name, value] of Object.entries(patch)) {
    const spec = TAG_TABLE.get(name);
    if (!spec) throw unsupportedTagError(name);
    // 先彻底摘掉（含被放在别的表里的同名 tag），避免写出重复 tag
    for (const ifd of IFD_NAMES) removeTag(table[ifd], spec.id);
    if (value === null) continue;
    table[spec.ifd].push(entryFromEncoded(spec.id, encodeValue(spec, value, le)));
  }

  applyGpsLinkage(patch, table, le);
  ensureGpsVersion(table.gps);
  // 结构指针：目标表非空才写，偏移由序列化阶段回填
  removeTag(table.ifd0, TAG_EXIF_IFD_POINTER);
  removeTag(table.ifd0, TAG_GPS_IFD_POINTER);
  if (table.exif.length > 0) {
    table.ifd0.push({ tag: TAG_EXIF_IFD_POINTER, type: TYPE_LONG, count: 1, inline: new Uint8Array(4), tablePointer: 'exif' });
  }
  if (table.gps.length > 0) {
    table.ifd0.push({ tag: TAG_GPS_IFD_POINTER, type: TYPE_LONG, count: 1, inline: new Uint8Array(4), tablePointer: 'gps' });
  }
  for (const ifd of IFD_NAMES) table[ifd].sort((a, b) => a.tag - b.tag);

  // 原本没有 EXIF 且这次也没写出任何内容 → 不去凭空造一个空 TIFF
  if (!hadExif && table.ifd0.length === 0 && table.exif.length === 0 && table.gps.length === 0) return null;

  return serializeTiff(
    order,
    tiff,
    table.ifd0,
    table.exif,
    table.gps,
    // next 指针沿用原值：原 IFD1 与缩略图字节都在原偏移上，指针依旧有效
    parsed?.ifd0?.next ?? 0,
    parsed?.exif?.next ?? 0,
    parsed?.gps?.next ?? 0,
  );
}

/** 写：patch 中 value 为 null 表示删除该 tag；返回新的完整文件字节（不改动入参） */
export function applyLocalExifPatch(bytes: Uint8Array, patch: Record<string, string | null>): Uint8Array {
  const layout = locateJpeg(bytes);
  const tiff = buildPatchedTiff(layout.tiff, patch);
  if (tiff === null) return bytes.slice();
  return spliceExifSegment(bytes, layout, buildExifSegment(tiff));
}

/** 把新 APP1 段替换/插入进原 JPEG，其余字节逐字节照搬（含 SOS 之后的压缩数据） */
function spliceExifSegment(bytes: Uint8Array, layout: JpegLayout, segment: Uint8Array): Uint8Array {
  if (layout.segment) {
    const { start, end } = layout.segment;
    const out = new Uint8Array(bytes.length - (end - start) + segment.length);
    out.set(bytes.subarray(0, start), 0);
    out.set(segment, start);
    out.set(bytes.subarray(end), start + segment.length);
    return out;
  }
  const at = layout.insertAt;
  const out = new Uint8Array(bytes.length + segment.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(segment, at);
  out.set(bytes.subarray(at), at + segment.length);
  return out;
}

/** GPS 联动：写本体时同步 Ref（口径对齐 photos.service.ts 的「本体无符号 + 方向单独写」） */
function applyGpsLinkage(patch: Record<string, string | null>, table: Record<TiffIfd, OutEntry[]>, le: boolean): void {
  const coords: ReadonlyArray<readonly [string, string, string, string]> = [
    ['GPSLatitude', 'GPSLatitudeRef', 'N', 'S'],
    ['GPSLongitude', 'GPSLongitudeRef', 'E', 'W'],
  ];
  for (const [valueTag, refTag, positive, negative] of coords) {
    if (!(valueTag in patch)) continue;
    const refSpec = TAG_TABLE.get(refTag)!;
    removeTag(table.gps, refSpec.id);
    const value = patch[valueTag];
    if (value === null) continue; // 清除定位时一并清除 Ref
    const refText = Number(value) < 0 ? negative : positive;
    table.gps.push(entryFromEncoded(refSpec.id, encodeValue(refSpec, refText, le)));
  }

  if (!('GPSAltitude' in patch)) return;
  const altRefSpec = TAG_TABLE.get('GPSAltitudeRef')!;
  removeTag(table.gps, altRefSpec.id);
  const altitude = patch.GPSAltitude;
  if (altitude === null) return;
  // 海拔本体同样无符号：0 = 海平面以上，1 = 以下
  table.gps.push(entryFromEncoded(altRefSpec.id, encodeValue(altRefSpec, Number(altitude) < 0 ? '1' : '0', le)));
}

/** GPS IFD 必须有 GPSVersionID，否则部分解析器不认整张 GPS 表 */
function ensureGpsVersion(entries: OutEntry[]): void {
  if (entries.length === 0) return;
  for (const entry of entries) if (entry.tag === TAG_GPS_VERSION_ID) return;
  entries.push(entryFromEncoded(TAG_GPS_VERSION_ID, { type: TYPE_BYTE, count: 4, data: Uint8Array.from([2, 3, 0, 0]) }));
}

/* ========================================================================== */
/* 12. 供上层复用的内部件                                                       */
/* ========================================================================== */

/**
 * 为什么要把这些内部件导出：PNG(eXIf) 与 RAW(TIFF) 两条新路径要在**同一套 TIFF 解析/编码**上施工。
 * 复制一份会带来「两处口径迟早分叉」的隐患，因此这里做单一事实源，只加 export、不改任何函数体。
 * 约定：这些符号属于编解码器内部细节，仅供 packages/core 内部与本地工具层使用，
 * 上层不应把它们当作稳定 API 直接消费。
 */
export {
  /* 类型常量与尺寸表 */
  TYPE_BYTE,
  TYPE_ASCII,
  TYPE_SHORT,
  TYPE_LONG,
  TYPE_RATIONAL,
  TYPE_UNDEFINED,
  TYPE_SLONG,
  TYPE_SRATIONAL,
  TYPE_SIZE,
  /* tag 归属表与结构指针 */
  TAG_TABLE,
  IFD_NAMES,
  TAG_EXIF_IFD_POINTER,
  TAG_GPS_IFD_POINTER,
  TAG_INTEROP_POINTER,
  TAG_GPS_VERSION_ID,
  /* 字节序读写工具 */
  dataViewOf,
  readU16,
  readU32,
  readI32,
  writeU16,
  writeU32,
  writeI32,
  /* TIFF 解析 */
  parseIfd,
  parseTiff,
  pointerOf,
  collectValues,
  countUnknown,
  readValueText,
  /* TIFF 编码 */
  encodeValue,
  toInlineOrAppend,
  unsupportedTagError,
  /* TIFF 重建（PNG 路径复用） */
  serializeTiff,
  entryFromEncoded,
  keepEntry,
  removeTag,
  applyGpsLinkage,
  ensureGpsVersion,
  ifdSize,
};
export type { TagSpec, TiffIfd, ParsedEntry, ParsedIfd, ParsedTiff, EncodedValue, OutEntry };
