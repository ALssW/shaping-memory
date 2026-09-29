/**
 * apps/mobile/src/hooks/useWallRail.ts
 *
 * 移动端墙面底部「时间线横轨」的逻辑：刻度与读数由 core 算（与 Web 同一份纯计算），
 * 这里只接移动端独有的四件事 —— 滚动 → 进度、拖拽 → 相对增量、点刻度 → 跳转，
 * 以及「墙面按批渲染」与「横轨要摊开整份档案」之间那点换算。
 *
 * 【模型：游标不动、尺子动】滑动点钉在停靠条正中，时间线整条按 translateX 平移。
 * 因此「已走过的进度填充」不存在，进度只用来（1）平移时间线、（2）反查读数。
 * 平移公式与 Web 的 .progress-rail__stage 逐字对应：
 *   translateX = 视野半宽 − 端让位 − 进度 × (舞台宽 − 2 × 端让位)
 *
 * 【拖拽为什么必须是相对增量】横向若用绝对映射（按哪读哪），指针坐标就会锚定在
 * 一个随进度平移的坐标系上 → 产生自反馈：越拖偏移越大、半侧范围被限制。相对增量取「手指移动的像素
 * ÷ 轨道宽」，指针走满一轨正好是进度 0 → 1。
 *
 * 【点刻度为什么用 mark.progress 而不是 mark.ratio】ratio 是整形后的**落点**
 * （单调 + 相邻不叠字），它只回答「画在哪」；真实滚动位置是 progress。
 * 拿 ratio 当跳转目标，点「4月」会跳到别的月份去。
 *
 * 【刻度锚点：已渲染的段量实测，未渲染的段按每张平均像素外推】
 * Web 量每张 [data-photo] 节点的真实几何 —— 它一次把整份档案渲染进 DOM，
 * 刻度因此天然覆盖全档案。移动端的墙面按批渲染（见 GalleryScreen 的 WALL_BATCH），
 * 静止初态只渲染了前缀：若刻度只取已渲染的段，横轨就只剩一枚，而它的语义恰恰是
 * 「直观看到整份档案的时间分布」。于是每个时间单位都有锚点，不会缺失任何一枚：
 *   · 已上报的段：onLayout 给的实测纵坐标 ÷ 外推总高（与 Web 的 measureAnchors 同口径）；
 *   · 未上报的段：有序列表下标 × 每张平均像素 ÷ 外推总高（两条公式在边界处重合，
 *     因此「段内的段」与「段外的段」落在同一把尺子上）。
 * 交给 core 的 buildMeasuredMarks 之后，落点与疏密全是像素比例，与 Web 完全同源；
 * 全部渲染完后外推自然退化为实测，不需要另外收口。
 *
 * 【外推密度为什么必须由墙面上报张数，不能拿「段张数」反推】批次是按时间序取的前缀，
 * 而 core 的 buildTimeGroups 给的是一整段时间段的**全部**张数：静止初态只渲染 60 张时，
 * 末段（8 月）只渲染了它 69 张里的 20 张，按段张数反推会把已渲染边界算成 109，
 * 密度因此偏小约一半，除月份起点之外的刻度全被推出可视窗（实测横轨只剩「9月」）。
 * 故由 ScrollView 的 onContentSizeChange 如实上报「已渲染张数」。
 *
 * 【尺子为什么取「外推后的总高」而不是「当前内容高」】进度必须与整份档案同尺度：
 * 拿当前内容高当分母，滚到已加载部分的底部就得到进度 1，读数会在 9 月 / 8 月之间
 * 就报成 3 月。跳转目标 = 进度 × 这把尺子；目标还没渲染出来时先滚到当前内容底部
 * （触发补批），每加载一批重发一次（见 settleJump），直到落点进入已渲染范围。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Animated, PanResponder, useWindowDimensions } from 'react-native';
import type { GestureResponderHandlers, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';
import {
  buildIndexMarks,
  buildMeasuredMarks,
  clamp01,
  densifyMarks,
  labelAtProgress,
  markKeyOf,
  sameLabel,
} from '@shaping-memory/core';
import type { Photo, RailAnchor, RailLabel, RailMark, TimeScale } from '@shaping-memory/core';

import { space } from '../theme';

/** 可视窗高：三层文字/轨各 space.s16 + 两道 space.s6 间隙（与 Web 的 --rail-dock-h 推导同源） */
export const RAIL_VIEWPORT_H = space.s16 * 3 + space.s6 * 2;

/** 停靠条净高：读数行 space.s16 + 间隙 space.s6 + 可视窗 + 上下内边距各 space.s8 = 98 */
export const RAIL_DOCK_H = space.s8 + space.s16 + space.s6 + RAIL_VIEWPORT_H + space.s8;

/** 停靠条最大宽（与 Web 的 min(1040px, 100vw − 48px) 同档） */
const DOCK_MAX_W = 1040;
/** 「点了一下」与「真的在拖」的分界（px）：与 Web 的 DRAG_SLOP 同档 */
const DRAG_SLOP = 4;

/** 横轨的几何：全部由视口宽与落点整形算出的舞台宽派生，不在组件里各量一遍 */
export interface RailGeometry {
  /** 停靠条宽（= 可视窗宽 + 两侧内边距） */
  dockW: number;
  /** 可视窗宽：视野半宽的那把尺子 */
  viewportW: number;
  /** 舞台宽：max(可视窗宽, 落点整形所需的跨度) */
  stageW: number;
  /** 时间线可移距离 = 舞台宽 − 两端让位（拖拽的分母） */
  travel: number;
  /** 进度 0 时的 translateX＝视野半宽 − 端让位 */
  baseOffset: number;
}

export interface WallRail {
  marks: readonly RailMark[];
  label: RailLabel | null;
  activeKey: string | null;
  progress: Animated.Value;
  geometry: RailGeometry;
  /** 挂到墙面 ScrollView 上：跳转要反写它的滚动位置 */
  scrollRef: RefObject<ScrollView>;
  /** 挂到墙面 ScrollView 的 onScroll 上 */
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** 挂到墙面 ScrollView 的 onContentSizeChange 上（内容高 px、已渲染张数） */
  onContentSizeChange: (height: number, count: number) => void;
  /** 挂到墙面 ScrollView 的 onLayout 上（视口高，px） */
  onLayout: (height: number) => void;
  /** 挂到墙面 ScrollView 的 onScrollBeginDrag 上：用户自己动手时放弃未完成的程序化跳转 */
  onDragStart: () => void;
  /** 挂到每个时间段容器的 onLayout 上：上报该段内容纵坐标（刻度锚点） */
  onGroupLayout: (key: string, y: number, index: number) => void;
  /** 墙面重新挂载时调用（列表 ↔ 墙面切换）：新 ScrollView 从顶开始，读数必须跟着归零 */
  onWallMounted: () => void;
  /**
   * 直接跳到某个进度（0–1）：拖拽与点刻度共用同一条路径。
   * key 只有点刻度时才给（拖拽没有「目标刻度」）—— 补批后重锚要按它找回同一枚刻度。
   */
  jumpTo: (ratio: number, key?: string) => void;
  /** 拖拽命中区（整条停靠条都可拖） */
  panHandlers: GestureResponderHandlers;
}

/** 一个时间单位（月 / 日）：键 + 它的首张照片在有序列表里的下标 */
interface TimeUnit {
  /** 与图墙分段的 TimeGroup.key 同源，用来认领那一份实测纵坐标 */
  key: string;
  index: number;
}

/**
 * 有序列表 → 每个时间单位的首张下标。
 * 【为什么是「首张下标 × 每张平均像素」而不是「段高」】下标在有序列表上线性递增，
 * 乘上密度就是内容高的线性插值 —— 未渲染区间没有别的可用几何，而墙面按列堆叠时
 * 相邻两段的纵向间距本就与张数成正比。无 EXIF 日期的照片不产生刻度（core 的约定）。
 */
function scanUnits(ordered: readonly Photo[], scale: TimeScale): TimeUnit[] {
  const units: TimeUnit[] = [];
  let previous: string | null = null;
  for (let index = 0; index < ordered.length; index += 1) {
    const key = markKeyOf(ordered[index]!, scale);
    if (!key || key === previous) continue;
    previous = key;
    units.push({ key, index });
  }
  return units;
}

/**
 * 整份档案的刻度锚点，外加「进度 ↔ 滚动像素」的那把尺子（外推总高 − 视口高）。
 * 已上报的段用实测纵坐标；未上报的段按每张平均像素外推。
 * 一次上报都没有时返回空锚点，由调用方退回下标比例（首帧用）。
 *
 * @param rendered 墙面已渲染的张数（由 onContentSizeChange 上报，见文件头）
 */
function archiveLayout(
  units: readonly TimeUnit[],
  renderedTops: Map<string, { y: number; index: number }>,
  contentH: number,
  viewportH: number,
  total: number,
  rendered: number,
): { anchors: RailAnchor[]; range: number } {
  /* 尚未量出任何几何时的保底尺子：先按当前内容高滚动，几何量出后被下面的外推总高取代 */
  const range = Math.max(1, contentH - viewportH);
  if (rendered <= 0 || contentH <= 0) return { anchors: [], range };

  /* 每张平均像素 = 内容高 ÷ 已渲染张数。内容高含底部「让开横轨」的留白，
     摊进每张会让密度略高一点点 —— 它只决定未渲染段的落点，渲染出来后会被实测取代。 */
  const density = contentH / rendered;
  const fullRange = Math.max(1, contentH + Math.max(0, total - rendered) * density - viewportH);

  /* 比例的分母统一是外推总高：已渲染的实测纵坐标也按它换算，
     否则实测段与推算段会落在两把不同的尺子上，接缝处必然错位。 */
  const anchors: RailAnchor[] = units.map((unit) => {
    const report = renderedTops.get(unit.key);
    return { index: unit.index, top: clamp01((report ? report.y : unit.index * density) / fullRange) };
  });
  return { anchors, range: fullRange };
}

/**
 * @param ordered 已按当前排序排好的照片（刻度与分段口径的唯一来源，必须是有序副本）
 * @param scale 刻度粒度：月 / 日 —— 与图墙分隔标签、列表分组同源
 * @param active 是否真的在渲染这条轨（列表视图 / 空档案时为 false，此时不做任何计算）
 */
export function useWallRail(ordered: readonly Photo[], scale: TimeScale, active: boolean): WallRail {
  const { width } = useWindowDimensions();

  /* ---------------------------------------------------------------- *
   * 墙面实测：每个时间段容器上报自己的内容纵坐标（等价于 Web 量 DOM）
   * ---------------------------------------------------------------- */
  /** key → 该段在滚动内容里的纵坐标（px） */
  const groupTopsRef = useRef(new Map<string, { y: number; index: number }>());
  /** 上报批次：一次布局可能连报十几个段，攒到下一帧只为一次重算 */
  const [revision, setRevision] = useState(0);
  const frameRef = useRef(false);

  /* 内容高 / 视口高 / 已渲染张数：既是实测锚点的换算范围，也是未渲染区外推密度的依据。
     必须先于 archive 声明 —— useMemo 的工厂在渲染当帧就执行，晚声明会撞上暂时性死区。 */
  const contentHRef = useRef(0);
  const viewportHRef = useRef(0);
  /** 已渲染张数：外推密度的分母，必须由墙面上报（见文件头，不能按段张数反推） */
  const renderedCountRef = useRef(0);

  /** 一次布局上报攒到下一帧再重算：同一帧里连报十几个段也只算一遍刻度 */
  const bumpRevision = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = true;
    requestAnimationFrame(() => {
      frameRef.current = false;
      setRevision((count) => count + 1);
    });
  }, []);

  /** 每个时间单位的起点与张数：未渲染区的刻度锚点靠它外推 */
  const units = useMemo(() => scanUnits(ordered, scale), [ordered, scale]);

  /* 刻度表 + 尺子一起算：刻度位置与进度换算必须来自同一次测算，否则接缝处会错位。
     revision 是「上报过 / 几何变了」的信号；ref 里的值是读取点，故意不进依赖。 */
  const archive = useMemo(() => {
    const measured = archiveLayout(
      units,
      groupTopsRef.current,
      contentHRef.current,
      viewportHRef.current,
      ordered.length,
      renderedCountRef.current,
    );
    if (!active) return { marks: [] as RailMark[], range: measured.range };
    /* 一帧都还没上报时退回下标比例：否则首帧轨上一条刻度都没有 */
    if (measured.anchors.length === 0) return { marks: buildIndexMarks(ordered, scale), range: measured.range };
    return { marks: buildMeasuredMarks(ordered, measured.anchors, scale), range: measured.range };
  }, [active, ordered, scale, units, revision]);

  /** 进度 ↔ 滚动像素的那把尺子。跳转要从最新一次测算里取，因此走 ref 而不是闭包 */
  const rangeRef = useRef(archive.range);
  /** 刻度表的读取副本：settleJump 是稳定回调，但重锚要拿「最新一次」的刻度 */
  const marksRef = useRef<readonly RailMark[]>([]);

  /* 用 useRef<ScrollView>(null)：React 18 的这个重载给出 RefObject<ScrollView>，
     正好对上 RN 的 ref 类型；写成 useRef<ScrollView | null>(null) 会因只读属性的
     协变检查挂掉（ScrollView | null 不能赋给 ScrollView）。 */
  const scrollRef = useRef<ScrollView>(null);

  /**
   * 正在进行的跳转（拖拽起手或用户自己滚页面时放弃）。0 是合法进度，因此用 null 表示「没有待办」。
   * key 只在「点刻度」时带上：补批会让刻度的 progress 重算（未渲染区间本是外推值，
   * 实测一到就会偏移），只有记住是哪一枚刻度，重锚才能落回点的那一枚。
   */
  const pendingRef = useRef<{ progress: number; key?: string } | null>(null);

  /**
   * 把进度写回滚动位置：拖拽、点刻度、补批重发共用这一条路径。
   * 目标超出当前可滚范围时先滚到当前底部（同时触发补批），并记下待办 ——
   * 之后每加载一批就重发一次，直到落点进入已渲染范围，这就是「重锚」。
   */
  const seekTo = useCallback((next: number, key?: string) => {
    const target = next * rangeRef.current;
    const maxScroll = Math.max(0, contentHRef.current - viewportHRef.current);
    scrollRef.current?.scrollTo({ y: Math.min(target, maxScroll), animated: false });
    pendingRef.current = target > maxScroll + 1 ? { progress: next, key } : null;
  }, []);

  /** 内容变长后重发待办跳转：连着几批加载完，落点会一步步落进已渲染范围 */
  const settleJump = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    /* 按 key 找回那一枚刻度、用它的**新** progress 重发：实测值一旦取代外推值，
       同一个数值可能已经落在隔壁月份上（实测点「5月」会跳到「4月」的正是这一处）。 */
    const pinned = pending.key ? marksRef.current.find((mark) => mark.key === pending.key) : undefined;
    seekTo(pinned ? pinned.progress : pending.progress, pending.key);
  }, [seekTo]);

  /* 停靠条的宽度几何：只由视口宽决定（与落点整形无关），因此先算、供两处共用。
     trackPx 是轨的**实际可用宽**（= 可视窗 − 两端让位），它是落点整形的「单位 1」：
     411dp 竖屏只剩 283px，若仍按 md 档的 960 整形，月尺度的整段档案会被摊到
     窗口的四倍宽、一屏只看得到 1/4 —— 传真实可用宽后，摆得下的档案整段收进视窗。 */
  const dock = useMemo(() => {
    const dockW = Math.min(DOCK_MAX_W, Math.max(1, width - space.s24 * 2));
    const viewportW = Math.max(1, dockW - space.s16 * 2);
    return { dockW, viewportW, trackPx: Math.max(1, viewportW - space.s24 * 2) };
  }, [width]);

  /* 刻度 → 落点整形：横向必须整形（一屏宽装不下日尺度的全部刻度数字）。
     spanPx 是舞台所需跨度，只加长不缩短，摆得下时落点即真实比例。 */
  const laid = useMemo(
    () => (active ? densifyMarks(archive.marks, dock.trackPx) : { marks: [] as RailMark[], spanPx: 0 }),
    [active, archive.marks, dock.trackPx],
  );
  const marks = laid.marks;
  marksRef.current = marks;

  /* 尺子换了（换刻度、加载了新的一批）就同步给跳转，并把尚未落地的跳转重发一次。
     重锚要读最新刻度（见 settleJump），因此依赖里也带上 marks —— 它在刻度算完之后才声明，
     这条 effect 必须排在 marks 之下，否则依赖数组会在渲染当帧撞上暂时性死区。 */
  useEffect(() => {
    rangeRef.current = archive.range;
    settleJump();
  }, [archive.range, marks, settleJump]);

  const geometry = useMemo<RailGeometry>(() => {
    const { dockW, viewportW } = dock;
    const stageW = Math.max(viewportW, laid.spanPx || viewportW);
    const travel = Math.max(1, stageW - space.s24 * 2);
    return { dockW, viewportW, stageW, travel, baseOffset: viewportW / 2 - space.s24 };
  }, [dock, laid.spanPx]);

  /** 拖拽分母要从最新一次渲染里取，因此走 ref 而不是闭包 */
  const travelRef = useRef(geometry.travel);
  travelRef.current = geometry.travel;

  const progress = useRef(new Animated.Value(0)).current;
  /** 进度的同步副本：拖拽起手要立刻拿到当前值，等 state 会慢一两帧 */
  const progressRef = useRef(0);
  const [label, setLabel] = useState<RailLabel | null>(null);

  /** 写进度：Animated 值（驱动平移）+ 读数（跨刻度时才换对象，滚动时几乎不重渲染） */
  const applyProgress = useCallback(
    (next: number) => {
      progressRef.current = next;
      progress.setValue(next);
      const found = labelAtProgress(marks, ordered, next, scale);
      setLabel((prev) => (sameLabel(prev, found) ? prev : found));
    },
    [marks, ordered, progress, scale],
  );

  /* 刻度表一变（换刻度 / 加载了新的一批 / 数据刷新）就按当前进度补一次读数。
     不这么做的话，首帧没有任何滚动事件 → 读数行是空的，要等用户滚一下才有字。 */
  useEffect(() => {
    applyProgress(progressRef.current);
  }, [applyProgress]);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      /* 分母是外推总高那把尺子（见文件头），不是当前内容高：
         否则「已加载部分的底部」会被读成档案末尾。 */
      applyProgress(clamp01(event.nativeEvent.contentOffset.y / rangeRef.current));
    },
    [applyProgress],
  );

  /** 内容高 / 已渲染张数 / 视口高上报：外推密度与尺子都靠它们，几何一变就重算刻度 */
  const onContentSizeChange = useCallback(
    (height: number, count: number) => {
      /* 张数变了也要重算：批量渲染下内容高可能一两像素都没变（新一批替换了旧的占位），
         而密度分母已经变了，只比高度就会漏掉这次重算。 */
      const settled = Math.abs(contentHRef.current - height) < 0.5 && renderedCountRef.current === count;
      contentHRef.current = height;
      renderedCountRef.current = count;
      if (!settled) bumpRevision();
    },
    [bumpRevision],
  );
  const onLayout = useCallback(
    (height: number) => {
      if (Math.abs(viewportHRef.current - height) < 0.5) return;
      viewportHRef.current = height;
      bumpRevision();
    },
    [bumpRevision],
  );

  /* 段纵坐标上报：值没变就不重算（onLayout 会因为任何布局变化重放，段多时这张表会被反复填） */
  const onGroupLayout = useCallback(
    (key: string, y: number, index: number) => {
      const previous = groupTopsRef.current.get(key);
      if (previous && Math.abs(previous.y - y) < 0.5) return;
      groupTopsRef.current.set(key, { y, index });
      bumpRevision();
    },
    [bumpRevision],
  );

  /** 把进度写回滚动位置：拖拽与点刻度共用这一条路径 */
  const jumpTo = useCallback(
    (ratio: number, key?: string) => {
      const next = clamp01(ratio);
      // 先写自己这一份，时间线立刻跟手；随后 ScrollView 的滚动事件再校准一次
      applyProgress(next);
      seekTo(next, key);
    },
    [applyProgress, seekTo],
  );

  /** 拖拽起点：按下时的进度与「本次按下是否已越过 DRAG_SLOP」 */
  const dragRef = useRef({ base: 0, moved: false });

  /* 墙面换了一次 ScrollView（列表切回墙面）→ 滚动位置归零，读数与待办跳转都要清掉。
     移动端没有 Web 那种「全站共用同一个滚动容器」，两个视图各有自己的容器，
     不归零就会看到「画面在顶部、读数却停在旧月份」。 */
  const onWallMounted = useCallback(() => {
    pendingRef.current = null;
    applyProgress(0);
  }, [applyProgress]);

  /** 用户自己开始拖页面 → 放弃程序化跳转，免得跟手指抢位置 */
  const onDragStart = useCallback(() => {
    pendingRef.current = null;
  }, []);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        /* 按下不抢手势：刻度标签要能收到自己的点击（与 Web「按下落在标签上时不捕获指针」同一条理由） */
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dx) > DRAG_SLOP,
        onPanResponderGrant: () => {
          dragRef.current = { base: progressRef.current, moved: false };
        },
        onPanResponderMove: (_event, gesture) => {
          /* 相对增量：手往右（+dx）= 时间线右移 = 露出较早的一段 = 进度减小 */
          dragRef.current.moved = true;
          jumpTo(dragRef.current.base - gesture.dx / travelRef.current);
        },
        onPanResponderRelease: () => {
          dragRef.current.moved = false;
        },
        onPanResponderTerminate: () => {
          dragRef.current.moved = false;
        },
      }),
    [jumpTo],
  );

  /* 高亮取读数那一份（单一事实源）：读数与高亮不可能各说各话 */
  const activeKey = label && marks.some((mark) => mark.key === label.key) ? label.key : null;

  return {
    marks,
    label,
    activeKey,
    progress,
    geometry,
    scrollRef,
    onScroll,
    onContentSizeChange,
    onLayout,
    onDragStart,
    onGroupLayout,
    onWallMounted,
    jumpTo,
    panHandlers: panResponder.panHandlers,
  };
}
