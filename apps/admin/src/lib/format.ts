/**
 * apps/admin/src/lib/format.ts
 *
 * 后台的展示格式化：时间与文件体积。
 * 后端统一返回 ISO 串（绝对时刻），表格里仅需便于人工快速阅读的紧凑格式，
 * 因此不做时区标注、不显示毫秒；展示一律固定按中国标准时间（UTC+8）换算，
 * 不跟随浏览器所在时区 —— 与前台的 formatDateTime 同一口径。
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

/** ISO 串 → 'YYYY-MM-DD HH:mm'（审计日志需要精确到秒时加第二参）；固定 UTC+8 */
export function formatDateTime(value: string | null | undefined, withSeconds = false): string {
  if (!value) return '—';
  // utcOffset(8)：把绝对时刻换算到东八区再读数，浏览器时区不影响结果
  const parsed = dayjs(value).utcOffset(8);
  if (!parsed.isValid()) return value;
  return parsed.format(withSeconds ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD HH:mm');
}

/** 字节数 → 便于阅读的紧凑体积（上传清单与上传报告共用同一口径） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}