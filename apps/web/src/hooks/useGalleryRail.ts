/**
 * apps/web/src/hooks/useGalleryRail.ts
 *
 * 画廊时间轨的 Web 适配层：把 core 的纯计算（刻度生成、落点整形、读数判定）
 * 接到「量 DOM 真实几何」与 React 生命周期上。
 *
 * 【读数只看一处】「现在是哪个月」只有一份答案 —— 由 core 的 labelAtProgress 给出，
 * 刻度高亮直接取这一份（activeKey），不再用第二套公式（曾经按下标比例找
 * 「已越过的最后一枚刻度」）去猜。两套公式必然在边界上冲突：同一屏里
 * 读数说 6 月、高亮却停在 7 月，正是这个原因。
 *
 * 【两种排布，同一把尺子】墙面是「时间分段 + 段内 N 列轮转」、列表是单列分组，
 * DOM 顺序完全不同，但刻度与读数只有一份基准 —— 这里量出每张 [data-photo] 节点的
 * **真实几何**，归约成 core 的 RailAnchor 后交给 buildMeasuredMarks：
 *   - 刻度位置 = 每个时间单位在滚动范围里最靠上的实际像素比例（跨列取最小值）。
 *     月尺度下刻度间距天然够大；日尺度下刻度间距被摊薄到几十像素，跨列的相对高低
 *     就不再与时间序一致（早期纯轮转分列时实测 8/9 落在 8/12 之上）。
 *     墙面改为时间分段后每个时间单位独占一条横带，这个错位已不存在，
 *     但「跨列取最小值」这条口径仍然保留 —— 它不假设排布，列表与墙面共用同一把尺子。
 *     纵向轨贴着整屏高度摊得开，直接用它；横向轨只有一屏宽，落点改由 densifyMarks 整形。
 *   - 当前读数 = 最后一枚「入口已经越过判定线」的刻度。读数直接读刻度表，
 *     与高亮、点击跳转是同一份数据 —— 墙面多列同屏并存多个月份时，曾经按
 *     「最新一张可见照片」读数会被最高的那一列主导（滚到 45% 还报 9 月），
 *     刻度口径则在任何视图、任何进度下都给出同一个月份。
 *
 * 【拖拽时为什么不能复用进度】刻度位置按「像素准确、互相不叠」两条要求整形过，
 * 而拖动要的是「手指走多少、时间线走多少」，两者的分母不同 —— 因此按下拖拽期间
 * 只认 progress，落点由 densifyMarks 的结果负责画（见 ProgressRail）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  buildMeasuredMarks,
  clamp01,
  densifyMarks,
  labelAtProgress,
  labelEveryFor,
  sameMarks,
} from '@shaping-memory/core';
import type { Photo, RailAnchor, RailLabel, RailMark } from '@shaping-memory/core';

import { progressDenom, useProgressRail } from './useProgressRail';
import type { RailOrientation, RailScale, RailStrategy } from './useProgressRail';

/* 刻度与读数的类型定义已上移到 core（见 rail.ts），这里原样转发，
   免得调用方为了一个类型多引一个包。 */
export type { RailMark };

/**
 * 量出每张照片（[data-photo] 节点）距容器顶的真实像素，并换算成与 progress 同源的比例。
 * 一趟 querySelectorAll + 一趟 rect 读取，结果按时间下标排序 ——
 * 墙面的 DOM 是列优先的，列表的 DOM 才是时间序，排序后两种排布就共用同一套锚点。
 */
function measureAnchors(container: HTMLElement, ordered: readonly Photo[]): RailAnchor[] {
  const base = container.getBoundingClientRect();
  const denom = progressDenom(base);
  const indexOf = new Map(ordered.map((photo, index) => [photo.id, index]));
  const anchors: RailAnchor[] = [];

  for (const node of container.querySelectorAll<HTMLElement>('[data-photo]')) {
    const index = indexOf.get(node.dataset.photo ?? '');
    if (index === undefined) continue;
    const rect = node.getBoundingClientRect();
    anchors.push({
      index,
      /* 夹取到 0–1：末枚刻度所在的照片可能落在滚动范围之外（墙面最后一列的列尾），
         不夹取就会算出 ratio > 1，让标签溢出舞台右缘并凭空撑出一条滚动条 */
      top: clamp01((rect.top - base.top) / denom),
    });
  }

  return anchors.sort((left, right) => left.index - right.index);
}

export function useGalleryRail(
  ordered: readonly Photo[],
  ariaLabel: string,
  scale: RailScale = 'month',
  orientation: RailOrientation = 'vertical',
) {
  /** 刻度表存一份给 read()：读数与渲染用的必须是同一张表 */
  const marksRef = useRef<readonly RailMark[]>([]);
  /** 视口尺寸变化要把锚点作废重测（列表行高随宽度变、墙面列数随断点变） */
  const [revision, setRevision] = useState(0);
  const [measuredMarks, setMeasuredMarks] = useState<readonly RailMark[]>([]);

  /* 读数策略的引用身份必须随 ordered / scale 变 —— useProgressRail 靠它重跑测量。
     两个视图共用 labelAtProgress 这一份判定，刻度表从 ref 读（测量后即时可用）。 */
  const strategy = useMemo<RailStrategy>(
    () => ({
      read: (progress: number): RailLabel | null =>
        labelAtProgress(marksRef.current, ordered, progress, scale),
    }),
    [ordered, scale],
  );

  const rail = useProgressRail(strategy, ariaLabel, orientation);
  const { containerRef } = rail;

  useEffect(() => {
    const onResize = () => setRevision((count) => count + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* 布局后量一次真实位置，并一并把结果交给 read() 使用（写 ref，滚动时立即可见）。
     useLayoutEffect 里 setState 会在浏览器绘制前同步重渲染，因此刻度不会
     「先按下标比例错一下、再跳回真实位置」，切换月/日尺度时也不会闪一帧旧刻度。
     墙面与列表走的是同一条路径。 */
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const anchors = measureAnchors(container, ordered);

    const next = buildMeasuredMarks(ordered, anchors, scale);
    marksRef.current = next; // 先提供给 read()，setState 的重渲染发生在同一帧绘制前
    setMeasuredMarks((previous) => (sameMarks(previous, next) ? previous : next));
  }, [ordered, scale, revision, containerRef]);

  /* 刻度统一取真实锚点版：位置、时间标记、排序因此与列表视图逐字同源 */
  const marks = measuredMarks;

  /* 横向轨的落点整形（纵向不需要：整屏高度天然摊得开，也不该改动位置）。
     返回的 spanPx 是舞台所需宽度，只加长不缩短，摆得下时落点即真实比例。 */
  const laid = useMemo(() => (orientation === 'horizontal' ? densifyMarks(marks) : null), [marks, orientation]);
  const spanPx = laid?.spanPx ?? 0;

  /* 高亮取 read() 那一份读数 —— 单一事实源，读数与高亮不可能产生分歧 */
  const activeKey = rail.label && marks.some((mark) => mark.key === rail.label!.key) ? rail.label.key : null;

  return { ...rail, marks: laid?.marks ?? marks, activeKey, labelEvery: labelEveryFor(marks), spanPx };
}
