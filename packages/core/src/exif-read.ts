/**
 * packages/core/src/exif-read.ts
 *
 * 「多容器读」入口：分派 JPEG / PNG / TIFF(RAW) 三条读路径。
 *
 * 【为什么单独成文件，而不是改 exif-io.ts】`readLocalExif` 是移动端在用的既有契约，
 * 它的语义是「只认 JPEG，其他抛 NotJpegError」。若把它放宽成「什么都能读」，
 * 移动端会立即把 NEF 判定为可编辑（它只有 JPEG 写手），用户在手机上执行一次保存即会抛异常。
 * 因此新能力用**新函数名**，旧函数一字不改 —— 这是本仓库「新增即并置」的一贯做法。
 */
import {
  collectValues,
  countUnknown,
  parseTiff,
  readLocalExif,
} from './exif-io';
import type { LocalExifDocument } from './exif-io';
import { locatePngExif, sniffContainer, UnsupportedContainerError } from './exif-container';
import type { ContainerKind } from './exif-container';

/**
 * 读任意受支持容器的 EXIF。
 * 三种容器共用一个返回结构，前端因此不必为格式分叉：
 *   - JPEG：EXIF 住在 APP1 段里，走原路径；
 *   - PNG ：EXIF 住在 `eXIf` 块里，块内是裸 TIFF；没有 `eXIf` 就返回「空文档」而不是报错
 *           （合规的 PNG 允许完全不带 EXIF，用户第一次写就是「新增」语义）；
 *   - TIFF/RAW（NEF / CR2 / ARW / DNG…）：整个文件就是 TIFF，直接解析。
 */
export function readLocalExifAny(bytes: Uint8Array): LocalExifDocument {
  const container = sniffContainer(bytes);
  if (container === 'jpeg') return readLocalExif(bytes);
  if (container === 'png') {
    const layout = locatePngExif(bytes);
    if (layout.tiff.length === 0) return { format: 'png', byteOrder: 'II', values: {}, unknownCount: 0 };
    return documentOf('png', layout.tiff);
  }
  if (container === 'tiff') return documentOf('tiff', bytes);
  throw new UnsupportedContainerError();
}

/** 容器名 + TIFF 字节 → 统一的读结果 */
function documentOf(format: 'png' | 'tiff', tiff: Uint8Array): LocalExifDocument {
  const parsed = parseTiff(tiff);
  return {
    format,
    byteOrder: parsed.byteOrder,
    values: collectValues(parsed),
    unknownCount: countUnknown(parsed),
  };
}

/** 该容器是否支持**写入**（'other' 只能列出、不能编辑） */
export function isWritableContainer(kind: ContainerKind): boolean {
  return kind === 'jpeg' || kind === 'png' || kind === 'tiff';
}

/** 容器 → 界面文案里的格式名（写文案时口径统一，不各处手写字符串） */
export function containerLabel(kind: ContainerKind): string {
  if (kind === 'jpeg') return 'JPEG';
  if (kind === 'png') return 'PNG';
  if (kind === 'tiff') return 'RAW / TIFF';
  return '未知格式';
}