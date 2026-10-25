/**
 * apps/admin/src/lib/format.ts
 *
 * 后台的展示格式化：时间与文件体积。
 * 后端统一返回 ISO-8601 中国标准时间串（带 +08:00 偏移），表格里仅需便于人工
 * 快速阅读的紧凑格式，因此不显示时区标注与毫秒；直接渲染串里的墙钟字段，
 * 不经时区换算、不依赖浏览器所在时区 —— 与前台的 formatDateTime 同一口径。
 */
import { chinaWallClock } from '@shaping-memory/core';

/** ISO 串 → 'YYYY-MM-DD HH:mm'（审计日志需要精确到秒时加第二参） */
export function formatDateTime(value: string | null | undefined, withSeconds = false): string {
  if (!value) return '—';
  const wall = chinaWallClock(value);
  if (!wall) return value;
  const clock = withSeconds ? `${wall.hour}:${wall.minute}:${wall.second}` : `${wall.hour}:${wall.minute}`;
  return `${wall.year}-${wall.month}-${wall.day} ${clock}`;
}

/** 字节数 → 便于阅读的紧凑体积（上传清单与上传报告共用同一口径） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
