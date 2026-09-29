/**
 * apps/mobile/src/layout/motion.ts
 *
 * RN 端动效基线层：与 apps/web/src/lib/motion.ts 对称，组件里不允许出现手写时值。
 *
 * 【两套模型，与规范 §3.9 一致】
 *   空间运动（位置 / 尺寸 / 缩放）→ Animated.spring
 *   非空间状态（opacity）→ Animated.timing + motion.easing.smooth
 *
 * 【(duration, bounce) 怎么变成 RN 的弹簧参数】token 用的是 SwiftUI 口径的
 * duration + bounce，而 Animated.spring 认的是 stiffness / damping / mass。
 * 按标准二阶系统换算（质量取 1）：
 *   ω₀ = 2π / duration        stiffness = ω₀²
 *   ζ  = 1 − bounce           damping   = 2ζω₀
 * bounce 为 0 即临界阻尼（ζ = 1），正好对应 token 里 smooth 档「收尾干净不过冲」的描述。
 */
import { Easing } from 'react-native';
import { tokens } from '@shaping-memory/design-tokens';

/** token 的时长是 '200ms'，Animated 只认毫秒数 */
const toMs = (value: string) => Number.parseFloat(value);

export const duration = {
  fast: toMs(tokens.motion.duration.fast),
  base: toMs(tokens.motion.duration.base),
  slow: toMs(tokens.motion.duration.slow),
} as const;

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
  /** transform / opacity 都在原生侧驱动，必须开，否则每帧都要过 JS 线程 */
  useNativeDriver: boolean;
}

export function spring(key: keyof typeof tokens.motion.spring = 'smooth'): SpringConfig {
  const { duration: seconds, bounce } = tokens.motion.spring[key];
  const omega = (2 * Math.PI) / seconds;
  return {
    stiffness: omega * omega,
    damping: 2 * (1 - bounce) * omega,
    mass: 1,
    useNativeDriver: true,
  };
}

/** 常用组合：避免每处重复书写 spring('...') */
export const springs = {
  /** 默认档：布局、进出场、共享元素 */
  smooth: spring('smooth'),
  /** 控件与开关：需要一点回弹以确认操作 */
  snappy: spring('snappy'),
  /** 回弹档（bouncy）：回弹幅度最大，克制使用 */
  bouncy: spring('bouncy'),
} as const;

/** 非空间状态用的时间曲线。token 的四段控制点是只读元组，Easing 要求可变元组 */
const bezier = (points: readonly number[]): [number, number, number, number] => [
  points[0]!,
  points[1]!,
  points[2]!,
  points[3]!,
];

export const easing = {
  smooth: Easing.bezier(...bezier(tokens.motion.easing.smooth)),
  snappy: Easing.bezier(...bezier(tokens.motion.easing.snappy)),
  inOut: Easing.bezier(...bezier(tokens.motion.easing.inOut)),
} as const;

/* -------------------------------------------------------------------------- */
/* 手势配方：与 Web 的 HOVER_LIFT / HOVER_LIFT_Y / PRESS_SINK 同一处口径          */
/* -------------------------------------------------------------------------- */

/**
 * 按下时抬起到的放大倍率。
 * 触屏没有 hover，Web 的「悬停抬起」语义只能挪到按下这一步：手指压住的瞬间
 * 这张照片就浮起来，明确告诉用户「松开就是打开这一张」。
 * 比 Web 的 1.05 收一档 —— 手指本身已经遮住卡片一角，再放大反而看不清边缘。
 */
export const PRESS_LIFT = 1.02;

/** 抬起时向上让位的高度（负值向上）。同样按触屏收一档（Web 是 -6） */
export const PRESS_LIFT_Y = -2;

/** 按下：略低于 1，做出「按进去」的即时反馈（与 Web 的 PRESS_SINK 同数） */
export const PRESS_SINK = 0.985;

/** 查看器进出场的起始缩放：略小于 1，进场是「长出来」而不是硬切 */
export const VIEWER_ENTER_SCALE = 0.96;
