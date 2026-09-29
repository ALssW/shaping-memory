/**
 * apps/admin/src/lib/uploadRules.ts
 *
 * 上传校验规则：整包上传弹窗与文件夹上传弹窗共用同一份默认值、扩展名解析与设置读取。
 * 【为什么抽出来】「允许哪些扩展名」「单个文件多大」这类口径一旦在两个入口各写一遍，
 * 迟早出现「拖拽上传被拦截、文件夹上传被放行」这种不一致。
 */
import { settingsApi } from '@shaping-memory/sdk';

/** 保底上限（MB）：读取不到系统设置时使用 */
export const DEFAULT_MAX_MB = 50;
/** 保底允许的扩展名：与原生文件选择器的 accept 属性保持一致 */
export const DEFAULT_FORMATS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.tif', '.tiff'];
/** 保底分片大小（MB）：服务端 upload.chunkMb 缺省值也是 8 */
export const DEFAULT_CHUNK_MB = 8;
/** 保底并发数：服务端 upload.concurrency 缺省值也是 3 */
export const DEFAULT_CONCURRENCY = 3;

export const ACCEPT = DEFAULT_FORMATS.join(',');

/** 站点设置里的扩展名（逗号分隔）→ 小写带点的扩展名数组；读取不到则使用保底值 */
export function parseFormats(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_FORMATS;
  const list = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
    .map((item) => (item.startsWith('.') ? item : `.${item}`));
  return list.length > 0 ? list : DEFAULT_FORMATS;
}

/** 取文件扩展名（含点、小写）；没有扩展名时返回空串 */
export function extOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

/** 设置里的正数字符串 → 数字；不是有限正数则使用保底值 */
function positive(raw: string | undefined, fallback: number): number {
  const value = Number.parseFloat(raw ?? '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface UploadRules {
  /** 单文件体积上限（MB） */
  maxMb: number;
  /** 允许的扩展名（小写、带点） */
  formats: string[];
  /** 分片上传的每片大小（MB） */
  chunkMb: number;
  /** 分片上传的并发数 */
  concurrency: number;
}

/** 默认规则（读取失败或尚未读到设置时用） */
export const FALLBACK_RULES: UploadRules = {
  maxMb: DEFAULT_MAX_MB,
  formats: DEFAULT_FORMATS,
  chunkMb: DEFAULT_CHUNK_MB,
  concurrency: DEFAULT_CONCURRENCY,
};

/**
 * 读站点设置并落成规则。读不到时返回 null —— 由调用方决定是提示还是静默，
 * 组件因此不必各自再判一次「设置里有没有这一项」。
 */
export async function loadUploadRules(): Promise<UploadRules | null> {
  try {
    const settings = await settingsApi.all();
    return {
      maxMb: positive(settings['upload.maxMb'], DEFAULT_MAX_MB),
      formats: parseFormats(settings['upload.formats']),
      chunkMb: positive(settings['upload.chunkMb'], DEFAULT_CHUNK_MB),
      concurrency: Math.min(8, Math.max(1, Math.round(positive(settings['upload.concurrency'], DEFAULT_CONCURRENCY)))),
    };
  } catch {
    return null;
  }
}