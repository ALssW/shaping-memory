/**
 * apps/mobile/src/components/TimelineRail.tsx
 *
 * 墙面底部的横向时间轨（展示层）：读数 + 一条三层叠放的时间轴 + 中心光带。
 * 与 Web 的 apps/web/src/components/ProgressRail.tsx 的**横向变体**逐条对应。
 *
 * 【模型：游标不动、尺子动】滑动点与读数钉在停靠条正中，整条时间线按 translateX 平移，
 * 因此这里**没有**「已走过的进度填充」，改由中心光带 + 呼吸表达「现在是哪一刻」。
 * 平移公式与 Web 的 .progress-rail__stage 一致（见 useWallRail 的说明）。
 *
 * 【为什么要有可视窗与舞台两层】时间线总长按内容算（密集处要摆得下全部刻度数字），
 * 可以比停靠条宽；超出视野的部分必须裁掉（否则数字会飘到照片上），
 * 因此由可视窗负责裁切、舞台负责承载长度与平移。
 *
 * 【滑块与光带为什么画在可视窗之外】它们钉在停靠条正中、不参与平移，
 * 而光晕要向上洇出停靠条 —— 留在 overflow: hidden 的可视窗里会被整块裁掉。
 *
 * 【横向为什么不做抽稀】纵向轨贴着整屏高度，天然装得下所以抽稀更合适；
 * 横向的时间轴会按内容加长（core 的 densifyMarks 给出 spanPx），
 * 摆不下就横向可滚 —— 刻度数字因此永远是全的。
 */
import { useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import type { GestureResponderHandlers } from 'react-native';
import type { RailLabel, RailMark } from '@shaping-memory/core';

import { Glass } from './primitives';
import { RAIL_DOCK_H, RAIL_VIEWPORT_H } from '../hooks/useWallRail';
import type { RailGeometry } from '../hooks/useWallRail';
import { easing } from '../layout/motion';
import { accentRgba, colors, fontSize, leading, metaTracking, radius, space, text, textRgba } from '../theme';

/* --------------------------------------------------------------------------
 * 时间轴内部的绘制尺寸：与 Web 的 .progress-rail--horizontal 各条逐字对应。
 * 它们是「一层时间轴怎么画」的绘制参数（Web 也写在 app.css 里），不是设计 token。
 * -------------------------------------------------------------------------- */
/** 轨道可拖高度（视觉细线 2px 居中，见 styles.baseline） */
const TRACK_H = space.s16;
/** 刻度短横线宽（横向时是竖线） */
const TICK_W = 2;
/** 小单位 / 大单位刻度的长短 */
const TICK_MINOR_H = 7;
const TICK_MAJOR_H = 13;
/** 内车道文字中心 = 第一行正中；轨道中心 = 内车道 16 + 间隙 6 + 半个轨高 */
const MINOR_Y = space.s16 / 2;
const TRACK_CENTER = space.s16 + space.s6 + TRACK_H / 2;
/** 外车道文字中心 = 最后一行正中 */
const MAJOR_Y = RAIL_VIEWPORT_H - space.s16 / 2;
/** 滑动点与中心光带所在的那一行（读数行 + 间隙 + 可视窗内的轨道中心） */
const OVERLAY_Y = space.s16 + space.s6 + TRACK_CENTER;
/** 刻度文字的居中容器宽：只用于把文字对准落点，靠 pointerEvents="box-none" 不抢触摸 */
const LABEL_BOX = 88;
/** 内 / 外车道标签的行高（与 text.meta / text.heading 一致，用于把文字居中在落点上） */
const MINOR_LINE = Math.round(fontSize.meta * leading.normal);
const MAJOR_LINE = Math.round(fontSize.heading * leading.normal);
/** 中心光带：宽度与透明度剖面（RN 没有 linear-gradient，用多段拼出「两端渐隐」） */
const FOCUS_W = space.s64 * 2;
const FOCUS_GLOW_H = space.s20;
const FOCUS_STOPS = [0.1, 0.3, 0.55, 0.8, 1, 0.8, 0.55, 0.3, 0.1];
/** 呼吸半周期：一整个来回 2600ms（与 Web 的 --rail-pulse-cycle 同值） */
const PULSE_MS = 1300;
/** 刻度短横线的两种强度：Web 是 text-quaternary 的 38% / 62%，换算到 text.base 的 alpha */
const TICK_ALPHA = 0.3 * 0.38;
const TICK_MAJOR_ALPHA = 0.3 * 0.62;
/** 轨道基线的强度：text-quaternary 的 24% */
const BASELINE_ALPHA = 0.3 * 0.24;

interface TimelineRailProps {
  /** 当前时间点（未格式化）：读数行与高亮都取它 */
  label: RailLabel | null;
  /** 落点整形后的刻度表（ratio 是落点、progress 是跳转目标） */
  marks: readonly RailMark[];
  /** 当前越过的刻度 key，用于高亮 */
  activeKey: string | null;
  /** 进度 0–1：驱动时间线平移 */
  progress: Animated.Value;
  geometry: RailGeometry;
  /** 点刻度 / 拖拽共用的跳转出口（一律传 mark.progress，不是 ratio）。
   *  点刻度时连同刻度 key 一起传：补批后刻度会被重算，重锚要靠 key 找回同一枚 */
  jumpTo: (progress: number, key?: string) => void;
  /** 拖拽命中区：整条停靠条都可拖（见 useWallRail） */
  panHandlers: GestureResponderHandlers;
}

/** 一枚刻度标签：把文字居中在落点上（容器透明、不抢触摸，只有文字本身可点） */
function MarkLabel({
  x,
  y,
  lineHeight,
  style,
  accessibilityLabel,
  onPress,
  children,
}: {
  x: number;
  y: number;
  lineHeight: number;
  style: object;
  accessibilityLabel: string;
  onPress: () => void;
  children: string;
}) {
  return (
    <View style={[styles.slot, { left: `${x * 100}%`, top: y - lineHeight / 2, height: lineHeight }]} pointerEvents="box-none">
      <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} hitSlop={4}>
        <Text style={style} numberOfLines={1}>
          {children}
        </Text>
      </Pressable>
    </View>
  );
}

export function TimelineRail({ label, marks, activeKey, progress, geometry, jumpTo, panHandlers }: TimelineRailProps) {
  /* 每一年（日尺度下是每一月）只在它的第一枚刻度处落一个大单位标签 */
  const majorMarks = useMemo(() => marks.filter((mark) => mark.isMajor), [marks]);

  /* 平移：进度 0 时最新一刻居中、进度 1 时最旧一刻也居中 */
  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [geometry.baseOffset, geometry.baseOffset - geometry.travel],
  });

  /* 中心光带的呼吸：常驻的环境光，缓动取 in-out 让两端停得住 */
  const pulse = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: PULSE_MS, easing: easing.inOut, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.55, duration: PULSE_MS, easing: easing.inOut, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const centerX = geometry.viewportW / 2;

  return (
    /* 停靠层：贴页面正下方、水平居中（宽度取 min(1040, 视口 − 48)，与 Web 的 .rail-dock 同构） */
    <View style={styles.layer} pointerEvents="box-none">
      <Glass corner="lg" blur="md" style={[styles.dock, { width: geometry.dockW }]}>
        {/* 命中区是整条内容区：任意位置都能拖，与 Web 的横向命中区落在轨根一致。
            滑块与光带也挂在这一层里 —— 它的左上角就是停靠条的内容盒原点（RN 的绝对定位
            不把父级内边距算进来，与 CSS 一致），这样 OVERLAY_Y 才与 Web 的
            「读数 16 + 间隙 6 + 轨心 30」逐字同源；挂在停靠条本身上会整整偏掉一个内边距。 */}
        <View {...panHandlers}>
          {/* 读数：居中一行，压在时间轴之上；它不随平移走 */}
          <Text style={styles.readout} numberOfLines={1}>
            {label?.text ?? ''}
          </Text>

          {/* 可视窗：只负责裁掉超出停靠条两端的刻度 */}
          <View style={styles.viewport}>
            <Animated.View style={[styles.stage, { width: geometry.stageW, transform: [{ translateX }] }]}>
              {/* 轨道与两层标签共用同一个起点（左右各让开端让位），同一个比例坐标才落在同一条竖线上 */}
              <View style={[styles.railBox, { width: geometry.travel }]}>
                <View style={styles.baseline} />

                {marks.map((mark) => (
                  /* 刻度短横线不接事件：整条轨的拖拽命中区必须保持完整（文字标签在上一层） */
                  <View
                    key={mark.key}
                    pointerEvents="none"
                    style={[
                      styles.tick,
                      {
                        left: `${mark.ratio * 100}%`,
                        height: mark.isMajor ? TICK_MAJOR_H : TICK_MINOR_H,
                        top: TRACK_CENTER - (mark.isMajor ? TICK_MAJOR_H : TICK_MINOR_H) / 2,
                        backgroundColor:
                          mark.key === activeKey ? colors.accent : textRgba(mark.isMajor ? TICK_MAJOR_ALPHA : TICK_ALPHA),
                      },
                    ]}
                  />
                ))}

                {marks.map((mark) => (
                  <MarkLabel
                    key={mark.key}
                    x={mark.ratio}
                    y={MINOR_Y}
                    lineHeight={MINOR_LINE}
                    style={[styles.minor, mark.key === activeKey && styles.minorOn]}
                    accessibilityLabel={`跳到 ${mark.text}`}
                    onPress={() => jumpTo(mark.progress, mark.key)}
                  >
                    {mark.label}
                  </MarkLabel>
                ))}

                {majorMarks.map((mark) => (
                  <MarkLabel
                    key={mark.key}
                    x={mark.ratio}
                    y={MAJOR_Y}
                    lineHeight={MAJOR_LINE}
                    style={[styles.major, mark.key === label?.majorKey && styles.majorOn]}
                    accessibilityLabel={`跳到 ${mark.majorLabel} 起点`}
                    onPress={() => jumpTo(mark.progress, mark.key)}
                  >
                    {mark.majorLabel}
                  </MarkLabel>
                ))}
              </View>
            </Animated.View>
          </View>

          {/* 下滑动点：钉在正中（游标不动），位置不参与平移，因此画在可视窗之外 */}
          <View style={[styles.thumbRing, { left: centerX - 9.5, top: OVERLAY_Y - 9.5 }]} pointerEvents="none">
            <View style={styles.thumbDot} />
          </View>

          {/* 中心光带：渐隐 accent + 向上洇开的柔光 + 缓慢呼吸（横向版唯一的「现在」装饰） */}
          <Animated.View
            pointerEvents="none"
            style={[styles.focusWrap, { left: centerX - FOCUS_W / 2, top: OVERLAY_Y - FOCUS_GLOW_H - 1, opacity: pulse }]}
          >
            <View style={styles.focusGlow} />
            <View style={styles.focusBar}>
              {FOCUS_STOPS.map((stop, index) => (
                <View key={index} style={{ flex: 1, backgroundColor: accentRgba(stop) }} />
              ))}
            </View>
          </Animated.View>
        </View>
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  /* 停靠层：占满整行、把停靠条水平居中；box-none 让停靠条以外的点击照常落到照片上 */
  layer: { position: 'absolute', left: 0, right: 0, bottom: space.s24, alignItems: 'center' },
  dock: { height: RAIL_DOCK_H, paddingHorizontal: space.s16, paddingVertical: space.s8, justifyContent: 'center' },

  readout: {
    ...text.meta,
    ...metaTracking,
    height: space.s16,
    lineHeight: space.s16,
    textAlign: 'center',
    color: colors.text.secondary,
    fontWeight: '500',
  },

  viewport: { height: RAIL_VIEWPORT_H, marginTop: space.s6, overflow: 'hidden' },
  stage: { height: RAIL_VIEWPORT_H },
  railBox: { position: 'absolute', left: space.s24, top: 0, height: RAIL_VIEWPORT_H },

  baseline: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: TRACK_CENTER - 1,
    height: 2,
    borderRadius: 1,
    backgroundColor: textRgba(BASELINE_ALPHA),
  },
  tick: { position: 'absolute', width: TICK_W, marginLeft: -TICK_W / 2, borderRadius: 1 },

  slot: {
    position: 'absolute',
    width: LABEL_BOX,
    marginLeft: -LABEL_BOX / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  minor: { ...text.meta, ...metaTracking, color: textRgba(0.3), fontWeight: '500' },
  minorOn: { color: colors.accent, fontWeight: '600' },
  major: { ...text.heading, ...metaTracking, color: colors.text.tertiary },
  majorOn: { color: colors.accent },

  thumbRing: {
    position: 'absolute',
    width: 19,
    height: 19,
    borderRadius: radius.full,
    backgroundColor: accentRgba(0.26),
    alignItems: 'center',
    justifyContent: 'center',
    /* 向上洇开的柔光（与 Web 的 box-shadow 同一层语义） */
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: -space.s6 },
    shadowRadius: space.s16,
    shadowOpacity: 0.42,
  },
  thumbDot: { width: 11, height: 11, borderRadius: radius.full, backgroundColor: colors.accent },

  focusWrap: { position: 'absolute', width: FOCUS_W, height: FOCUS_GLOW_H + 1 + 2 },
  focusGlow: { height: FOCUS_GLOW_H, borderRadius: radius.full, backgroundColor: accentRgba(0.05) },
  focusBar: { flexDirection: 'row', height: 2, marginTop: 1, borderRadius: 1, overflow: 'hidden' },
});
