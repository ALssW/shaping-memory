/**
 * packages/core/src/exif-write.ts
 *
 * 「多容器写」统一入口：按容器分派到三条写路径。
 *
 * 【为什么要有这一层】本地工具有三种输入（JPEG / PNG / RAW），若不集中处理，
 * 前端每处调用都要自行编写一遍格式分支，漏掉一个分支就会出现「写了但没生效」。
 * 集中到这里之后，前端只认 `writeLocalExif(bytes, patch)` 一个签名。
 *
 * 【旧的 applyLocalExifPatch 保持原样】移动端仍在用它（语义 = 只认 JPEG）。
 * 新能力走新函数名，是「新增即并置」的既有约定，避免把移动端一并引入 RAW 的复杂度。
 */
import { applyLocalExifPatch } from './exif-io';
import { applyPngExifPatch } from './exif-png-write';
import { applyTiffExifPatch } from './exif-tiff-write';
import { sniffContainer, UnsupportedContainerError } from './exif-container';

/** 按容器自动分派写 EXIF。不支持的容器抛 UnsupportedContainerError（带可读中文） */
export function writeLocalExif(bytes: Uint8Array, patch: Record<string, string | null>): Uint8Array {
  const container = sniffContainer(bytes);
  if (container === 'jpeg') return applyLocalExifPatch(bytes, patch);
  if (container === 'png') return applyPngExifPatch(bytes, patch);
  if (container === 'tiff') return applyTiffExifPatch(bytes, patch);
  throw new UnsupportedContainerError('这种格式暂不支持保存拍摄参数（目前支持 JPEG / PNG / RAW(含 NEF)）');
}