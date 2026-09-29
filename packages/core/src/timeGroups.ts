/**
 * packages/core/src/timeGroups.ts
 *
 * 把日期有序的照片流按「当前刻度粒度」切成段：墙面分段与列表分组共用同一份口径。
 *
 * 【为什么必须在 core】分组的边界就是轨上刻度的边界，也是分隔线的位置。
 * 三处各写一份实现，迟早会对同一条边界给出不同答案（轨上写着「8月6日」、
 * 分组头写着「8月」），因此分组键统一取 scaleKeyOf、标题统一取 scaleLabelOf，
 * 这里只负责「怎么切」，不负责「按什么切」。
 *
 * 【为什么输入必须是已排序的】输入有序时只需与上一段比较，不必做 Map 归并，
 * 输出顺序天然就是时间序。调用方各自用 sortByDate 排出有序副本。
 */
import { scaleKeyOf, scaleLabelOf, UNDATED_KEY, UNDATED_LABEL } from './timeline';
import type { TimeScale } from './timeline';
import type { Photo } from './types';

/** 分组内的一张：photo 供渲染，index 是它在整份有序列表里的全局下标（查看器翻页要用） */
export interface GroupItem {
  photo: Photo;
  index: number;
}

/** 一个时间分组：key 用于 React 复用，label 是给读者看的标题（年月 / 年月日） */
export interface TimeGroup {
  key: string;
  label: string;
  items: GroupItem[];
}

/**
 * 按当前刻度粒度切段：月尺度一段 = 一个年月，日尺度一段 = 一天。
 * 全局下标在建组时一并写入，省去渲染期一次 O(n²) 的 indexOf 反查。
 */
export function buildTimeGroups(ordered: readonly Photo[], scale: TimeScale): TimeGroup[] {
  const groups: TimeGroup[] = [];
  ordered.forEach((photo, index) => {
    const key = scaleKeyOf(photo.date, scale) ?? UNDATED_KEY;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push({ photo, index });
      return;
    }
    groups.push({
      key,
      label: key === UNDATED_KEY ? UNDATED_LABEL : scaleLabelOf(key, scale),
      items: [{ photo, index }],
    });
  });
  return groups;
}
