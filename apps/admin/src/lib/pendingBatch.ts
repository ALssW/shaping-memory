/**
 * apps/admin/src/lib/pendingBatch.ts
 *
 * 「未完成的文件夹上传」在本机的记录，用于重开页面后提醒用户续传。
 *
 * 【为什么只存身份、不存文件】File 对象不可序列化，localStorage 也无法容纳数百 MB 的二进制；
 * 这里记下每个文件的身份（名 / 大小 / 修改时间）与「已上传但尚未并入相册」的照片 id，
 * 续传时要求用户重新选择同一批文件夹，匹配回原文件即可 —— 分片本身在服务端，匹配后即可继续传输。
 * 【为什么相册按文件夹分别记录】一次可上传多个文件夹，每个文件夹各有自己的同名相册；
 * 中断时「哪些照片还没并入哪个相册」必须逐册记录，否则续传只能把它们塞进唯一一个相册。
 */

const STORAGE_KEY = 'shaping-memory.admin.folderUpload';

/** 一个文件的身份键：与服务端算 uploadId 的口径一致（名 | 大小 | 修改时间） */
export function fileKeyOf(file: { name: string; size: number; lastModified: number }): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/** 一个文件夹对应的相册与「已上传但尚未并入」的照片 */
export interface PendingAlbum {
  folderName: string;
  albumId: string;
  albumTitle: string;
  plannedIds: string[];
}

export interface PendingBatch {
  /** 本批涉及的文件夹名（续传时要求重新选中的文件夹与之匹配） */
  folderNames: string[];
  /** 尚未传输完成的文件身份键（跨文件夹扁平记录） */
  files: string[];
  /** 各文件夹的相册归属与待并入的照片 id */
  albums: PendingAlbum[];
  updatedAt: number;
}

/** 旧版记录：单文件夹 + 单一相册（升级时归一化，避免调用方在各处做兼容判断） */
interface LegacyPendingBatch {
  albumId?: string;
  albumTitle?: string;
  folderName?: string;
  plannedIds?: string[];
  files?: string[];
  updatedAt?: number;
}

/**
 * 读未完成批次；记录损坏或缺字段时按「无记录」处理。
 * 旧版（单文件夹）记录在此归一化为多文件夹结构，续传逻辑因此只有一套。
 */
export function readPendingBatch(): PendingBatch | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingBatch> & LegacyPendingBatch;
    if (!Array.isArray(parsed.files)) return null;

    if (Array.isArray(parsed.albums) && Array.isArray(parsed.folderNames) && parsed.folderNames.length > 0) {
      return {
        folderNames: parsed.folderNames,
        files: parsed.files,
        albums: parsed.albums,
        updatedAt: parsed.updatedAt ?? Date.now(),
      };
    }
    if (!parsed.albumId || !parsed.folderName) return null;
    return {
      folderNames: [parsed.folderName],
      files: parsed.files,
      albums: [
        {
          folderName: parsed.folderName,
          albumId: parsed.albumId,
          albumTitle: parsed.albumTitle ?? parsed.folderName,
          plannedIds: Array.isArray(parsed.plannedIds) ? parsed.plannedIds : [],
        },
      ],
      updatedAt: parsed.updatedAt ?? Date.now(),
    };
  } catch {
    return null;
  }
}

export function writePendingBatch(batch: Omit<PendingBatch, 'updatedAt'>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...batch, updatedAt: Date.now() }));
  } catch {
    // 隐私模式 / 配额已满：续传提醒失效不影响本次上传本身，静默处理即可
  }
}

export function clearPendingBatch(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上
  }
}