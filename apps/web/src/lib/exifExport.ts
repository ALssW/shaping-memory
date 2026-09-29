/**
 * apps/web/src/lib/exifExport.ts
 *
 * 导出层：命名规则、目录选择、落盘与下载回落。
 *
 * 【两条落盘路径，一套命名规则】
 *   - 目录选择器（File System Access API）：Chromium 系可用，一次授权后整批静默写入，
 *     不会像「逐个下载」那样弹一串下载条、也不会被浏览器拦成「多个文件」；
 *   - 逐个下载（`<a download>`）：Firefox / Safari 的回落路径，能力等价但交互更吵。
 * 两条路径共用同一个 `exportFileNameOf`，因此命名结果与冲突处理在任何浏览器上都一致。
 *
 * 【为什么命名要做成规则对象】用户要的是「文件命名规则」而不是一个写死的后缀：
 * 有人要 `-edited` 后缀，有人要 `2026-09-25_` 前缀，有人要 `{name}_{date}` 模板。
 * 而且分批导出时同名冲突必须自动躲开 —— 否则第二次导出会静默覆盖第一次的成果。
 */
import { mimeOfContainer } from '@shaping-memory/core';
import type { ContainerKind } from '@shaping-memory/core';

/* -------------------------------------------------------------------------- */
/* 命名规则                                                                     */
/* -------------------------------------------------------------------------- */

/** 同名冲突怎么办：rename = 自动加「(2)」；overwrite = 直接盖掉 */
export type ConflictPolicy = 'rename' | 'overwrite';

export interface ExportNaming {
  mode: 'suffix' | 'prefix' | 'template';
  /** mode=suffix：插在原名与扩展名之间，如 `-edited` */
  suffix: string;
  /** mode=prefix：加在文件名最前面，如 `2026-09-25_` */
  prefix: string;
  /** mode=template：支持 {name} 原名、{ext} 扩展名、{date} 当天日期 */
  template: string;
  conflict: ConflictPolicy;
}

export const DEFAULT_NAMING: ExportNaming = {
  mode: 'suffix',
  suffix: '-edited',
  prefix: '',
  template: '{name}-edited',
  conflict: 'rename',
};

/** 文件名里不能出现的字符（含控制字符）：目录选择器会直接抛错，下载会把名字截断 */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

function sanitizeName(name: string): string {
  const cleaned = name.replace(ILLEGAL_NAME_CHARS, '_').replace(/^[.\s]+/, '').trim();
  return cleaned === '' ? 'photo' : cleaned;
}

/**
 * 拆出主干与扩展名。
 * 【为什么优先沿用原扩展名】NEF 改成 .tif 技术上合法，但相机软件与后期流程都按扩展名认文件，
 * 用户拿到一批被改名的 RAW 文件将无法辨认。只在原名没扩展名时才按容器补一个。
 */
function splitName(name: string, container: ContainerKind): { stem: string; ext: string } {
  const matched = /\.[^./\\]+$/.exec(name);
  if (matched) return { stem: name.slice(0, name.length - matched[0].length), ext: matched[0] };
  if (container === 'png') return { stem: name, ext: '.png' };
  if (container === 'tiff') return { stem: name, ext: '.tif' };
  return { stem: name, ext: '.jpg' };
}

const dateStamp = (now: Date): string =>
  `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

/** 按模式拼名字；模板模式下若用户忘了写扩展名占位，自动补上原扩展名 */
function composeName(stem: string, ext: string, naming: ExportNaming, now: Date): string {
  if (naming.mode === 'prefix') return `${naming.prefix}${stem}${ext}`;
  if (naming.mode === 'template') {
    const filled = naming.template
      .replace(/\{name\}/g, stem)
      .replace(/\{ext\}/g, ext.replace(/^\./, ''))
      .replace(/\{date\}/g, dateStamp(now));
    return /\.[^./\\]+$/.test(filled) ? filled : `${filled}${ext}`;
  }
  return `${stem}${naming.suffix}${ext}`;
}

/**
 * 算出本次导出的文件名。
 * `taken` = 本次导出里已经用掉的名字集合（跨张去重）；policy 为 rename 时自动避让。
 */
export function exportFileNameOf(
  original: string,
  container: ContainerKind,
  naming: ExportNaming,
  taken: ReadonlySet<string>,
  now: Date = new Date(),
): string {
  const { stem, ext } = splitName(original, container);
  const base = sanitizeName(composeName(stem, ext, naming, now));
  if (naming.conflict === 'overwrite' || !taken.has(base)) return base;

  const dot = base.lastIndexOf('.');
  const head = dot > 0 ? base.slice(0, dot) : base;
  const tail = dot > 0 ? base.slice(dot) : '';
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${head} (${index})${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/* -------------------------------------------------------------------------- */
/* 落盘目标                                                                     */
/* -------------------------------------------------------------------------- */

export type ExportTarget = 'directory' | 'download';

/** 目录选择结果：把「不支持」「用户取消」「权限被拒」分开，才能给出准确提示 */
export type DirectoryPick =
  | { ok: true; handle: FileSystemDirectoryHandle }
  | { ok: false; reason: 'unsupported' | 'cancelled' | 'denied' };

export function isDirectorySupported(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

/** 让用户选一个导出目录；取消/被拒都返回结构化原因，绝不抛错打断导出流程 */
export async function pickDirectory(): Promise<DirectoryPick> {
  const picker = window.showDirectoryPicker;
  if (!picker) return { ok: false, reason: 'unsupported' };
  try {
    const handle = await picker.call(window, { mode: 'readwrite', id: 'shaping-memory-exif-export' });
    return { ok: true, handle };
  } catch (err) {
    // AbortError 是用户点了取消；SecurityError 多为权限被拒，两者提示语气不同
    const name = err instanceof Error ? err.name : '';
    return { ok: false, reason: name === 'AbortError' ? 'cancelled' : 'denied' };
  }
}

/**
 * 写一个文件进已授权目录。
 * 【写前先 close】createWritable 默认会截断同名文件（覆盖语义），
 * 配合调用方算出的唯一名字，就是「改过的字节完整落盘、旧内容不留尾巴」。
 */
export async function writeToDirectory(
  directory: FileSystemDirectoryHandle,
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await directory.getFileHandle(filename, { create: true });
  const stream = await handle.createWritable();
  try {
    await stream.write(new Uint8Array(bytes));
  } finally {
    await stream.close();
  }
}

/** 回落路径：逐个触发下载。字节就是最终结果，导出阶段不再改任何 tag */
export function downloadBytes(bytes: Uint8Array, filename: string, container: ContainerKind): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeOfContainer(container) });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // 立即回收会让部分浏览器下载到空文件，延后一点再撤
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}