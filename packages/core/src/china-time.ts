/**
 * packages/core/src/china-time.ts
 *
 * 中国标准时间（UTC+8）的统一口径 —— 全站唯一时区，分三层收敛：
 *   - 存储：timestamptz 绝对时刻（时区无关，不随会话时区漂移）
 *   - 出口：接口的时间字段一律经 toChinaIso 序列化为 ISO-8601 带 +08:00 偏移的字符串
 *   - 展示：前端经 chinaWallClock 直接读出串里的墙钟字段渲染，不做任何时区换算
 *
 * 【为什么不跟随运行环境时区】产品面向中国用户，时间语义是「拍摄 / 操作当时的墙上时间」；
 * 若跟随服务器或浏览器时区换算，同一份数据会在不同环境下显示成不同结果。
 * 中国不实行夏令时，东八区偏移全年恒定，因此可以用固定偏移精确表达。
 */

/** 东八区固定偏移（单位毫秒） */
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 两位补零 */
const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 按中国标准时间读出的墙钟字段（均为两位补零的字符串，可直接拼进展示文案） */
export interface ChinaWallClock {
  /** YYYY */
  year: string;
  /** MM */
  month: string;
  /** DD */
  day: string;
  /** HH */
  hour: string;
  /** mm */
  minute: string;
  /** ss */
  second: string;
}

/**
 * 绝对时刻（Date 或 ISO 串）→ ISO-8601 中国标准时间串（带 +08:00 偏移），如
 * "2026-09-12T06:16:26+08:00"；缺值或不合法给 null。
 *
 * 【为什么平移 8 小时后按 UTC 读表】这样读到的就是东八区墙钟数字，
 * 且完全不依赖运行环境（服务器 / 浏览器）所在时区。
 * 两个重载让「非空入参」的调用方直接拿到 string，免去无意义的空值处理。
 */
export function toChinaIso(raw: Date | string): string;
export function toChinaIso(raw: Date | string | null | undefined): string | null;
export function toChinaIso(raw: Date | string | null | undefined): string | null {
  if (!raw) return null;
  const instant = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(instant.getTime())) return null;
  const wall = new Date(instant.getTime() + CHINA_OFFSET_MS);
  const datePart = `${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}`;
  const timePart = `${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}:${pad2(wall.getUTCSeconds())}`;
  return `${datePart}T${timePart}+08:00`;
}

/**
 * ISO-8601（+08:00 口径）→ 墙钟字段；缺值或不合法给 null。
 *
 * 【为什么直接读字符串而不是 new Date】接口出口已保证 +08:00 口径，串里的数字
 * 就是墙上时间；经 Date 中转再读本地表会被运行环境时区二次换算，反而引入偏移。
 */
export function chinaWallClock(iso: string | null | undefined): ChinaWallClock | null {
  const matched = iso?.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!matched) return null;
  const [year, month, day, hour, minute, second] = matched.slice(1);
  return { year, month, day, hour, minute, second };
}
