/**
 * apps/mobile/src/components/ZoomableImage.tsx
 *
 * 可缩放 / 可平移的照片层：双击在「放大态」与「适配态」之间切换、双指捏合缩放、
 * 放大后单指拖动平移。三件事都用 RN 内置能力（PanResponder + Animated）实现，
 * 项目不引入手势库。
 *
 * 【真值为什么放在 JS 侧 ref】手势过程中要随时按边界夹取与阻尼，必须同步读到当前
 * scale / 位移；Animated 的值走原生驱动时读回来是异步的，因此 ref 是真值，
 * Animated.Value 只是「画出来的那一份」。三个叶子节点（scale / tx / ty）共用同一条
 * 弹簧口径（springs.smooth）—— 二维平移需要两个正交自由度、缩放再要一个，
 * 一个 Animated.Value 表达不了三者（强用 interpolate 拼装会让每帧重算插值区间）。
 *
 * 【与查看器横滑翻页如何共存】触摸一开始本组件就接管（双击要靠两次 grant 的时间戳
 * 判定，捏合也要从第一根手指起计数），但**允许被夺权**：只要还没放大，就让
 * onResponderTerminationRequest 放行 —— 查看器「明显横滑」的判定照旧能接管并翻页；
 * 一旦放大（或两指在手）就拒绝夺权，拖动只平移照片，既不误翻页、也不被翻页打断缩放。
 *
 * 【缩放为什么锚在中心】按指心锚定要额外按焦点重算位移；本轮判据是「有上下限、
 * 有回弹、放大后能拖动查看」，因此统一按中心缩放，位移边界按放大后的实际溢出量算，
 * 放大到边缘不会露出空白。
 *
 * 【切换照片为什么能复位】调用方（查看器）给它挂了 `key={photo.id}`：换片即重挂，
 * Animated 值与手势基线全部重新来过，不必再写一套复位逻辑。
 */
import { useCallback, useMemo, useRef } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { Image } from 'expo-image';
import { photoAspect, placeholderColors } from '@shaping-memory/core';
import type { Photo } from '@shaping-memory/core';

import { springs } from '../layout/motion';

/** 缩放上下限：1 = 适配态（照片整幅可见），再放大到 4 倍以上手机上只剩像素块 */
const MIN_SCALE = 1;
const MAX_SCALE = 4;
/** 双击的放大档：看清细节与「不丢参照」的折中，与捏合上限无关 */
const DOUBLE_TAP_SCALE = 2.5;
/** 双击判定窗口：两次 grant 的间隔小于它算一次双击（略宽于系统的 doubleTapTimeout） */
const DOUBLE_TAP_MS = 280;
/** 越界阻尼：拖出边界后只再走这个比例，松手弹回 —— 硬性夹取的表现如同撞墙 */
const RUBBER = 0.35;
/** 「处于放大态」的容差：适配态附近的手势一律让给翻页 */
const ZOOM_EPS = 1.01;

/** 只要横纵坐标的触摸点 */
interface Point {
  pageX: number;
  pageY: number;
}

/** 越界阻尼：超出 limit 后只再走 RUBBER 的比例 */
function rubber(value: number, limit: number): number {
  const over = Math.abs(value) - limit;
  return over <= 0 ? value : Math.sign(value) * (limit + over * RUBBER);
}

/** 硬夹：收手落点与容器尺寸变化时用（这两个时刻不能再留越界量） */
function clamp(value: number, limit: number): number {
  return Math.min(Math.max(value, -limit), limit);
}

/** 缩放也要有阻尼：捏到 1 以下或 4 以上只再走一点，松手弹回 */
function rubberScale(raw: number): number {
  if (raw < MIN_SCALE) return MIN_SCALE - (MIN_SCALE - raw) * RUBBER;
  if (raw > MAX_SCALE) return MAX_SCALE + (raw - MAX_SCALE) * RUBBER;
  return raw;
}

/** 两指间距：gestureState 不带多指间距，只能从 touches 里取 */
function touchDistance(touches: readonly Point[]): number {
  const [a, b] = touches;
  return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
}

/** 适配态下照片在容器里的实际尺寸：contain 口径，与画出来的那张一致 */
function fitSizeOf(box: { w: number; h: number }, aspectRatio: number): { w: number; h: number } {
  if (box.w <= 0 || box.h <= 0 || aspectRatio <= 0) return { w: 0, h: 0 };
  const height = box.w / aspectRatio;
  return height <= box.h ? { w: box.w, h: height } : { w: box.h * aspectRatio, h: box.h };
}

export function ZoomableImage({ photo, original = false }: { photo: Photo; original?: boolean }) {
  const [base] = placeholderColors(photo);
  const [ratioW, ratioH] = photoAspect(photo);

  /* 画哪一份字节：默认详情档缩略图；点过「查看原图」后换成原片
     （originalPreviewUrl —— 带库里最新 EXIF 的那份，与 Web 的「加载原片」同一出口）。
     缓存策略：公开可见的原片走 memory-disk，第二次点开直接从本地取（需求里的「本地缓存」）；
     获准后拿到的隐私原片在服务端是 no-store，只留在内存里，出了这次会话就没了。 */
  const visible = photo.privacy?.mode === 'visible';
  const src = original ? photo.originalPreviewUrl ?? photo.originalUrl ?? photo.url : photo.url;
  const cachePolicy = original && !visible ? ('memory' as const) : ('memory-disk' as const);

  /* 画出来的那一份（交给原生驱动） */
  const scale = useRef(new Animated.Value(MIN_SCALE)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  /* 真值与手势基线（见文件头） */
  const cur = useRef({ scale: MIN_SCALE, tx: 0, ty: 0 });
  const box = useRef({ w: 0, h: 0 });
  /** 捏合基线：第二根手指落下那一刻的间距与缩放 */
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  /** 单指平移的上一个落点：用增量位移而非 gestureState.dx ——
      捏合抬起一根手指后 dx 的零点会跳，增量法没有这个跳变 */
  const lastPoint = useRef<Point | null>(null);
  const lastTapAt = useRef(0);

  /** 某缩放下允许的最大平移量 = 放大后溢出容器的一半（因此拖到边也不会露空白） */
  const maxPanAt = useCallback(
    (s: number) => {
      const fit = fitSizeOf(box.current, ratioW / ratioH);
      return {
        x: Math.max(0, (fit.w * s - box.current.w) / 2),
        y: Math.max(0, (fit.h * s - box.current.h) / 2),
      };
    },
    [ratioH, ratioW],
  );

  /** 手势期间每帧：把真值刷进 Animated */
  const paint = useCallback(() => {
    scale.setValue(cur.current.scale);
    tx.setValue(cur.current.tx);
    ty.setValue(cur.current.ty);
  }, [scale, tx, ty]);

  /** 收手：真值先落到合法位，再让三个叶子节点用同一档弹簧跟过去（回弹就来自这里） */
  const settle = useCallback(
    (next: { scale: number; tx: number; ty: number }) => {
      cur.current = next;
      Animated.parallel([
        Animated.spring(scale, { ...springs.smooth, toValue: next.scale }),
        Animated.spring(tx, { ...springs.smooth, toValue: next.tx }),
        Animated.spring(ty, { ...springs.smooth, toValue: next.ty }),
      ]).start();
    },
    [scale, tx, ty],
  );

  /** 把当前状态夹回合法区间再回弹：松手 / 被夺权 / 容器尺寸变化都走它 */
  const settleBack = useCallback(() => {
    pinch.current = null;
    lastPoint.current = null;
    const s = Math.min(Math.max(cur.current.scale, MIN_SCALE), MAX_SCALE);
    const max = maxPanAt(s);
    settle({ scale: s, tx: clamp(cur.current.tx, max.x), ty: clamp(cur.current.ty, max.y) });
  }, [maxPanAt, settle]);

  /** 双击：放大态回适配态、适配态进放大档（只有这两档，不做连续多档） */
  const toggleZoom = useCallback(() => {
    const next = cur.current.scale > ZOOM_EPS ? MIN_SCALE : DOUBLE_TAP_SCALE;
    const max = maxPanAt(next);
    settle({ scale: next, tx: clamp(cur.current.tx, max.x), ty: clamp(cur.current.ty, max.y) });
  }, [maxPanAt, settle]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        // 触摸开始就接管：双击要两次 grant 的时间戳，捏合要从第一根手指起计数
        onStartShouldSetPanResponder: () => true,
        // 没放大就让位（查看器的横滑翻页照旧接管）；放大或两指在手时拒绝夺权
        onPanResponderTerminationRequest: () => (pinch.current ? false : cur.current.scale <= ZOOM_EPS),
        onPanResponderGrant: (event) => {
          pinch.current = null;
          lastPoint.current = null;
          const now = Date.now();
          /* 单指连点两次、间隔够短 = 双击；多指落下不算（那是捏合的开头） */
          if (event.nativeEvent.touches.length <= 1 && now - lastTapAt.current < DOUBLE_TAP_MS) {
            lastTapAt.current = 0;
            toggleZoom();
            return;
          }
          lastTapAt.current = now;
        },
        onPanResponderMove: (event, gesture) => {
          const touches = event.nativeEvent.touches;
          /* 两指：捏合。第一帧只记基线，从第二帧起按「间距比」推缩放 */
          if (gesture.numberActiveTouches >= 2) {
            const distance = touchDistance(touches);
            if (distance <= 0) return;
            if (!pinch.current) {
              pinch.current = { distance, scale: cur.current.scale };
              lastPoint.current = null;
              return;
            }
            cur.current = {
              ...cur.current,
              scale: rubberScale((pinch.current.scale * distance) / pinch.current.distance),
            };
            paint();
            return;
          }
          pinch.current = null;
          /* 单指：适配态不平移 —— 横滑要留给查看器翻页 */
          if (cur.current.scale <= ZOOM_EPS) return;
          const point = touches[0];
          if (!point) return;
          const prev = lastPoint.current;
          lastPoint.current = { pageX: point.pageX, pageY: point.pageY };
          if (!prev) return;
          const max = maxPanAt(cur.current.scale);
          cur.current = {
            ...cur.current,
            tx: rubber(cur.current.tx + (point.pageX - prev.pageX), max.x),
            ty: rubber(cur.current.ty + (point.pageY - prev.pageY), max.y),
          };
          paint();
        },
        onPanResponderRelease: () => settleBack(),
        // 被查看器夺权（未放大时的横滑）也要收尾；两指在手时不会走到这里（拒绝夺权）
        onPanResponderTerminate: () => settleBack(),
      }),
    [maxPanAt, paint, settleBack, toggleZoom],
  );

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      box.current = { w: width, h: height };
      /* 容器尺寸变了（转屏 / 元数据抽屉挤压）就按新边界硬夹一次，照片不停在非法位置 */
      const max = maxPanAt(cur.current.scale);
      cur.current = { ...cur.current, tx: clamp(cur.current.tx, max.x), ty: clamp(cur.current.ty, max.y) };
      paint();
    },
    [maxPanAt, paint],
  );

  return (
    <View style={styles.root} onLayout={handleLayout} {...responder.panHandlers}>
      {/* 位移写在缩放之前：位移量因此按容器像素算，边界不必再乘一次 scale */}
      <Animated.View style={[styles.layer, { transform: [{ translateX: tx }, { translateY: ty }, { scale }] }]}>
        {/* 底片色：原片到位前不留纯黑，也顺带定下这张图的色温基调 */}
        <View style={[StyleSheet.absoluteFill, styles.base, { backgroundColor: base }]} />
        <Image
          source={{ uri: src }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={320}
          cachePolicy={cachePolicy}
          accessibilityLabel={photo.title}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  /* 吃满舞台：照片本体由 contentFit="contain" 决定显示多大，容器只负责边界 */
  root: { flex: 1, alignSelf: 'stretch' },
  /** 视口即图层：位移与缩放都作用在它上面，边界换算因此只有一套基准 */
  layer: { ...StyleSheet.absoluteFillObject, overflow: 'hidden' },
  base: { opacity: 0.25 },
});