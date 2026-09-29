/**
 * apps/mobile/src/layout/useBreakpoint.ts
 *
 * 把「当前窗口有多宽」翻译成布局口径（档位、列数、形态）。
 *
 * 【为什么断点值与列数都在 core】它们是 Web 与移动端共用的**行为口径**：
 * 800dp 的平板在两端都必须得到 3 列。这里只做一件事 —— 把 RN 的实时窗口尺寸
 * 接到那份共用口径上，不重新定义任何阈值。
 *
 * 【为什么用 useWindowDimensions 而不是 Dimensions.get】旋转、分屏、折叠
 * 都会改变窗口尺寸，`Dimensions` 只在首次求值，且不会触发重渲染；
 * `useWindowDimensions` 是订阅式的，转屏时组件会自己重排。
 */
import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { listColumnCount, viewportTier, wallColumnCount } from '@shaping-memory/core';
import type { ViewportTier } from '@shaping-memory/core';

/**
 * 平板的判据取「最短边」而不是当前宽度。
 * 若按宽度判，平板竖屏（800）算平板、同一台机器转成横屏（1280）也该算 ——
 * 中间一旦有比窄的形态就会误判；最短边在旋转前后是同一个数，设备身份才稳定。
 * 600dp 是 Android 自 sw600dp 以来的既有分界，不是新造的阈值。
 */
const TABLET_MIN_SHORTEST_SIDE = 600;

export interface Breakpoint {
  /** 当前窗口宽（dp）。逻辑宽会随旋转变化，是分档的唯一输入 */
  width: number;
  /** 当前窗口高（dp） */
  height: number;
  /** 断点档位：sm / md / lg / xl */
  tier: ViewportTier;
  isLandscape: boolean;
  /** 是否平板形态（按最短边判定，旋转不改变结论） */
  isTablet: boolean;
  /** 图墙列数：与 Web 同一个函数算出来 */
  wallColumns: number;
  /** 列表缩略图列数 */
  listColumns: number;
}

export function useBreakpoint(): Breakpoint {
  const { width, height } = useWindowDimensions();

  /* 依赖只有宽高：转屏是这两个数互换，分屏是其中一个数变，两者都会重算 */
  return useMemo(
    () => ({
      width,
      height,
      tier: viewportTier(width),
      isLandscape: width > height,
      isTablet: Math.min(width, height) >= TABLET_MIN_SHORTEST_SIDE,
      wallColumns: wallColumnCount(width),
      listColumns: listColumnCount(width),
    }),
    [width, height],
  );
}
