/**
 * apps/web/src/workers/exif.worker.ts
 *
 * EXIF 批量处理的**重活全部落在这里**：读字节、嗅探容器、解析、改写、回读、抽取内嵌预览。
 *
 * 【三条铁律】
 *   1. 不联网：只用 FileReader + core 的纯函数，全程无 fetch / XHR（断网可用）；
 *   2. 字节归本线程独占：主线程只拿「容器 / 体积 / 字段快照 / 缩略图」四样轻量数据；
 *   3. 一次只做一件事：消息按队列串行处理，避免两条大文件改写交错导致内存峰值翻倍。
 *
 * 【为什么导出要先复制】`postMessage(msg, [buffer])` 是「转移」语义，转移后本线程里
 * 这份字节就作废了 —— 用户再点一次导出会得到空文件。所以导出必须先 `slice()` 出一份副本，
 * 转移副本、留下原件。
 */
import {
  containerLabel,
  extractEmbeddedPreview,
  isWritableContainer,
  readLocalExifAny,
  sniffContainer,
  writeLocalExif,
} from '@shaping-memory/core';
import type { ContainerKind } from '@shaping-memory/core';

import type {
  ExifApplyResult,
  ExifLoadResult,
  ExifWorkerRequest,
  ExifWorkerResponse,
} from '../lib/exifWorkerProtocol';

/* -------------------------------------------------------------------------- */
/* Worker 上下文：tsconfig 装的是 DOM lib，这里的 self 并不位于 window 上          */
/* -------------------------------------------------------------------------- */

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<ExifWorkerRequest>) => void) | null;
  postMessage: (message: ExifWorkerResponse, transfer?: Transferable[]) => void;
};

/* -------------------------------------------------------------------------- */
/* 字节库：完整文件字节只存在这里，主线程无法获取                               */
/* -------------------------------------------------------------------------- */

const buffers = new Map<string, Uint8Array>();

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : '未知错误');

/** FileReader 读字节：与工作台契约保持一致，不依赖 File.arrayBuffer() 的兼容性 */
function readAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error(reader.error?.message ?? '文件读取失败'));
    reader.readAsArrayBuffer(file);
  });
}

/** 认不出的格式：说清「支持什么」，而不是「不是 JPEG」（PNG / RAW 现在都能写） */
function unsupportedReason(container: ContainerKind): string {
  return `暂不支持 ${containerLabel(container)} 的 EXIF 读写（本工具支持 JPEG / PNG / RAW(含 NEF)），该文件仅列出、不参与编辑`;
}

/** RAW 才需要内嵌预览：JPEG / PNG 本身就能被 <img> 直接渲染 */
function previewOf(container: ContainerKind, bytes: Uint8Array): Uint8Array | null {
  return container === 'tiff' ? extractEmbeddedPreview(bytes) : null;
}

/* -------------------------------------------------------------------------- */
/* 四类操作                                                                     */
/* -------------------------------------------------------------------------- */

async function handleLoad(itemId: string, file: File): Promise<ExifLoadResult> {
  const sizeBytes = file.size;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readAsArrayBuffer(file));
  } catch (err) {
    return { container: 'other', sizeBytes, doc: null, readOnlyReason: `文件读取失败：${messageOf(err)}`, preview: null };
  }

  const container = sniffContainer(bytes);
  // 不支持的容器不留字节：留着也无法写回，只会持续占用几十 MB
  if (!isWritableContainer(container)) {
    return { container, sizeBytes, doc: null, readOnlyReason: unsupportedReason(container), preview: null };
  }

  try {
    const doc = readLocalExifAny(bytes);
    buffers.set(itemId, bytes);
    return { container, sizeBytes, doc, readOnlyReason: null, preview: previewOf(container, bytes) };
  } catch (err) {
    // 结构损坏 / 解析越界：诚实置为只读，把底层原因原样带出去
    return { container, sizeBytes, doc: null, readOnlyReason: `EXIF 解析失败：${messageOf(err)}`, preview: null };
  }
}

function handleApply(itemId: string, patch: Record<string, string | null>): ExifApplyResult {
  const bytes = buffers.get(itemId);
  if (!bytes) throw new Error('这张照片已不在处理列表中（格式不支持或已被移除），请重新导入');
  const written = writeLocalExif(bytes, patch);
  buffers.set(itemId, written);
  return { doc: readLocalExifAny(written) };
}

function handleExport(itemId: string): Uint8Array {
  const bytes = buffers.get(itemId);
  if (!bytes) throw new Error('这张照片已不在处理列表中（格式不支持或已被移除），请重新导入');
  return bytes.slice();
}

/* -------------------------------------------------------------------------- */
/* 消息泵：串行处理，逐条回话                                                    */
/* -------------------------------------------------------------------------- */

/** 转移用的缓冲：`Uint8Array.buffer` 在 TS 里是 ArrayBufferLike，收窄成 Transferable 需要一次断言 */
const transferOf = (bytes: Uint8Array | null): Transferable[] => (bytes ? [bytes.buffer as ArrayBuffer] : []);

async function respond(request: ExifWorkerRequest): Promise<void> {
  try {
    if (request.kind === 'load') {
      const result = await handleLoad(request.itemId, request.file);
      ctx.postMessage({ seq: request.seq, ok: true, kind: 'load', result }, transferOf(result.preview));
      return;
    }
    if (request.kind === 'apply') {
      const result = handleApply(request.itemId, request.patch);
      ctx.postMessage({ seq: request.seq, ok: true, kind: 'apply', result });
      return;
    }
    if (request.kind === 'export') {
      const bytes = handleExport(request.itemId);
      ctx.postMessage({ seq: request.seq, ok: true, kind: 'export', bytes }, transferOf(bytes));
      return;
    }
    for (const itemId of request.itemIds) buffers.delete(itemId);
    ctx.postMessage({ seq: request.seq, ok: true, kind: 'release' });
  } catch (err) {
    ctx.postMessage({ seq: request.seq, ok: false, error: messageOf(err) });
  }
}

/**
 * 串行队列：`load` 是异步的（等 FileReader），若不排队，用户连点两次导入会让两组大文件
 * 的字节同时在内存里排队解析。链式串行保证任一时刻只有一件事在做。
 */
let chain: Promise<void> = Promise.resolve();
ctx.onmessage = (event) => {
  const request = event.data;
  chain = chain.then(() => respond(request));
};