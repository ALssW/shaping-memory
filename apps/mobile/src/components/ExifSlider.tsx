/**
 * apps/mobile/src/components/ExifSlider.tsx
 *
 * 自建滑块（不引 @react-native-community/slider）：RN 0.76 已移除内置 Slider，
 * 而这一档需求只是「在给定区间里取一个带步进的数值」。用 PanResponder 把
 * 触点的横向位置直接换算成值即可，不必为一个控件引入新的原生依赖。
 *
 * 【为什么拇指位置不用 Animated】拖动过程中每一帧都要把值回报给输入框，
 * 值本身是受控状态；拇指位置按 ratio 直接算出来更简单，也不会出现动画与状态不同步。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import type { GestureResponderEvent } from 'react-native';

import { colors, radius } from '../theme';

/** 拇指直径 */
const THUMB = 20;
/** 轨道粗细 */
const TRACK = 4;
/** 可触高度：拇指小，命中区要放大到手指尺度 */
const HIT = 32;

/** step 的小数位（0.0001 → 4），用于把浮点噪声截掉 */
function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** 把任意数吸附到 [min,max] 上、按 step 对齐，避免 0.30000000000000004 这类浮点尾巴 */
export function snap(value: number, min: number, max: number, step: number): number {
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
  const clamped = Math.min(max, Math.max(min, value));
  const stepped = Math.round((clamped - min) / safeStep) * safeStep + min;
  return Number(Math.min(max, Math.max(min, stepped)).toFixed(decimalsOf(safeStep)));
}

interface ExifSliderProps {
  /** 当前值；null = 未设置（拇指停在最左） */
  value: number | null;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export function ExifSlider({ value, min, max, step, disabled = false, onChange }: ExifSliderProps) {
  const [width, setWidth] = useState(0);
  /* 最新几何与回调放进 ref：响应器只建一次，读数始终取最新，不必随 props 重建 */
  const live = useRef({ width: 0, min, max, step, disabled, onChange });
  live.current = { width, min, max, step, disabled, onChange };

  const emit = useCallback((x: number) => {
    const state = live.current;
    if (state.disabled || state.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, x / state.width));
    state.onChange(snap(state.min + ratio * (state.max - state.min), state.min, state.max, state.step));
  }, []);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !live.current.disabled,
        onMoveShouldSetPanResponder: () => !live.current.disabled,
        onPanResponderGrant: (event: GestureResponderEvent) => emit(event.nativeEvent.locationX),
        onPanResponderMove: (event: GestureResponderEvent) => emit(event.nativeEvent.locationX),
      }),
    [emit],
  );

  const range = max > min ? max - min : 1;
  const ratio = value == null ? 0 : Math.min(1, Math.max(0, (value - min) / range));

  return (
    <View
      {...pan.panHandlers}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessibilityRole="adjustable"
      accessibilityLabel="数值滑块"
      accessibilityValue={{ min, max, now: value ?? min }}
      style={[styles.hit, disabled && styles.disabled]}
    >
      {/* 子视图都不接受触摸（pointerEvents=none）：触点始终落在外层，locationX 才是相对轨道的坐标 */}
      <View pointerEvents="none" style={styles.track} />
      <View pointerEvents="none" style={[styles.fill, { width: ratio * width }]} />
      <View pointerEvents="none" style={[styles.thumb, { left: Math.max(0, ratio * width - THUMB / 2) }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  hit: { flex: 1, height: HIT, justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  track: {
    height: TRACK,
    borderRadius: radius.full,
    backgroundColor: colors.material.ultraThin,
  },
  fill: {
    position: 'absolute',
    left: 0,
    height: TRACK,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.background,
  },
});
