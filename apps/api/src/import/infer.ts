/**
 * apps/api/src/import/infer.ts
 *
 * 真实照片缺「地点/标题/分类/标签」，按既定决策「文件名推断 + 默认值」补齐：
 *   - 标题：去掉扩展名与水印后缀 `_W`，把分隔符换成空格
 *   - 分类：一律归「纪实」（真实照片无分类信号，AI 分类是后续里程碑）
 *   - 格式：EXIF FileType 归一（JPEG→JPG，其余原样）
 *   - 方向：按宽高判，竖片 height > width
 *   - 标签：M1 留空
 */
import { createHash } from 'node:crypto';

/** 稳定 id：对源文件名做 sha1，导入幂等（重复导入不新增重复行） */
export function mediaIdOf(name: string): string {
  return 'm' + createHash('sha1').update(name).digest('hex').slice(0, 20);
}

/** 标题仅去扩展名，保留原文件名中的下划线、连字符等所有字符，不做任何推断或改写 */
export function inferTitle(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  return base;
}

export function inferFormat(fileType: string): string {
  return fileType.toUpperCase() === 'PNG' ? 'PNG' : 'JPG';
}

export function inferOrientation(width: number, height: number): 'landscape' | 'portrait' {
  return height > width ? 'portrait' : 'landscape';
}

export function inferCategory(): string {
  return '纪实';
}

/**
 * 把 EXIF 的 "YYYY:MM:DD HH:MM:SS" 解析成捕获日期（YYYY-MM-DD）与精确时间。
 * 【为什么显式带 +08:00】EXIF 时间无时区信息，语义是「拍摄地当时的墙上时间」；
 * 本档案面向中国场景，一律按中国标准时间（UTC+8）解读并存为绝对时刻（timestamptz），
 * 不带偏移后缀的写法会被 Node 按服务器本地时区解读，服务器时区不同就会整体偏移。
 */
export function parseTakenAt(raw: string): { captureAt: string | null; takenAt: Date | null } {
  const full = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  const dayOnly = full ? null : raw.match(/^(\d{4}):(\d{2}):(\d{2})/);
  if (full) {
    const [y, mo, d, h, mi, s] = full.slice(1);
    const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`);
    return {
      captureAt: `${y}-${mo}-${d}`,
      takenAt: Number.isNaN(date.getTime()) ? null : date,
    };
  }
  if (dayOnly) {
    const [y, mo, d] = dayOnly.slice(1);
    return { captureAt: `${y}-${mo}-${d}`, takenAt: null };
  }
  return { captureAt: null, takenAt: null };
}