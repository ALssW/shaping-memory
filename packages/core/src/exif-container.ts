/**
 * packages/core/src/exif-container.ts
 *
 * 容器层：认出「这个文件到底是什么」并给出各容器的结构定位 —— EXIF 读写的最外层地基。
 *
 * 【为什么需要它】原来 `exif-io.ts` 假定输入一定是 JPEG，非 JPEG 直接抛 NotJpegError。
 * 现在要支持 PNG(写 eXIf 块) 与 RAW/TIFF(如 NEF)，就得先分清三种容器的骨架：
 *   - JPEG：`FF D8` 开头，EXIF 住在 `FF E1 + 'Exif\0\0'` 的 APP1 段里；
 *   - PNG ：`89 50 4E 47 0D 0A 1A 0A` 开头，EXIF 住在 `eXIf` 块里，块内是**裸 TIFF**（无 'Exif\0\0' 前缀）；
 *   - TIFF/RAW：`II*\0` 或 `MM\0*` 开头，**整个文件本身就是 TIFF**（NEF / CR2 / ARW / DNG / ORF 皆如此）。
 *
 * 【为什么也放在 core】Web 与 RN 两端都要在同一份「容器判断」上做文案与可编辑性判断，
 * 写在两端就会分叉。本文件只用到 Uint8Array / DataView，RN 里同样能跑。
 *
 * 【不做静默降级】认不出来就是 'other'，绝不猜；PNG 结构越界直接抛可读错误。
 */
import {
  dataViewOf,
  parseIfd,
  parseTiff,
  readU32,
  TYPE_LONG,
  TYPE_SIZE,
} from './exif-io';
import type { ParsedEntry, ParsedIfd } from './exif-io';

/* ========================================================================== */
/* 1. 容器嗅探                                                                  */
/* ========================================================================== */

export type ContainerKind = 'jpeg' | 'png' | 'tiff' | 'other';

/** 认出容器类型。只读前 8 字节，代价可忽略，可放心在列表里逐张调用 */
export function sniffContainer(bytes: Uint8Array): ContainerKind {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return 'png';
  if (bytes.length >= 4) {
    const le = bytes[0] === 0x49 && bytes[1] === 0x49;
    const be = bytes[0] === 0x4d && bytes[1] === 0x4d;
    // 魔数 42 = 0x2a：小端写 `2a 00`、大端写 `00 2a`
    if (le && bytes[2] === 0x2a && bytes[3] === 0x00) return 'tiff';
    if (be && bytes[2] === 0x00 && bytes[3] === 0x2a) return 'tiff';
  }
  return 'other';
}

const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 认不出的容器（HEIC / WebP / GIF / 损坏文件…）。
 * 【为什么不复用 NotJpegError】那句话在 PNG/TIFF 已经能读写之后就不成立了，
 * 再拿它表示「格式不支持」会使使用者误判为「仅 JPEG 可用」。单独一个错误才能给出准确文案。
 */
export class UnsupportedContainerError extends Error {
  constructor(message = '暂时无法处理这种图片格式，目前支持 JPEG / PNG / RAW(含 NEF)') {
    super(message);
    this.name = 'UnsupportedContainerError';
  }
}

/** 容器 → 给浏览器下载时用的 MIME（Blob 的 type）；认不出时退回通用二进制流 */
export function mimeOfContainer(kind: ContainerKind): string {
  if (kind === 'jpeg') return 'image/jpeg';
  if (kind === 'png') return 'image/png';
  if (kind === 'tiff') return 'image/tiff';
  return 'application/octet-stream';
}

/* ========================================================================== */
/* 2. PNG 块结构                                                                */
/* ========================================================================== */

interface PngChunk {
  /** 块起点（长度字段的第一个字节） */
  start: number;
  /** 块终点（CRC 之后），即下一块起点 */
  end: number;
  type: string;
  /** 数据段起点 / 长度 */
  dataStart: number;
  dataLength: number;
}

/** 读一个块的类型字符串（块内偏移 +4..+8） */
function chunkTypeOf(bytes: Uint8Array, start: number): string {
  let type = '';
  for (let i = 4; i < 8; i += 1) type += String.fromCharCode(bytes[start + i] ?? 0);
  return type;
}

/**
 * 解析块链。遇 IDAT 即停 —— IDAT 之后按规范不再允许出现 eXIf，
 * 而且后面是类似 base64 的压缩流，继续扫描只会读到无效的长度值。
 */
function walkPngChunks(bytes: Uint8Array): PngChunk[] {
  if (sniffContainer(bytes) !== 'png') throw new Error('不是 PNG 文件：签名不匹配');
  const view = dataViewOf(bytes);
  const chunks: PngChunk[] = [];
  let pos = PNG_SIGNATURE.length;
  while (pos + 8 <= bytes.length) {
    const dataLength = readU32(view, pos, false);
    const dataStart = pos + 8;
    const end = dataStart + dataLength + 4; // + CRC
    if (end > bytes.length) throw new Error('PNG 结构异常：块长度越界，已拒绝写入以免损坏文件');
    const type = chunkTypeOf(bytes, pos);
    chunks.push({ start: pos, end, type, dataStart, dataLength });
    pos = end;
    if (type === 'IEND' || type === 'IDAT') break;
  }
  if (chunks.length === 0) throw new Error('PNG 结构异常：没有解析到任何数据块');
  return chunks;
}

export interface PngLayout {
  /** 已存在的 eXIf 块范围（含长度字段与 CRC）；无则 undefined */
  chunk?: { start: number; end: number };
  /** 已存在的 eXIf 块里的**裸 TIFF** 字节（无 'Exif\0\0' 前缀）；无则空数组 */
  tiff: Uint8Array;
  /** 无 eXIf 时的插入位置：紧贴首个 IDAT 之前（规范要求 eXIf 必须在 IDAT 之前） */
  insertAt: number;
}

/** 定位 PNG 的 eXIf 块。全文件只允许一个，因此扫到第一个就收工 */
export function locatePngExif(bytes: Uint8Array): PngLayout {
  const chunks = walkPngChunks(bytes);
  const firstIdat = chunks.find((chunk) => chunk.type === 'IDAT');
  // 保底插入点：没有 IDAT 的畸形文件就插在最后一个已解析块之后
  const fallbackAt = chunks[chunks.length - 1]?.end ?? PNG_SIGNATURE.length;

  const exif = chunks.find((chunk) => chunk.type === 'eXIf');
  if (!exif) return { tiff: new Uint8Array(0), insertAt: firstIdat?.start ?? fallbackAt };

  return {
    chunk: { start: exif.start, end: exif.end },
    tiff: bytes.slice(exif.dataStart, exif.dataStart + exif.dataLength),
    insertAt: firstIdat?.start ?? fallbackAt,
  };
}

/* ========================================================================== */
/* 3. CRC32（PNG 每个块都要）                                                    */
/* ========================================================================== */

/** 预计算 256 项查表：逐位算 8 次太慢，PNG 块动辄几 MB */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

/** 标准 PNG CRC32（多项式 0xEDB88320），算 [start, end) 区间 */
export function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/* ========================================================================== */
/* 4. TIFF / RAW 结构遍历                                                       */
/* ========================================================================== */

/** SubIFDs 指针：指向「子图像」表数组（NEF 的 JpgFromRaw 与像素数据都在这里） */
const TAG_SUB_IFDS = 0x014a;
/** 缩略图/预览图的 JPEG 偏移与长度（在 SubIFD 里 exiftool 叫 JpgFromRawStart/Length） */
const TAG_JPEG_OFFSET = 0x0201;
const TAG_JPEG_LENGTH = 0x0202;
/** 像素数据：条带 / 瓦片 */
const TAG_STRIP_OFFSETS = 0x0111;
const TAG_STRIP_BYTE_COUNTS = 0x0117;
const TAG_TILE_OFFSETS = 0x0144;
const TAG_TILE_BYTE_COUNTS = 0x0145;
const TAG_MAKER_NOTE = 0x927c;

export type IfdOrigin = 'ifd0' | 'exif' | 'gps' | 'subifd' | 'next';

export interface TiffIfdView {
  /** 表的绝对偏移 */
  offset: number;
  /** 表尾的 next 指针指向的偏移 */
  next: number;
  entries: ParsedEntry[];
  /** 每条目 12 字节起点的绝对偏移，与 entries 一一对应（写回时要按绝对位置改写） */
  entryOffsets: number[];
  origin: IfdOrigin;
}

/** 遍历上限：真文件里可达 IFD 也就十来张，这个数只为防畸形文件把内存吃光 */
const MAX_IFD_WALK = 64;

/**
 * 遍历**所有可达 IFD**：IFD0 → ExifIFD / GPS（由指针 tag 抵达）→ SubIFDs 数组 → IFD0.next 链（IFD1）。
 * 【为什么要全遍历】① 找内嵌预览（在 SubIFD 里）；② 圈定像素数据范围做保护；
 * ③ 写回前反查「是否有别的表用绝对偏移引用了计划搬迁的表」。
 * 结构越界会抛可读错误 —— 调用方要么据此拒绝写入，要么包一层 try/catch 降级。
 */
export function walkTiffIfds(bytes: Uint8Array): TiffIfdView[] {
  const parsed = parseTiff(bytes);
  const le = parsed.byteOrder === 'II';
  const views: TiffIfdView[] = [];
  const seen = new Set<number>();

  const push = (ifd: ParsedIfd | undefined, origin: IfdOrigin): TiffIfdView | undefined => {
    if (!ifd || seen.has(ifd.offset)) return undefined;
    seen.add(ifd.offset);
    const view: TiffIfdView = {
      offset: ifd.offset,
      next: ifd.next,
      entries: ifd.entries,
      entryOffsets: ifd.entries.map((_, index) => ifd.offset + 2 + index * 12),
      origin,
    };
    views.push(view);
    return view;
  };

  push(parsed.ifd0, 'ifd0');
  push(parsed.exif, 'exif');
  push(parsed.gps, 'gps');

  // IFD0.next 链 = IFD1（缩略图）；SubIFDs 是「数组」，两者都可能继续带出下一层
  const queue: Array<{ offset: number; origin: IfdOrigin }> = [];
  if (parsed.ifd0?.next) queue.push({ offset: parsed.ifd0.next, origin: 'next' });
  for (const view of views) for (const offset of subIfdOffsetsOf(view, le)) queue.push({ offset, origin: 'subifd' });

  while (queue.length > 0 && views.length < MAX_IFD_WALK) {
    const item = queue.shift()!;
    if (seen.has(item.offset) || item.offset === 0) continue;
    const view = push(parseIfd(bytes, item.offset, le), item.origin);
    if (!view) continue;
    if (view.next) queue.push({ offset: view.next, origin: 'next' });
    for (const offset of subIfdOffsetsOf(view, le)) queue.push({ offset, origin: 'subifd' });
  }

  return views;
}

/** 取某条目的多值 LONG 数组（SubIFDs / 条带偏移都是这种形态）；类型不符返回空数组 */
function longArrayOf(entry: ParsedEntry | undefined, le: boolean): number[] {
  if (!entry?.raw || entry.type !== TYPE_LONG) return [];
  const view = dataViewOf(entry.raw);
  const out: number[] = [];
  for (let i = 0; i < entry.count; i += 1) out.push(readU32(view, i * 4, le));
  return out;
}

function entryOf(view: TiffIfdView, tag: number): ParsedEntry | undefined {
  return view.entries.find((entry) => entry.tag === tag);
}

function subIfdOffsetsOf(view: TiffIfdView, le: boolean): number[] {
  return longArrayOf(entryOf(view, TAG_SUB_IFDS), le).filter((offset) => offset > 0);
}

/** 某张表里某个 tag 的单个 LONG 值（偏移/长度这类）；取不到返回 0 */
function longValueOf(view: TiffIfdView, tag: number, le: boolean): number {
  return longArrayOf(entryOf(view, tag), le)[0] ?? 0;
}

/* ========================================================================== */
/* 5. 内嵌预览抽取                                                              */
/* ========================================================================== */

/**
 * 从 RAW / TIFF 里抽出内嵌的 JPEG 预览（NEF 实测：SubIFD 里的 JpgFromRaw 约 900KB）。
 * 【为什么要它】浏览器渲染不了 NEF 本体，列表缩略图必须依赖内嵌 JPEG 才能生成。
 * 取「最大的那张」——预览质量最好，内存代价（每张几百 KB）可以忽略。
 * 结构异常时返回 null（缩略图退化成相机占位图标），不影响主流程。
 */
export function extractEmbeddedPreview(bytes: Uint8Array): Uint8Array | null {
  let best: Uint8Array | null = null;
  try {
    const le = bytes[0] === 0x49 && bytes[1] === 0x49;
    for (const view of walkTiffIfds(bytes)) {
      const preview = jpegIn(view, bytes, le);
      if (preview && (!best || preview.length > best.length)) best = preview;
    }
  } catch {
    return null;
  }
  return best;
}

/** 一张表里若同时有「JPEG 偏移 + 长度」，且落点是合法 JPEG，则切出来 */
function jpegIn(view: TiffIfdView, bytes: Uint8Array, le: boolean): Uint8Array | null {
  const start = longValueOf(view, TAG_JPEG_OFFSET, le);
  const length = longValueOf(view, TAG_JPEG_LENGTH, le);
  if (start <= 0 || length <= 4 || start + length > bytes.length) return null;
  // 必须真的是 JPEG：SubIFD 里有些 0x0201 指向的是别的压缩流
  if (bytes[start] !== 0xff || bytes[start + 1] !== 0xd8) return null;
  return bytes.slice(start, start + length);
}

/* ========================================================================== */
/* 6. 保护区圈定（写回审计用）                                                   */
/* ========================================================================== */

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * 圈出「绝不能被改写」的区域：MakerNotes、像素数据（条带 / 瓦片）、内嵌预览。
 * 【为什么写回审计要它】NEF 里 MakerNotes 与像素数据都靠**绝对偏移**被引用，
 * 一旦这些字节被改动，照片即损坏。审计会拿这份名单逐字节比对新旧文件。
 * 结构越界抛错 —— 调用方据此拒绝写入。
 */
export function protectedRangesOf(bytes: Uint8Array): ByteRange[] {
  const ranges: ByteRange[] = [];
  const le = bytes[0] === 0x49 && bytes[1] === 0x49;

  for (const view of walkTiffIfds(bytes)) {
    // MakerNotes：值本身就是一整块厂商私有结构
    const maker = entryOf(view, TAG_MAKER_NOTE);
    if (maker?.raw && maker.raw.length > 4) {
      ranges.push(effectiveRangeOf(view, maker, le));
    }
    // 像素数据：偏移数组 × 长度数组，逐段圈出
    ranges.push(...stripRanges(view, TAG_STRIP_OFFSETS, TAG_STRIP_BYTE_COUNTS, le));
    ranges.push(...stripRanges(view, TAG_TILE_OFFSETS, TAG_TILE_BYTE_COUNTS, le));
    // 内嵌 JPEG 预览（nudging 它同样会毁掉预览）
    const jpegStart = longValueOf(view, TAG_JPEG_OFFSET, le);
    const jpegLength = longValueOf(view, TAG_JPEG_LENGTH, le);
    if (jpegStart > 0 && jpegLength > 0 && jpegStart + jpegLength <= bytes.length) {
      ranges.push({ start: jpegStart, end: jpegStart + jpegLength });
    }
  }
  return mergeRanges(ranges);
}

/** 条带/瓦片：偏移与长度两个数组一一配对 */
function stripRanges(view: TiffIfdView, offsetTag: number, lengthTag: number, le: boolean): ByteRange[] {
  const offsets = longArrayOf(entryOf(view, offsetTag), le);
  const lengths = longArrayOf(entryOf(view, lengthTag), le);
  const ranges: ByteRange[] = [];
  for (let i = 0; i < Math.min(offsets.length, lengths.length); i += 1) {
    if (offsets[i] > 0 && lengths[i] > 0) ranges.push({ start: offsets[i], end: offsets[i] + lengths[i] });
  }
  return ranges;
}

/** 一个条目的值数据本体在文件里的绝对范围（超出 4 字节时是「偏移指向的区间」） */
function effectiveRangeOf(view: TiffIfdView, entry: ParsedEntry, le: boolean): ByteRange {
  const unit = TYPE_SIZE.get(entry.type) ?? 0;
  const size = unit * entry.count;
  const at = view.entryOffsets[view.entries.indexOf(entry)] ?? 0;
  if (size <= 4) return { start: at + 8, end: at + 12 };
  return { start: longValueOfEntry(entry, le), end: longValueOfEntry(entry, le) + size };
}

function longValueOfEntry(entry: ParsedEntry, le: boolean): number {
  const view = dataViewOf(entry.entryBytes);
  return readU32(view, 8, le);
}

/** 合并重叠/相邻区间：审计时逐段比对，段越少越快 */
function mergeRanges(ranges: ByteRange[]): ByteRange[] {
  const sorted = ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start);
  const merged: ByteRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}