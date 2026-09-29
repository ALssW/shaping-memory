/**
 * apps/web/src/lib/exifWorkerProtocol.ts
 *
 * 主线程 ↔ EXIF Worker 的消息契约。
 *
 * 【为什么要把 EXIF 处理挪进 Worker】一张 NEF 约 44MB，一次导入 8 张就是 350MB。
 * 在主线程上做「读字节 → 解析 → 改写 → 回读」会把界面卡成幻灯片，且大文件的
 * `Uint8Array` 长期挂在 React state 上，内存一旦紧张，浏览器会直接崩溃标签页。
 * 挪进 Worker 后主线程只留 File 句柄、容器类型、字段摘要这几样轻量数据。
 *
 * 【字节归 Worker 独占】`load` 时字节进 Worker 的字节库，`apply` 在库里就地换新，
 * `export` 时才复制一份传回主线程落盘。主线程任何时刻都不持有完整文件字节。
 */
import type { ContainerKind, LocalExifDocument } from '@shaping-memory/core';

/** `load` 的结果：主线程据此渲染列表行；字节本身留在 Worker */
export interface ExifLoadResult {
  container: ContainerKind;
  sizeBytes: number;
  /** 解析出的 EXIF；只读行为 null */
  doc: LocalExifDocument | null;
  /** 只读原因（格式不支持 / 解析失败 / 读取失败）；null 表示可编辑 */
  readOnlyReason: string | null;
  /**
   * RAW 的内嵌 JPEG 预览字节（有才带，已 transfer）。
   * 【为什么需要】浏览器渲染不了 NEF 本体，列表缩略图只能靠内嵌预览；
   * JPEG / PNG 用 File 自身的对象 URL 即可，这里返回 null。
   */
  preview: Uint8Array | null;
}

/** `apply` 的结果：写入后的字节在 Worker 里已更新，这里只回带最新字段快照 */
export interface ExifApplyResult {
  doc: LocalExifDocument;
}

export type ExifWorkerCommand =
  /** 导入：Worker 负责从 File 读字节、嗅探容器、解析 EXIF、抽取内嵌预览 */
  | { kind: 'load'; itemId: string; file: File }
  /** 应用：把 patch 写进该照片的字节库副本（不动用户磁盘上的原文件） */
  | { kind: 'apply'; itemId: string; patch: Record<string, string | null> }
  /** 导出：复制一份当前字节传回主线程（复制是必须的，见 worker 内注释） */
  | { kind: 'export'; itemId: string }
  /** 释放：列表移除 / 清空时立刻还内存，别等 Worker 被回收 */
  | { kind: 'release'; itemIds: readonly string[] };

/**
 * 实际发出去的消息 = 命令 + 序号。
 * 【为什么拆成两层】`Omit<联合类型, 'seq'>` 在 TS 里会退化成「只保留公共键」的窄类型
 * （`keyof` 对联合取交集），文件与 patch 会被吞掉。用「命令联合 & 序号」即可避开这一问题。
 */
export type ExifWorkerRequest = ExifWorkerCommand & { seq: number };

export type ExifWorkerResponse =
  | { seq: number; ok: true; kind: 'load'; result: ExifLoadResult }
  | { seq: number; ok: true; kind: 'apply'; result: ExifApplyResult }
  | { seq: number; ok: true; kind: 'export'; bytes: Uint8Array }
  | { seq: number; ok: true; kind: 'release' }
  /** 失败一律带中文可读原因：界面直接展示，不做二次翻译 */
  | { seq: number; ok: false; error: string };