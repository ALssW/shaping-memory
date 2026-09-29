/**
 * apps/admin/src/lib/pendingBatch.ts
 *
 * 「未完成的文件夹上传」在本机的记录，用于重开页面后提醒用户续传。
 *
 * 【为什么只存身份、不存文件】File 对象不可序列化，localStorage 也无法容纳数百 MB 的二进制；
 * 这里记下每个文件的身份（名 / 大小 / 修改时间）与「已上传但尚未并入相册」的照片 id，
 * 续传时要求用户重新选择同一文件夹，匹配回原文件即可 —— 分片本身在服务端，匹配后即可继续传输。
 */

const STORAGE_KEY = 'shaping-memory.admin.folderUpload';

/** 一个文件的身份键：与服务端算 uploadId 的口径一致（名 | 大小 | 修改时间） */
export function fileKeyOf(file: { name: string; size: number; lastModified: number }): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export interface PendingBatch {
  /** 目标相册（已创建或已选定）；没有它就没有「续传」可言 */
  albumId: string;
  albumTitle: string;
  /** 文件夹名，提醒文案用 */
  folderName: string;
  /** 尚未传输完成的文件身份键 */
  files: string[];
  /** 已上传成功、但尚未并入相册的照片 id */
  plannedIds: string[];
  updatedAt: number;
}

/** 读未完成批次；记录损坏或缺字段时按「无记录」处理，避免调用方在各处进行空值判断 */
export function readPendingBatch(): PendingBatch | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingBatch;
    if (!parsed.albumId || !Array.isArray(parsed.files) || !Array.isArray(parsed.plannedIds)) return null;
    return parsed;
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