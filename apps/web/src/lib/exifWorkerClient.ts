/**
 * apps/web/src/lib/exifWorkerClient.ts
 *
 * EXIF Worker 的客户端封装：主线程只通过这几个函数说话，不直接碰 Worker 实例。
 *
 * 【为什么做成单例】Worker 启动有开销（几十毫秒 + 一份独立堆），一个工作台只需要一个；
 * 而且字节库是**按 Worker 实例**存在的，多实例会让「按 itemId 找字节」直接失效。
 *
 * 【为什么用 seq 配对】Worker 串行处理，回话顺序就是请求顺序，但用显式序号配对更稳：
 * 一旦将来改成并发，这里不用动。Worker 整体崩溃时，把所有等待者一并拒绝并复位，
 * 避免界面永远停在「读取中…」。
 */
import type {
  ExifApplyResult,
  ExifLoadResult,
  ExifWorkerCommand,
  ExifWorkerResponse,
} from './exifWorkerProtocol';

interface PendingSlot {
  resolve: (response: ExifWorkerResponse) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let seq = 0;
/** 未回话的请求：seq → 回调 */
const pending = new Map<number, PendingSlot>();

/** 懒启动：第一次用到才创建，没进过工具页就不会白起一个线程 */
function ensureWorker(): Worker {
  if (worker) return worker;

  const instance = new Worker(new URL('../workers/exif.worker.ts', import.meta.url), { type: 'module' });
  instance.onmessage = (event: MessageEvent<ExifWorkerResponse>) => {
    const response = event.data;
    const slot = pending.get(response.seq);
    if (!slot) return;
    pending.delete(response.seq);
    slot.resolve(response);
  };
  // Worker 整体崩溃（加载失败 / 未捕获异常）：当前线程已不可信，拒绝所有等待者并复位
  instance.onerror = () => {
    const failure = new Error('本地 EXIF 处理线程异常退出，请刷新页面后重试');
    for (const slot of pending.values()) slot.reject(failure);
    pending.clear();
    instance.terminate();
    worker = null;
  };
  worker = instance;
  return instance;
}

/** 发一条请求并等回话；只有 `ok: false` 才 reject，业务失败（如某张解析失败）走 result 里的字段 */
function request(command: ExifWorkerCommand): Promise<ExifWorkerResponse> {
  const target = ensureWorker();
  const current = seq++;
  return new Promise<ExifWorkerResponse>((resolve, reject) => {
    pending.set(current, { resolve, reject });
    target.postMessage({ ...command, seq: current });
  });
}

/** 导入一张照片：Worker 读字节 + 解析 + 抽预览 */
export async function loadExifItem(itemId: string, file: File): Promise<ExifLoadResult> {
  const response = await request({ kind: 'load', itemId, file });
  if (!response.ok) throw new Error(response.error);
  if (response.kind !== 'load') throw new Error('EXIF 处理线程回了非预期的消息类型');
  return response.result;
}

/** 把 patch 应用到一个内存副本上（不写磁盘） */
export async function applyExifPatch(
  itemId: string,
  patch: Record<string, string | null>,
): Promise<ExifApplyResult> {
  const response = await request({ kind: 'apply', itemId, patch });
  if (!response.ok) throw new Error(response.error);
  if (response.kind !== 'apply') throw new Error('EXIF 处理线程回了非预期的消息类型');
  return response.result;
}

/** 取出该照片当前字节的副本（导出前调用；取到即转移，不会留在 Worker 里） */
export async function exportExifBytes(itemId: string): Promise<Uint8Array> {
  const response = await request({ kind: 'export', itemId });
  if (!response.ok) throw new Error(response.error);
  if (response.kind !== 'export') throw new Error('EXIF 处理线程回了非预期的消息类型');
  return response.bytes;
}

/** 还内存：列表移除 / 清空 / 离开工作台时调用 */
export async function releaseExifBuffers(itemIds: readonly string[]): Promise<void> {
  if (itemIds.length === 0) return;
  // 离开工作台后的「收尾」调用，失败没有补救意义，静默即可
  try {
    await request({ kind: 'release', itemIds });
  } catch {
    /* 忽略：Worker 已崩溃时内存随线程一起释放 */
  }
}