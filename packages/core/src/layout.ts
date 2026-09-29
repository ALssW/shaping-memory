/**
 * packages/core/src/layout.ts
 *
 * 响应式布局口径的唯一事实源：断点、列数、分列算法。
 *
 * 【为什么放在 core 而不是 design-tokens】tokens.json 是 DTCG 的**视觉原子**
 * （颜色、间距、圆角），而断点是**行为口径** —— 它决定「几列」「侧栏出不出」，
 * 与 sortByDate / scaleKeyOf 同级。Web 与移动端必须给出同一个答案，
 * 一旦各自维护一份，窄一像素就会分叉成两套布局。
 *
 * 【为什么断点值是 769 / 1024 / 1440】这三个数不是新造的：它们是 Web 端
 * 改造前那几条 CSS 媒体查询的原始取值，上移到这里只是把「唯一一份」从
 * CSS 迁到 TypeScript，Web 行为完全不变（纯迁移）。
 */

/** 视口断点（逻辑像素 / dp）。md 档 769 是「手机横屏与小平板」的分界 */
export const VIEWPORT_BREAKPOINTS = { md: 769, lg: 1024, xl: 1440 } as const;

/**
 * 页头标语的最小视口宽：再窄就让位给导航胶囊（操作入口优先于气质）。
 * 与 Web 的 `@media (max-width: 899px) { .brand__sub { display: none } }` 同一个数 ——
 * CSS 媒体查询没法 import 这个常量，两边靠这条注释对齐。
 */
export const BRAND_SLOGAN_MIN_WIDTH = 900;

/**
 * 查看器改用「侧栏 EXIF」的最小视口宽：再窄就只能把 EXIF 挪到照片下方。
 * 与 Web `apps/web/src/components/Viewer.tsx` 的 `WIDE_MIN` 同一个数（那里的
 * 注释指向 `@media (max-width: 899px)`）—— 800dp 的平板竖屏两端都得走下方分支，
 * 否则右侧栏扣掉 256dp 后照片只剩一半宽，比手机竖屏更差。
 */
export const VIEWER_WIDE_MIN_WIDTH = 900;

/** 断点档位名。sm = 手机竖屏，md = 手机横屏 / 小平板，lg = 大平板横屏，xl = 桌面宽屏 */
export type ViewportTier = 'sm' | 'md' | 'lg' | 'xl';

/**
 * 宽度落在哪一档。
 * 判据只有宽度：高度由内容滚动承担，不参与布局分档（与 Web 媒体查询一致）。
 */
export function viewportTier(width: number): ViewportTier {
  if (width >= VIEWPORT_BREAKPOINTS.xl) return 'xl';
  if (width >= VIEWPORT_BREAKPOINTS.lg) return 'lg';
  if (width >= VIEWPORT_BREAKPOINTS.md) return 'md';
  return 'sm';
}

/**
 * 图墙列数：宽屏铺得更开，窄屏保住卡片可辨尺寸。
 * 原样上移自 Web 的 columnCountFor，两端的列数从此是同一个函数算出来的。
 */
export function wallColumnCount(width: number): number {
  if (width >= VIEWPORT_BREAKPOINTS.xl) return 5;
  if (width >= VIEWPORT_BREAKPOINTS.lg) return 4;
  if (width >= VIEWPORT_BREAKPOINTS.md) return 3;
  return 2;
}

/**
 * 列表缩略图列数：墙面列数 + 1。
 *
 * 【为什么是「+1」而不是另一套断点】列表里的格子只有照片没有配文，
 * 横向能容纳的密度天然比墙面高一档；沿用同一组断点做偏移，
 * 两视图的换档时刻就是对同一个宽度同时发生，不会出现「墙面仍为 3 列、列表已变为 5 列」。
 */
export function listColumnCount(width: number): number {
  return wallColumnCount(width) + 1;
}

/**
 * 按轮转把一组照片分发到 N 列：第 i 张进第 i % N 列。
 *
 * 【为什么是轮转而不是「切成 N 段各占一列」】后者是列优先填充，同一行里
 * 从左往右读时间反而是跳跃的（第 1 列最新、第 5 列最旧）。轮转后
 * 「横向紧邻」= 「时间紧邻」，从左往右读过去就是时间推进的方向，
 * 与墙面「时间从左到右」的阅读方向同构。
 *
 * 泛型是为了两端共用一个实现：Web 传 GroupItem、移动端传 Photo，
 * 分发规则本身与元素类型无关。
 */
export function splitIntoColumns<T>(items: readonly T[], count: number): T[][] {
  const columns: T[][] = Array.from({ length: count }, () => []);
  items.forEach((item, position) => {
    columns[position % count]!.push(item);
  });
  return columns;
}
