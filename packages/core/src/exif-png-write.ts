/**
 * packages/core/src/exif-png-write.ts
 *
 * PNG 的 EXIF 写入：把 TIFF 装进 `eXIf` 数据块。
 *
 * 【PNG 与 JPEG 的关键差异】JPEG 的 EXIF 段带 `Exif\0\0` 六字节前缀，
 * 而 PNG 的 `eXIf` 块里放的就是**裸 TIFF**（不带那个前缀）。除此之外格式完全一样，
 * 因此 IFD 重建逻辑直接复用 `buildPatchedTiff`，不另写一套。
 *
 * 【PNG 为什么可以整文件重排，RAW 却不行】PNG 的块结构是自描述的：每块自带长度，
 * 谁也不需要「绝对偏移」。所以插入或替换一个块、把后面所有字节往后挪，是**安全**的
 * —— 这与 RAW 必须原地改写形成鲜明对比（见 exif-tiff-write.ts 的说明）。
 *
 * 【两条规范约束】① 全文件只能有一个 `eXIf` 块；② 必须排在第一个 `IDAT` 之前。
 * 因此「替换已有块」或「插到 IDAT 前」，两种情况都要处理。
 */
import { buildPatchedTiff, dataViewOf } from './exif-io';
import { crc32, locatePngExif } from './exif-container';

/** 块类型 'eXIf' 的 4 个字节 */
const EXIF_CHUNK_TYPE: readonly number[] = [0x65, 0x58, 0x49, 0x66];

/** 拼一个完整的 eXIf 块：长度(4) + 类型(4) + 裸 TIFF + CRC(4) */
function buildExifChunk(tiff: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + tiff.length);
  const view = dataViewOf(out);
  view.setUint32(0, tiff.length, false); // PNG 与 JPEG 相反：长度字段是大端
  out.set(EXIF_CHUNK_TYPE, 4);
  out.set(tiff, 8);
  // CRC 覆盖「类型 + 数据」，不含长度字段本身
  view.setUint32(8 + tiff.length, crc32(out, 4, 8 + tiff.length), false);
  return out;
}

/**
 * 写 PNG 的 EXIF：patch 中 value 为 null 表示删除该 tag。
 * 像素数据（IDAT）一个字节都不动 —— 只重排块，不重编码图像。
 */
export function applyPngExifPatch(bytes: Uint8Array, patch: Record<string, string | null>): Uint8Array {
  const layout = locatePngExif(bytes);
  const tiff = buildPatchedTiff(layout.tiff, patch);
  // 原本没有 EXIF、这次也没写出内容 → 保持原文件不变，不额外写入空块
  if (tiff === null) return bytes.slice();

  const chunk = buildExifChunk(tiff);
  const at = layout.chunk ? layout.chunk.start : layout.insertAt;
  const removeEnd = layout.chunk ? layout.chunk.end : at;

  const out = new Uint8Array(bytes.length - (removeEnd - at) + chunk.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(bytes.subarray(removeEnd), at + chunk.length);
  return out;
}