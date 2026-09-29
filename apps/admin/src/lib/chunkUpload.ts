/**
 * apps/admin/src/lib/chunkUpload.ts
 *
 * 分片上传引擎：把一个大文件切成若干片分别上传，中途断网 / 关页面后只补传缺失的分片。
 *
 * 【并发分两层】本模块只管**一个文件内部**的分片并发；文件之间是否并行由调用方决定
 * （文件夹上传是多文件并发的，见 FolderUploadModal 的 runUpload）。
 * 两层的乘积控制在站点设置 upload.concurrency 上：只有一个文件时这里独占全部并发，
 * 文件较多时调用方会把分片并发压到 1，把带宽分摊到多个文件上。
 * 【断点在哪】已接收的分片留在服务端（一个 uploadId 一个目录），客户端只记录「已传过哪些分片」——
 * 客户端因此不需要持久化任何二进制，重开页面后重新 init 即可获取「已接收哪些分片」。
 */
import { photoApi } from '@shaping-memory/sdk';
import type { ChunkFileIdentity, PhotoUploadResult } from '@shaping-memory/sdk';

import { runPool } from './pool';

/** 单片重试次数：网络抖动一两次即导致整文件失败过于脆弱，多数问题重试一次即可通过 */
const MAX_ATTEMPTS = 3;
/** 重试间隔基数（毫秒），按尝试次数线性退避 */
const RETRY_BASE_MS = 600;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 第 index 片的字节数：最后一片为剩余部分 */
function chunkBytesOf(size: number, chunkBytes: number, index: number, totalChunks: number): number {
  return index === totalChunks - 1 ? size - chunkBytes * (totalChunks - 1) : chunkBytes;
}

/** 单片重试：失败按次数退避重试，全败才把错误抛给调用方 */
async function sendChunk(
  uploadId: string,
  index: number,
  blob: Blob,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: Error = new Error('分片上传失败');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error('上传已取消');
    try {
      await photoApi.uploadChunk(uploadId, index, blob);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_MS * attempt);
    }
  }
  throw lastError;
}

export interface ChunkedUploadOptions {
  /** 同时在传输的分片数（来自站点设置的 upload.concurrency） */
  concurrency: number;
  /** 同名冲突选择「覆盖」时，目标照片的 id（服务端沿用它的落盘名，因此 id 不变） */
  overwriteId?: string;
  /** 每确认一片回调一次，参数是**本次新增**的字节数 */
  onProgress: (deltaBytes: number) => void;
  /** 用户中止：置位后不再派发新分片，已接收的分片留在服务端供下次续传 */
  signal?: AbortSignal;
}

/**
 * 分片上传一个文件并入库，返回入库后的照片与云端同步结果。
 * 已完成的分片会在调用时被服务端跳过，因此「重试同一个文件」即等价于断点续传。
 */
export async function uploadFileInChunks(
  file: File,
  options: ChunkedUploadOptions,
): Promise<PhotoUploadResult> {
  const identity: ChunkFileIdentity = {
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
  };
  // init 同时是续传入口：服务端按文件身份算出 uploadId，并返回「已接收的分片」
  const session = await photoApi.initChunkUpload(identity);
  if (!(session.chunkBytes > 0)) throw new Error('服务端下发的分片大小不合法');

  const totalChunks = Math.max(1, Math.ceil(file.size / session.chunkBytes));
  const received = new Set(session.received.filter((index) => index >= 0 && index < totalChunks));
  const missing: number[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    if (!received.has(index)) missing.push(index);
  }
  /* 续传时「已接收的分片」也要计入进度：否则进度条从 0 再增长一遍，表现为无效的重复传输 */
  let restored = 0;
  for (const index of received) {
    restored += chunkBytesOf(file.size, session.chunkBytes, index, totalChunks);
  }
  if (restored > 0) options.onProgress(restored);

  const failures: number[] = [];
  await runPool(missing, options.concurrency, async (index) => {
    if (options.signal?.aborted) return;
    const start = index * session.chunkBytes;
    const blob = file.slice(start, Math.min(start + session.chunkBytes, file.size));
    try {
      await sendChunk(session.uploadId, index, blob, options.signal);
      options.onProgress(blob.size);
    } catch {
      failures.push(index);
    }
  });

  if (options.signal?.aborted) throw new Error('上传已取消');
  if (failures.length > 0) {
    throw new Error(`有 ${failures.length} 个分片未传输完成，稍后重试会从断点继续`);
  }
  // 分片齐备后才合并入库：服务端会再验一次总体积，缺片时会报错而不会写入损坏的照片
  return photoApi.completeChunkUpload(session.uploadId, identity, options.overwriteId);
}