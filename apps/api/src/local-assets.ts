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
 * 【绝不动的】thumbs/**、blur/** —— 它们是本策略刻意留在本机的衍生品（见 files.controller）。
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
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