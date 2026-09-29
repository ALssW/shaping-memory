/**
 * apps/admin/src/lib/format.ts
 *
 * 后台列表里的时间展示。后端统一返回 ISO 串，表格里仅需便于人工快速阅读的紧凑格式，
 * 因此不做时区标注、不显示毫秒。
 */
import dayjs from 'dayjs';

/** ISO 串 → 'YYYY-MM-DD HH:mm'（审计日志需要精确到秒时加第二参） */
export function formatDateTime(value: string | null | undefined, withSeconds = false): string {
  if (!value) return '—';
  const parsed = dayjs(value);
  if (!parsed.isValid()) return value;
  return parsed.format(withSeconds ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD HH:mm');
}