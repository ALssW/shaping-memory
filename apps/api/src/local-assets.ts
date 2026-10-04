/**
 * apps/api/src/local-assets.ts
 *
 * 混合存储下的本机清理：只回收「已经上云」的那两类本机副本，绝不误删衍生品。
 *
 * 【边界铁律】系统自己产生的文件都在 STORAGE_DIR 下；PHOTO_SOURCE_DIR 是用户的原始资产目录，
 * 一个字节都不碰 —— 批量导入的原片来自那里，即便已上云也必须原地保留（它是档案本身，
 * 也是回填命令与「查看原片 EXIF」的本机数据来源）。
 *
 * 【要清的】original（仅后台上传的 uploads/ 暂存副本）与 live/{id}.mp4 —— 它们已有一份在云端。
 * 【绝不动的】thumbs/**、blur/** —— 它们是本策略刻意留在本机的衍生品（见 files.controller）；
 * 只有「彻底删除」例外：那张照片整个不要了，本机衍生品也一并回收（见 purgeLocalAssets）。
 */
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { cardPathForThumb, blurPathFor } from '@shaping-memory/image';
import type { AppConfig } from '@shaping-memory/config';

/** 该文件是否由系统自己产生（位于 STORAGE_DIR 内）。PHOTO_SOURCE_DIR 等外部路径一律为 false */
export function isSystemPath(config: AppConfig, file: string): boolean {
  const relative = path.relative(config.STORAGE_DIR, file);
  // relative 为空 = 就是目录本身；以 .. 开头或仍是绝对路径 = 在目录之外
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 清理所需的最小 media 行切片 */
export interface LocalAssetSource {
  sourcePath: string;
  liveVideoPath: string | null;
}

/**
 * 回收已上云的本机副本：逐个过 isSystemPath()，只删系统自己的文件。
 * `force: true` 让「文件本来就不在」不算错误；整体吞掉异常 —— 清理只是省磁盘，
 * 失败不该影响「照片已经上云」这个既成事实。
 */
export async function cleanupUploadedAssets(config: AppConfig, row: LocalAssetSource): Promise<void> {
  for (const file of [row.sourcePath, row.liveVideoPath]) {
    if (!file || !isSystemPath(config, file)) continue;
    try {
      await rm(file, { force: true });
    } catch {
      // 故意吞错：清理是尽力而为
    }
  }
}

/* --------------------------------------------------------------------------
 * 彻底删除时的本机清理
 * -------------------------------------------------------------------------- */

/** 彻底删除所需的最小 media 行切片 */
export interface PurgeAssetSource extends LocalAssetSource {
  id: string;
  thumbPath: string | null;
}

/** 与云端清理同形的结果：计数 + 失败明细 */
export interface LocalPurgeResult {
  removed: number;
  failures: string[];
}

/**
 * 列出该照片在本机产生的全部文件（只含 STORAGE_DIR 内的）。
 *
 * 【模糊图为什么用目录扫描】模糊图文件名带算法版本与强度（`blur/{id}-v{ver}s{strength}.jpg`），
 * 同一张照片可能同时存在多档强度的缓存；逐个版本号去猜必然漏掉历史档，因此扫目录按 id 前缀取。
 * 【源目录原片为什么不在列表里】`isSystemPath()` 会滤掉它 —— PHOTO_SOURCE_DIR 是用户档案，一字节不碰。
 */
async function localFilesOf(config: AppConfig, row: PurgeAssetSource): Promise<string[]> {
  const candidates = [
    row.sourcePath,
    row.liveVideoPath,
    row.thumbPath,
    // 卡片档缩略图由缩略图路径推导，与生成时同一套口径
    row.thumbPath ? cardPathForThumb(row.thumbPath) : null,
  ].filter((file): file is string => Boolean(file));

  const files = candidates.filter((file) => isSystemPath(config, file));

  // 模糊图目录：所有变体都在同一目录下，按 id 前缀一次取全
  const blurDir = path.dirname(blurPathFor(config.STORAGE_DIR, row.id, 1));
  try {
    const entries = await readdir(blurDir);
    for (const name of entries) {
      if (!name.startsWith(`${row.id}-v`)) continue;
      const file = path.join(blurDir, name);
      if (isSystemPath(config, file)) files.push(file);
    }
  } catch {
    // 目录不存在 = 这张照片没有模糊图缓存，属于正常情况
  }
  return files;
}

/**
 * 彻底删除本机副本：原片（仅上传暂存的 uploads/）、实况视频、缩略图、卡片图、全部模糊图变体。
 *
 * 【与 cleanupUploadedAssets 的关键差别】这里**不吞异常**：彻底删除要求原子性，
 * 本机文件删不掉就必须中止，否则数据库记录会被清掉而文件永远留在磁盘上。
 * 失败明细回给调用方，由它决定中止并提示用户。
 */
export async function purgeLocalAssets(config: AppConfig, row: PurgeAssetSource): Promise<LocalPurgeResult> {
  const result: LocalPurgeResult = { removed: 0, failures: [] };
  for (const file of await localFilesOf(config, row)) {
    try {
      await rm(file, { force: true });
      result.removed += 1;
    } catch (error) {
      result.failures.push(`${file}: ${(error as Error).message}`);
    }
  }
  return result;
}