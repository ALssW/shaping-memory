/**
 * packages/core/src/timeline.ts
 *
 * 时间线分组的纯函数。Web 与 RN 两端共用，保证「同一天归到同一格、年份大标题一致」。
 * 设计原则：分组结果一次性算好，渲染层只做遍历 —— 避免在组件里反复 slice/sort。
 */
import type { DayGroup, Photo, SortOrder, YearBlock } from './types';

/** 星期中文简写，索引与 Date.getDay() 对齐 */
export const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'] as const;

/**
 * 无拍摄日期照片的分组键与展示文案。
 * 【为什么提到 core】它不只是列表分组的一个标签：Web 的时间分段（lib/timeGroups）、
 * 移动端的年/日分组、以及时间刻度三处若各写一份，同一批照片就可能
 * 一段被读成「未知时间」、另一段被读成「0 月」。
 */
export const UNDATED_KEY = 'undated';
export const UNDATED_LABEL = '未知时间';

/**
 * 按拍摄日期排序（desc = 最新在前）。
 * 【为什么提到 core】墙面与列表本来各写了一份同样的比较函数，而查看器的翻页顺序
 * 必须与它俩完全一致 —— 排序一旦有两处实现，就迟早会出现「墙上第三张、查看器里第五张」。
 * 统一到这里后，三处共用同一份口径。
 */
export function sortByDate(photos: readonly Photo[], order: SortOrder): readonly Photo[] {
  return [...photos].sort((left, right) =>
    order === 'desc' ? right.date.localeCompare(left.date) : left.date.localeCompare(right.date),
  );
}

/** 由 YYYY-MM-DD 求星期几（0=周日）。避免 new Date('YYYY-MM-DD') 被当成 UTC 导致东八区差一天 */
export function weekdayOf(date: string): number {
  return new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getDay();
}

/**
 * 按「日」分组并排序。
 * asc = 从旧到新；desc = 从新到旧。
 * 组内照片顺序与整体方向对称 —— 否则倒序时点开查看器，左右滑动的方向会和列表相反。
 *
 * 【无拍摄日期的照片】归入一个哨兵组（见 UNDATED_KEY）。直接用 photo.date 当键
 * 会切出一个 year='' 的假年份、day=NaN 的假日号与 WEEK_CN[NaN]=undefined 的假星期，
 * 渲染出来就是「0 月 / 00 / 周」。
 */
export function groupByDay(photos: readonly Photo[], order: SortOrder): DayGroup[] {
  const buckets = new Map<string, Photo[]>();
  for (const photo of photos) {
    // 键取「合法日键 ?? 空串」：空串就是哨兵键，无需另造一个字符串
    const key = dayKeyOf(photo.date) ?? '';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(photo);
    else buckets.set(key, [photo]);
  }

  /* 键只有两种形态：YYYY-MM-DD 与空串。字典序即时间序，且空串小于任何日期 ——
     正序时「未知时间」在最前、倒序时在最后。这个位置与 Web 的时间分段一致：
     那边的输入先经 sortByDate，空日期在正序里同样排在最前。 */
  const dates = Array.from(buckets.keys()).sort();
  if (order === 'desc') dates.reverse();

  return dates.map((date) => {
    const bucket = buckets.get(date)!;
    const undated = date === '';
    return {
      date,
      year: undated ? UNDATED_LABEL : date.slice(0, 4),
      month: undated ? '' : date.slice(5, 7),
      day: undated ? 0 : Number(date.slice(8, 10)),
      weekday: undated ? 0 : weekdayOf(date),
      undated,
      photos: order === 'asc' ? bucket : [...bucket].reverse(),
    };
  });
}

/**
 * 组装「年区块」：按年分段，每段有年份大标题与月度小标题。
 * 无拍摄日期的照片自成一块 —— 它的 day.year 已经是「未知时间」（见 groupByDay），
 * 于是这一年块的大标题就是「未知时间」，不会出现空标题的年份块。
 */
export function buildYearBlocks(photos: readonly Photo[], order: SortOrder): YearBlock[] {
  const blocks: YearBlock[] = [];
  const byYear = new Map<string, YearBlock>();

  for (const day of groupByDay(photos, order)) {
    let block = byYear.get(day.year);
    if (!block) {
      block = { year: day.year, days: 0, count: 0, daysGroups: [] };
      byYear.set(day.year, block);
      blocks.push(block);
    }
    block.daysGroups.push(day);
    block.count += day.photos.length;
  }

  for (const block of blocks) block.days = block.daysGroups.length;
  return blocks;
}

/** 月份文案，如「9月」。轨道上的每一枚刻度都只用这一份，去掉前导零 */
export function formatMonth(month: string): string {
  return `${Number(month)}月`;
}

/**
 * 取年月键「YYYY-MM」；拍摄日期缺失或不合法时返回 null。
 * 真实档案里存在导入时读不到 EXIF 日期的照片（API 会给空串），
 * 刻度与分组若直接 slice 就会画出一枚「0 月」刻度 —— 调用方必须跳过 null。
 */
export function monthKeyOf(date: string): string | null {
  if (date.length < 7) return null;
  const month = Number(date.slice(5, 7));
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  return date.slice(0, 7);
}

/** 完整年月文案，如「2024 · 9月」 */
export function formatMonthLabel(year: string, month: string): string {
  return `${year} · ${formatMonth(month)}`;
}

/**
 * 取「日」键「YYYY-MM-DD」；拍摄日期缺失或不合法时返回 null。
 * 与 monthKeyOf 同一套「不合法就返回 null」的约定 —— 时间刻度切到日尺度时，
 * 缺日期的照片同样必须被跳过，否则轨上会多出一枚「0/0」。
 */
export function dayKeyOf(date: string): string | null {
  if (date.length < 10) return null;
  const day = Number(date.slice(8, 10));
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  return date.slice(0, 10);
}

/** 日刻度文案，如「8/6」—— 刻度上横向空间很窄，年月由外车道与读数承担 */
export function formatDay(day: string): string {
  return `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
}

/** 完整「日」读数，如「2026 · 8月6日」 */
export function formatDayLabel(day: string): string {
  return `${day.slice(0, 4)} · ${formatMonth(day.slice(5, 7))}${Number(day.slice(8, 10))}日`;
}

/**
 * 时间刻度粒度：月（整份档案的分布）或日（逐日精读）。
 * 【为什么放在 core】它不只是一条轨的显示密度：轨上刻度、图墙分隔线、列表分组
 * 三处必须同时按它换口径。类型只留一份，三处就不可能各自产生一套「月/日」口径。
 */
export type TimeScale = 'month' | 'day';

/**
 * 按尺度取分组 / 分隔键：月尺度「YYYY-MM」、日尺度「YYYY-MM-DD」。
 * 与 monthKeyOf / dayKeyOf 同一套「日期缺失或不合法返回 null」的约定 ——
 * 调用方必须跳过 null，否则分组里会多出一档「0 月」/「0/0」。
 */
export function scaleKeyOf(date: string, scale: TimeScale): string | null {
  return scale === 'month' ? monthKeyOf(date) : dayKeyOf(date);
}

/**
 * 按尺度取完整文案：月尺度「2026 · 8月」、日尺度「2026 · 8月6日」。
 * 图墙分隔标签、列表分组标题、轨道读数三处共用这一份 —— 同一个刻度键
 * 在三个地方必须是同一句话，否则切换尺度时读者无法对应「这一段究竟是什么时间」。
 */
export function scaleLabelOf(key: string, scale: TimeScale): string {
  return scale === 'month' ? formatMonthLabel(key.slice(0, 4), key.slice(5, 7)) : formatDayLabel(key);
}