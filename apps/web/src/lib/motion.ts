/**
 * apps/web/src/lib/motion.ts
 *
 * Motion 动效基线层：整个 Web 端的动画参数都必须从这里取。
 *
 * 【为什么要有这一层】Motion 的过渡对象（duration / ease / bounce）是 JS 值，
 * 不能像 CSS 那样直接 `var(--motion-spring-smooth)`。如果每个组件各写一份
 * `{ type: 'spring', duration: 0.4, bounce: 0.15 }`，等于把 token 抄了 N 遍，
 * 迟早与 tokens.json 产生不一致。这里统一从 @shaping-memory/design-tokens 派生，
 * 组件里因此不再允许出现手写的时值、缓动或弹簧参数。
 *
 * 【两套模型，与规范 §3.9 一致】
 *   - 空间运动（位置 / 尺寸 / 缩放）→ spring，Web 无 spring CSS 时的近似是 easing
 *   - 非空间状态（opacity / color）→ duration + easing
 */
import { tokens } from '@shaping-memory/design-tokens';
import type { Transition } from 'motion/react';

/** token 里的时长是 '200ms' 字符串，Motion 只认秒 */
const toSeconds = (value: string) => Number.parseFloat(value) / 1000;

/** token 的四段贝塞尔控制点是只读元组，Motion 的 Easing 要求可变元组 */
const bezier = (points: readonly number[]): [number, number, number, number] => [
  points[0]!,
  points[1]!,
  points[2]!,
  points[3]!,
];

/** 非空间状态变化：淡出淡入、颜色过渡 */
export const fade = (key: keyof typeof tokens.motion.duration = 'base'): Transition => ({
  duration: toSeconds(tokens.motion.duration[key]),
  ease: bezier(tokens.motion.easing.smooth),
});

/**
 * 空间运动：tokens.motion.spring.* 的形状（duration + bounce）与 Motion 的
 * spring 过渡完全同构，因此这里只是加一个 `type` 标记，不引入任何新的数值。
 */
export const spring = (
  key: keyof typeof tokens.motion.spring = 'smooth',
): Transition => ({
  type: 'spring',
  duration: tokens.motion.spring[key].duration,
  bounce: tokens.motion.spring[key].bounce,
});

/** 常用组合：避免每处重复书写 spring('abc') */
export const springs = {
  /** 默认档：位置与尺寸的常规变化 */
  smooth: spring('smooth'),
  /** 控件、开关、需要一点回弹的小元素 */
  snappy: spring('snappy'),
  /** 回弹档（bouncy）：回弹幅度最大，克制使用 */
  bouncy: spring('bouncy'),
} as const;

/**
 * useSpring 的配置。钩子只接受 duration / bounce 这两种简写，
 * 因此不能直接复用 spring() 的返回值 —— 但数值同样来自 tokens.motion.spring.*。
 */
export const springOptions = (key: keyof typeof tokens.motion.spring = 'smooth') => ({
  duration: tokens.motion.spring[key].duration,
  bounce: tokens.motion.spring[key].bounce,
});

/**
 * 重排（FLIP）：元素在两次渲染之间换了位置，用 transform 从旧位置补间到新位置。
 * 场景只有一个 —— 时间刻度粒度（月 / 日）切换时，分组边界与分隔线数量整体重算，
 * 照片的新位置与旧位置之间没有任何连续性，不补间就是一次硬跳。
 * 取值直接复用 smooth 弹簧：位移属于空间运动，本层其它位移（聚拢、抬起）也走这一档，
 * 切换刻度与悬停照片因此采用同一套动效；位移可能跨好几个分组（上百像素），bounce 0 收尾干净。
 */
export const reorder: Transition = springs.smooth;

/** 拖动 / 直接跟随时必须逐帧到位，不能有补间：显式关掉过渡 */
export const INSTANT: Transition = { duration: 0 };

/* -------------------------------------------------------------------------- */
/* 手势配方：hover / tap 的默认反馈，三个视图共用同一套交互反馈                  */
/* -------------------------------------------------------------------------- */

/**
 * 鼠标进入：放大到这一档。
 * 照片跟着卡片同比放大（照片本身不再反向缩放，见 PhotoTile），
 * 因此这一个值同时决定了卡片与照片的放大感 —— 1.05 是能明显看出层级变化、
 * 又不会让密集瀑布流里的邻位被压住的一档。
 */
export const HOVER_LIFT = 1.05;

/**
 * 鼠标进入时向上抬起的高度（px，负值是向上）。
 * 只给墙面卡片：密集的缩略图网格里向上让位会吃掉与上一行的间距。
 * 与 HOVER_LIFT 搭配成「先被拿起来、再慢慢放大」的观感。
 */
export const HOVER_LIFT_Y = -6;

/** 按下：略低于 1，做出「按进去」的即时反馈 */
export const PRESS_SINK = 0.985;

/**
 * 指针附着的位移半径（px）：指针贴到卡片边缘时，整张卡片朝那一侧挪这么远。
 * 位移挂在**卡片本身**（不是内层照片）—— 需求是「照片框随鼠标轻微附着」，
 * 只动内层会变成「框不动、里面的照片在滑」。
 * 取值与聚拢上限同量级：邻位朝它收拢的空间刚好容得下这点位移，不会互相压穿。
 */
export const ATTACH_RANGE = 7;

/* -------------------------------------------------------------------------- */
/* 聚拢：hover 的那张抬起时，周围以它为圆心轻轻向它靠拢，形成聚焦                  */
/* -------------------------------------------------------------------------- */

/**
 * 位移距离的上限（px），落在最近的那一圈邻位上。
 * 取值只做「看得见的轻推」：12px 会盖住邻位本身，这里收到原值的 42%（约 5px），
 * 于是整面墙只是朝焦点轻轻收拢一下，不会挤压出空洞。
 * 离开时以同样的距离反向推出去（见 useRipple 的释放相位）。
 */
export const PUSH_RANGE = 5;

/**
 * 聚拢半径，单位是「一个卡片宽」（距离已按卡片尺寸归一化）。
 * 它现在只决定**衰减的缓急**，不再决定「哪些元素参与运动」—— 有 PUSH_FLOOR 保底，
 * 半径之外的远处照片同样会跟着动，只是力度收到保底档。
 */
export const PUSH_RADIUS = 2.2;

/**
 * 远处照片的保底力度（0–1）。
 * 需求是「全屏所有照片同步跟随移动」，所以衰减到半径之外不能直接归零 ——
 * 否则只有焦点附近两张在动，屏幕另一半纹丝不动。保底档与上限相乘后约 2px：
 * 远到几乎察觉不到是「位移」，但整面墙的呼吸是一致的。
 */
export const PUSH_FLOOR = 0.4;

/**
 * 聚拢强度：按距离线性衰减，衰减到保底档为止。
 * @param gap 与 hover 照片的距离，已除以卡片尺寸（0 = 就是它自己）
 * @returns 0–1 的力度系数（只有「就是它自己」才是 0）
 */
export function pushFalloff(gap: number): number {
  if (gap <= 0) return 0;
  return Math.max(PUSH_FLOOR, 1 - gap / PUSH_RADIUS);
}

/**
 * 邻位「释放」相位时长（ms）：鼠标离开后，邻位先朝反方向扩散这么久，
 * 随后才弹回原位 —— 两段式比单靠弹簧过冲清晰得多（smooth 档 bounce 0 本就不过冲）。
 * 取 slow 档：推出去的那一下是「反馈」，需要看得见，不能一闪而过。
 */
export const PUSH_RELEASE_MS = toSeconds(tokens.motion.duration.slow) * 1000;