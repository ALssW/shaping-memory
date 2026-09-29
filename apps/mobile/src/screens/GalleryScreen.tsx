/**
 * apps/mobile/src/screens/GalleryScreen.tsx
 *
 * 画廊：分类 chip + 工具栏（墙面 / 列表 + 时间排序 + 月 / 日刻度）+ 两种视图 + 底部时间线横轨。
 *
 * 【与 Web 的差异（都是移动端的必然选择）】
 *   1) 墙面没有 FlatList 虚拟化，改成按批渲染（WALL_BATCH / WALL_PREFETCH_PX）——
 *      列式瀑布流要求「列内连续堆叠」，而 FlatList 的 numColumns 是按行切块的等高网格；
 *   2) 列表视图没有左侧进度轨 —— 手机上拖拽会与页面滚动冲突，
 *      Web 端在窄屏分支里也是同样处理；
 *   3) 卡面平时只有照片本体与选择态角标，配文平时不挂；**长按**才浮出信息层
 *      （标题 / 器材 / 地点 + 时间 / 曝光），对应 Web 的鼠标悬停蒙版 ——
 *      触屏没有 hover，长按是它在这一端的对等手势。完整元数据仍收在放大查看页
 *      （竖屏是底部半透明抽屉）。
 *
 * 【列数从哪来】一律取自 useBreakpoint（断点口径在 packages/core/layout，
 * 与 Web 的 WallView 同一个函数），两档以上（含竖屏 2 列）走同一条 ColumnWall。
 *
 * 【为什么先分段、再在段内分列】分隔线是「这里换了一段」的答案，必须是**一根横贯整行的线**，
 * 而不是每列各拉一条短线。若先分列、再在每列里各自判断跨刻度点，各列的边界位置天生不同步
 * （第 i 张进第 i % N 列），横贯线必然在几列之间硬切一刀 —— 所以在结构上就必须先分段：
 * 一段 = 一条整行分隔线 + 一个 N 列子网格。分段口径与列表分组共用 core 的 buildTimeGroups，
 * 键取 scaleKeyOf、文案取 scaleLabelOf，两视图不可能对同一条边界给出不同答案。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { ActivityIndicator, Animated, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Image } from 'expo-image';
import { albumApi, searchApi } from '@shaping-memory/sdk';
import type { PhotoQuery } from '@shaping-memory/sdk';
import {
  buildTimeGroups,
  CATEGORIES,
  filterByCategory,
  formatDate,
  photoAspect,
  placeholderColors,
  resolutionOf,
  sortByDate,
  splitIntoColumns,
  TimeScale,
} from '@shaping-memory/core';
import type { GalleryView, GroupItem, Photo, SortOrder, TimeGroup } from '@shaping-memory/core';

import { Chip, ChipRow, Icon, IconButton, PillBar } from '../components/primitives';
import type { PillOption } from '../components/primitives';
import { hasSearchConditions, searchInMemory } from '../lib/photo-search';
import { BatchEditDialog } from '../components/BatchEditDialog';
import { TimelineRail } from '../components/TimelineRail';
import { useBreakpoint } from '../layout/useBreakpoint';
import { duration, easing, PRESS_LIFT, PRESS_LIFT_Y, springs } from '../layout/motion';
import { RAIL_DOCK_H, useWallRail } from '../hooks/useWallRail';
import { Viewer } from './Viewer';
import {
  accentOpacity,
  accentRgba,
  backgroundRgba,
  colors,
  disabledOpacity,
  fontFamily,
  radius,
  size,
  space,
  tabularNums,
  text,
} from '../theme';

const VIEW_OPTIONS: readonly PillOption<GalleryView>[] = [
  { value: 'wall', label: '墙面', icon: 'grid' },
  { value: 'list', label: '列表', icon: 'list' },
];

const SORT_OPTIONS: readonly PillOption<SortOrder>[] = [
  { value: 'desc', label: '倒序（最新在前）', icon: 'arrowDown' },
  { value: 'asc', label: '正序（最旧在前）', icon: 'arrowUp' },
];

/** 刻度粒度：月看整份档案的分布，日做逐日精读 —— 只换刻度密度，不换数据 */
const SCALE_OPTIONS: readonly PillOption<TimeScale>[] = [
  { value: 'month', label: '月' },
  { value: 'day', label: '日' },
];

/** 列表里被打开的照片：下标与列表一起存，翻页方向才与列表一致 */
interface ViewerTarget {
  list: readonly Photo[];
  index: number;
}

/* -------------------------------------------------------------------------- */
/* 分段标签：图墙与列表共用同一条视觉                                            */
/* -------------------------------------------------------------------------- */

/**
 * 渐变发丝线的透明度剖面：从 `--color-border-base` 的原强度逐段收到 0，右端彻底消失。
 * 【为什么是一排等宽小段】RN 没有 linear-gradient，而「颜色向透明过渡」这件事
 * 可以分解成「同一颜色的若干等宽小段、透明度递减」—— 观感与 Web 的
 * `linear-gradient(to right, var(--color-border-base), transparent)` 一致，
 * 且不写死任何颜色值，换主题色时线跟着走。
 */
const HAIRLINE_STOPS = [1, 0.78, 0.58, 0.42, 0.28, 0.16, 0.07, 0] as const;

/**
 * 一张整行的分段标签：上方一条渐变发丝线横贯整行切段，标题（年月 / 年月日）取主色调、左对齐。
 * 图墙的 `.masonry__time-sep` 与列表的 `.list__group-head` 在 Web 上就是同款样式 ——
 * 两处回答的是同一个问题（「这里换了一段」），视觉不一致就会被读成两种东西。
 * 【不遮挡照片】线是整行占位（段与段之间），照片只落在它下面的子网格里。
 */
const GroupHead = memo(function GroupHead({ label, count, fine }: { label: string; count: number; fine: boolean }) {
  return (
    <View style={[styles.groupHead, fine && styles.groupHeadFine]}>
      <View style={styles.hairline} pointerEvents="none">
        {HAIRLINE_STOPS.map((alpha, index) => (
          <View key={index} style={[styles.hairlineSegment, { opacity: alpha }]} />
        ))}
      </View>
      {/* 标题与张数同行、基线对齐：张数压小一号、走三级文字色，读作标题的注解
          （与 Web 的 .masonry__time-sep-count / .list__group-count 同款同序）。 */}
      <View style={styles.groupHeadRow}>
        <Text style={styles.groupHeadLabel}>{label}</Text>
        <Text style={styles.groupHeadCount}>{count} 张</Text>
      </View>
    </View>
  );
});

/* -------------------------------------------------------------------------- */
/* 长按浮层：卡面的信息分层                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 长按照片时浮出的信息层，与 Web 的 `PhotoMask`（鼠标悬停蒙版）同口径：
 *   1) 标题          —— 唯一的实体名，字号最大
 *   2) 器材行        —— 相机型号在左、格式胶囊在右（机身 → 容器）
 *   3) 地点 + 时间   —— 地点在**时间左侧**（先答「在哪儿拍的」再答「什么时候拍的」），
 *                       没有定位的照片整项不渲染；分辨率随后（数值类）
 *   4) 曝光参数      —— 单独一行，读的是数值，靠等宽字与其余行区分
 *
 * 【为什么卡面平时不显示它】手机竖屏一屏就有好几列，卡面常年挂着这几行会把照片压没；
 * 长按是一个明确、有意的动作，此时再看信息最合适（对应 Web 的悬停）。
 * 【为什么不用渐变蒙版】RN 没有 linear-gradient（项目未引 expo-linear-gradient），
 * 因此只在下缘铺一块厚材质色板 —— 它是 token 里为「压在照片上的可读性底色」备的那一档，
 * 与 Web 那条渐变的下半段同色，照片上缘因此仍完整可见。
 */
const TilePeek = memo(function TilePeek({ photo }: { photo: Photo }) {
  // 空项先滤再拼，避免出现「··ISO」这种空段（与 Web PhotoMask 同一处口径）
  const exposure = [photo.focal, photo.aperture, photo.speed, photo.iso != null ? `ISO ${photo.iso}` : '']
    .filter(Boolean)
    .join(' · ');
  const resolution = resolutionOf(photo);

  return (
    <View style={styles.peek}>
      <Text style={styles.peekTitle} numberOfLines={1}>
        {photo.title}
      </Text>

      {photo.cam || photo.format ? (
        <View style={styles.peekGear}>
          <Text style={styles.peekCam} numberOfLines={1}>
            {photo.cam}
          </Text>
          {photo.format ? <Text style={styles.peekFormat}>{photo.format}</Text> : null}
        </View>
      ) : null}

      {photo.place || photo.date || resolution ? (
        <View style={styles.peekRow}>
          {photo.place ? (
            <View style={styles.peekPlace}>
              <Icon name="pin" size={size.icon.compact} color={colors.accent} />
              <Text style={styles.peekPlaceText} numberOfLines={1}>
                {photo.place}
              </Text>
            </View>
          ) : null}
          {photo.date ? <Text style={styles.peekDate}>{formatDate(photo.date)}</Text> : null}
          {resolution ? <Text style={styles.peekResolution}>{resolution}</Text> : null}
        </View>
      ) : null}

      {exposure ? (
        <Text style={styles.peekExposure} numberOfLines={1}>
          {exposure}
        </Text>
      ) : null}
    </View>
  );
});

/* -------------------------------------------------------------------------- */
/* 墙面：卡片（照片本体 + 选择态角标 + 长按浮层）                                 */
/* -------------------------------------------------------------------------- */

/**
 * 浮层的淡入值：从 0 起步、展开后收到 1。两处卡面（墙面 tile / 列表 thumb）共用，
 * 免得同一段缓动被抄两遍。关闭时不淡出 —— 收起应当是「立刻」的，
 * 而长按本身已是一个明确的意图，出现这一步只需要一点过渡把硬切磨掉。
 */
function usePeekFade(peeking: boolean): Animated.Value {
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!peeking) return;
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: duration.fast, easing: easing.smooth, useNativeDriver: true }).start();
  }, [fade, peeking]);
  return fade;
}

interface TileProps {
  photo: Photo;
  onPress: (photo: Photo) => void;
  /** 选择模式（admin 批量编辑）：为 true 时点卡片切换选中、不打开查看器 */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (photo: Photo) => void;
  /** 本张的长按浮层是否已展开（同一时刻最多一张） */
  peeking?: boolean;
  /** 长按上报：由上层持有「哪一张在浮层里」，因此点别处 / 滚动时都能统一收掉 */
  onPeek?: (photo: Photo) => void;
  /** 点浮层下那张照片 = 先收浮层（不直接进查看器），再点才打开 */
  onDismissPeek?: () => void;
}

const PhotoTile = memo(function PhotoTile({
  photo,
  onPress,
  selecting = false,
  selected = false,
  onToggleSelect,
  peeking = false,
  onPeek,
  onDismissPeek,
}: TileProps) {
  // 占位底色在这里算：它是稳定函数，memo 命中后就不会再执行
  const [base] = placeholderColors(photo);
  const [ratioW, ratioH] = photoAspect(photo);

  /* 按下抬起：0 = 静止、1 = 抬起。用一条进度值同时驱动缩放与位移，
     两段插值只建一次（依赖恒定的 lift），不会每次渲染都新建动画节点。 */
  const lift = useRef(new Animated.Value(0)).current;
  const liftStyle = useMemo(
    () => ({
      transform: [
        { scale: lift.interpolate({ inputRange: [0, 1], outputRange: [1, PRESS_LIFT] }) },
        { translateY: lift.interpolate({ inputRange: [0, 1], outputRange: [0, PRESS_LIFT_Y] }) },
      ],
    }),
    [lift],
  );
  /** 抬起 / 落回都走 smooth 弹簧：与 Web 悬停抬起采用同一档动效 */
  const setLift = (to: number) => {
    Animated.spring(lift, { ...springs.smooth, toValue: to }).start();
  };

  /* 浮层淡入：值从 0 起步、挂载后收到 1。关闭时不淡出 —— 收起应当是「立刻」的 */
  const peekFade = usePeekFade(peeking);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={selecting ? (selected ? `取消选中《${photo.title}》` : `选中《${photo.title}》`) : `查看《${photo.title}》`}
      accessibilityState={selecting ? { selected } : undefined}
      onPressIn={() => setLift(1)}
      onPressOut={() => setLift(0)}
      /* 长按只看信息，不选中、也不进查看器；选择模式下禁用 —— 那里长按属于拖选的手势域 */
      onLongPress={selecting ? undefined : () => onPeek?.(photo)}
      onPress={() => {
        if (peeking) return onDismissPeek?.();
        return selecting && onToggleSelect ? onToggleSelect(photo) : onPress(photo);
      }}
      style={styles.tile}
    >
      {/* 抬起作用在整张卡片上（与 Web 的悬停抬起采用同一档动效），卡面本身只有照片 */}
      <Animated.View style={liftStyle}>
        <View style={[styles.tileFrame, { aspectRatio: ratioW / ratioH, backgroundColor: base }]}>
          <Image
            source={{ uri: photo.cardUrl ?? photo.url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={500}
            cachePolicy="memory-disk"
          />
          {/* 选择模式下的勾选角标 */}
          {selecting ? (
            <View style={styles.checkBadge}>
              {selected ? <Icon name="check" size={14} color={colors.accent} /> : null}
            </View>
          ) : null}
          {selecting ? <View style={styles.checkOverlay} /> : null}

          {/* 长按浮层：pointerEvents="none" 让手势仍落在 Pressable 上 ——
              点浮层里的照片就是「收掉它」，不必再找一个关闭按钮 */}
          {peeking ? (
            <Animated.View style={[styles.peekOverlay, { opacity: peekFade }]} pointerEvents="none">
              <TilePeek photo={photo} />
            </Animated.View>
          ) : null}
        </View>
      </Animated.View>
    </Pressable>
  );
});

/* -------------------------------------------------------------------------- */
/* 墙面：列式瀑布流（与 Web 同构，所有档位共用）                                  */
/* -------------------------------------------------------------------------- */

interface WallProps {
  /** 已按刻度切好的时间段（每段 = 一整行标签 + 段内若干列） */
  groups: readonly TimeGroup[];
  onPress: (photo: Photo) => void;
  selecting?: boolean;
  selected?: ReadonlySet<string>;
  onToggleSelect?: (photo: Photo) => void;
}

/**
 * 长按浮层：状态由 GalleryScreen 持有（同一时刻至多一张、滚动与切视图时统一收掉），
 * 两个视图都只负责把这三项原样转发到每一张卡片上 —— 卡片自己不管「谁该开着」。
 */
interface PeekProps {
  /** 已展开浮层的那张 id */
  peekId: string | null;
  onPeek: (photo: Photo) => void;
  onDismissPeek: () => void;
}

/** 每批渲染张数：列式瀑布流无法虚拟化，靠分批把常驻节点数压在首屏量级。
 *  横轨的刻度不因此缺斤少两 —— 「未渲染的段」由 useWallRail 按每张平均像素外推 */
const WALL_BATCH = 60;
/** 距底部不足这么多像素时放下一批 —— 提前加载一批，滚动不会出现空白 */
const WALL_PREFETCH_PX = 600;

/** 按「分段一件一件拿」的方式截取前 limit 张：空的段直接丢掉，不留一条孤零零的标签 */
function takeItems(groups: readonly TimeGroup[], limit: number): TimeGroup[] {
  const kept: TimeGroup[] = [];
  let left = limit;
  for (const group of groups) {
    if (left <= 0) break;
    const items = group.items.slice(0, left);
    if (items.length > 0) kept.push({ ...group, items });
    left -= items.length;
  }
  return kept;
}

/**
 * 列式瀑布流（全部档位共用，含竖屏 2 列）：先按刻度分段，每段 = 一整行分隔标签
 * + 一个 N 列子网格，与 Web 的 `.masonry__group` 同构。
 *
 * 【为什么不用 FlatList 的 numColumns】列数变化时它需要改变 key 强制重挂载，
 * 而列数恰恰是随窗口宽度实时变的（转屏、分屏）—— 每次旋转都把整墙拆了重建。
 *
 * 【为什么不用「按行切块」的网格】那会让每行等高：一行里最高的那张决定行高，
 * 其余列留白，读起来是「一排一排」，与 Web 的列式瀑布流（各列各自连续）不同构。
 * 分列规则与 Web 完全相同 —— core 的 splitIntoColumns（第 i 张进第 i % N 列）。
 *
 * 【竖屏为什么也用它】需求裁定「手机端与 Web 同构」：2 列也必须是列式瀑布流
 * （各列底部自然不齐、阅读顺序列优先）。代价是失去 FlatList 虚拟化，
 * 由 WALL_BATCH / WALL_PREFETCH_PX 的分批渲染保底。
 */
const ColumnWall = memo(function ColumnWall({
  groups,
  columns,
  fine,
  railInset,
  scrollRef,
  onScroll,
  onContentSizeChange,
  onLayout,
  onDragStart,
  onGroupLayout,
  onWallMounted,
  onPress,
  selecting,
  selected,
  onToggleSelect,
  peekId,
  onPeek,
  onDismissPeek,
  onNeedMore,
  footer,
}: WallProps & PeekProps & {
  columns: number;
  /** 本地渲染窗口已到手上这批数据的尽头时通知父级取下一页；没有下一页时不给 */
  onNeedMore?: () => void;
  /** 列表尾注（追加中的转圈 / 失败重试）：跟着内容一起滚，不悬浮 */
  footer?: ReactNode;
  /** 日尺度：段数翻好几倍，段间距同步收紧（与 Web 的 .masonry--fine 同档） */
  fine: boolean;
  /** 底部是否要让开横轨（最后一行照片不该被停靠条压住） */
  railInset: boolean;
  scrollRef: RefObject<ScrollView>;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** 内容高 / 视口高上报：横轨要把进度换算成滚动像素，必须先知道可滚范围。
   *  张数一并上报 —— 横轨外推「未渲染区间」的密度按它算，不能按段张数反推 */
  onContentSizeChange: (height: number, count: number) => void;
  onLayout: (height: number) => void;
  /** 用户自己开始拖页面：横轨要放弃未完成的程序化跳转，不跟手指抢位置 */
  onDragStart: () => void;
  /** 每个时间段容器上报自己的内容纵坐标：横轨的刻度锚点（等价于 Web 量 DOM 真实几何） */
  onGroupLayout: (key: string, y: number, index: number) => void;
  /** 本组件挂载时通知横轨：新 ScrollView 从顶开始，读数要归零（列表切回墙面会重挂） */
  onWallMounted: () => void;
}) {
  /* 只在挂载时执行一次：语义就是「新的壁面从顶部开始」。若不复位，
     从列表切回墙面会看到画面在顶部、横轨读数却停在旧月份。 */
  useEffect(() => {
    onWallMounted();
  }, []);
  /* 分批窗口：只增不减。photos 变短时 slice 自动截断，无需复位 ——
     复位反而会在切分类的瞬间把已加载的图全部卸载。 */
  const [limit, setLimit] = useState(WALL_BATCH);
  const shown = useMemo(() => takeItems(groups, limit), [groups, limit]);
  /* 已渲染张数：横轨外推「尚未渲染的那些段」的密度靠它。
     必须如实数 shown 的张数，不能拿段的完整张数相加 —— 末段会被 takeItems 截断 */
  const shownCount = useMemo(() => shown.reduce((sum, group) => sum + group.items.length, 0), [shown]);

  /* 分段头的张数必须按**完整** groups 取：shown 的末段被 takeItems 截断了，
     若直接从 shown 读，那一段的读数会随着分批推进一路往上跳（「3 张」→「60 张」）。 */
  const countByKey = useMemo(() => new Map(groups.map((group) => [group.key, group.items.length])), [groups]);

  /* 滚动的最近一次几何：分批判定要靠它，而**程序化滚动（跳转补批）不会再产生 onScroll**，
     因此「内容变长」那条路径也要能自己判一次，否则待办跳转会卡在已加载的底部不动。 */
  const geoRef = useRef({ offset: 0, viewport: 0, content: 0 });
  const totalItems = useMemo(() => groups.reduce((sum, group) => sum + group.items.length, 0), [groups]);
  /* limit 的同步副本：分批判定要「现在渲染到第几张」，而 setState 是异步的，读不到最新的 */
  const limitRef = useRef(limit);
  limitRef.current = limit;

  /** 距底部不足 WALL_PREFETCH_PX 就放下一批 —— 用户滚动与程序化补批两条路径共用它 */
  const extendIfNeeded = useCallback(() => {
    const { offset, viewport, content } = geoRef.current;
    if (offset + viewport < content - WALL_PREFETCH_PX) return;
    // 本地还有没铺出来的段：先把渲染窗口往前放
    if (limitRef.current < totalItems) {
      setLimit((prev) => (prev >= totalItems ? prev : prev + WALL_BATCH));
      return;
    }
    /* 已经铺到手上这批数据的尽头：找服务端要下一页。
       父级的 loadMore 自带串行闸门与「到底就不再取」的判定，重复触达无副作用 */
    onNeedMore?.();
  }, [totalItems, onNeedMore]);

  /** 同一次滚动要供三处用：横轨算进度、记录几何、分批放下一批 */
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      geoRef.current = { offset: contentOffset.y, viewport: layoutMeasurement.height, content: contentSize.height };
      onScroll(event);
      extendIfNeeded();
    },
    [extendIfNeeded, onScroll],
  );

  /** 内容变长：报给横轨（它靠它外推整份档案的尺子），并再判一次是否需要补批 */
  const handleContentSize = useCallback(
    (height: number) => {
      geoRef.current.content = height;
      onContentSizeChange(height, shownCount);
      extendIfNeeded();
    },
    [extendIfNeeded, onContentSizeChange, shownCount],
  );

  /* 新一页数据到位后，把渲染窗口也往前放一批。
     【为什么必须补这一步】窗口卡在旧 limit 上时 shown 不长，内容高度就不变，
     onContentSizeChange 不会再来，滚动也到不了新的底部 —— 窗口会永远停在原地。
     只在「用户本来就在底部附近」时放：初次加载（geo.content 还是 0）与远未到底时都不动，
     免得一次数据变化就多做一次无效渲染。 */
  useEffect(() => {
    const { offset, viewport, content } = geoRef.current;
    if (content <= 0 || offset + viewport < content - WALL_PREFETCH_PX) return;
    setLimit((prev) => (prev >= totalItems ? prev : Math.min(prev + WALL_BATCH, totalItems)));
  }, [totalItems]);

  const handleLayout = useCallback(
    (height: number) => {
      geoRef.current.viewport = height;
      onLayout(height);
    },
    [onLayout],
  );

  return (
    <ScrollView
      ref={scrollRef}
      contentContainerStyle={[
        styles.listContent,
        fine ? styles.groupGapFine : styles.groupGap,
        railInset && styles.wallRailInset,
      ]}
      showsVerticalScrollIndicator={false}
      onScroll={handleScroll}
      scrollEventThrottle={16}
      onScrollBeginDrag={onDragStart}
      onContentSizeChange={(_width, height) => handleContentSize(height)}
      onLayout={(event) => handleLayout(event.nativeEvent.layout.height)}
    >
      {shown.map((group) => (
        /* 上报本段的纵坐标：段起点就是刻度位置，交给横轨换算成滚动比例。
           内容容器没有 paddingTop，因此 layout.y 就是内容坐标（与 scrollTo 同源）。 */
        <View
          key={group.key}
          style={styles.wallGroup}
          onLayout={(event) => onGroupLayout(group.key, event.nativeEvent.layout.y, group.items[0]!.index)}
        >
          <GroupHead label={group.label} count={countByKey.get(group.key) ?? group.items.length} fine={fine} />
          <View style={styles.wallColumns}>
            {splitIntoColumns<GroupItem>(group.items, columns).map((column, index) => (
              <View key={index} style={styles.wallColumn}>
                {column.map((item) => (
                  <PhotoTile
                    key={item.photo.id}
                    photo={item.photo}
                    onPress={onPress}
                    selecting={selecting}
                    selected={selected?.has(item.photo.id) ?? false}
                    onToggleSelect={onToggleSelect}
                    peeking={peekId === item.photo.id}
                    onPeek={onPeek}
                    onDismissPeek={onDismissPeek}
                  />
                ))}
              </View>
            ))}
          </View>
        </View>
      ))}
      {/* 尾注直接排在最后一段之下：跟着内容一起滚，不悬浮遮挡照片 */}
      {footer}
    </ScrollView>
  );
});

/* -------------------------------------------------------------------------- */
/* 列表：按当前刻度分组 → 缩略图网格                                             */
/* -------------------------------------------------------------------------- */

const Thumb = memo(function Thumb({
  photo,
  onPress,
  selecting = false,
  selected = false,
  onToggleSelect,
  peeking = false,
  onPeek,
  onDismissPeek,
}: TileProps) {
  const [base] = placeholderColors(photo);
  const [ratioW, ratioH] = photoAspect(photo);
  const peekFade = usePeekFade(peeking);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={selecting ? (selected ? `取消选中《${photo.title}》` : `选中《${photo.title}》`) : `查看《${photo.title}》`}
      accessibilityState={selecting ? { selected } : undefined}
      /* 长按浮层与墙面 tile 同一形态、同一行为（选择模式下让位给拖选） */
      onLongPress={selecting ? undefined : () => onPeek?.(photo)}
      onPress={() => {
        if (peeking) return onDismissPeek?.();
        return selecting && onToggleSelect ? onToggleSelect(photo) : onPress(photo);
      }}
      style={styles.thumb}
    >
      {/* 格子宽度由 flex 等分决定；高度交给内层 aspectRatio —— 与墙面 tile 同构 */}
      <View style={[styles.thumbFrame, { aspectRatio: ratioW / ratioH, backgroundColor: base }]}>
        <Image
          source={{ uri: photo.cardUrl ?? photo.url }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={400}
          /* 列表行缩略图是公开资源，落盘缓存：滚回上一屏时不再重新下载 */
          cachePolicy="memory-disk"
        />
        {selecting ? (
          <View style={styles.checkBadge}>
            {selected ? <Icon name="check" size={14} color={colors.accent} /> : null}
          </View>
        ) : null}
        {selecting ? <View style={styles.checkOverlay} /> : null}
        {peeking ? (
          <Animated.View style={[styles.peekOverlay, { opacity: peekFade }]} pointerEvents="none">
            <TilePeek photo={photo} />
          </Animated.View>
        ) : null}
      </View>
    </Pressable>
  );
});

/**
 * 把照片按固定列数切成行。
 * 【为什么不用 flexWrap + 百分比 flexBasis】实测该组合在此 RN 版本上会把百分比按整屏宽
 * 解析，导致换行错位（每行只放 2 个）且格子落到可视区外、既不可见也不可点。
 * 显式分行 + 行内 flex 等分没有这个歧义。
 */
function chunkRows<T>(items: readonly T[], columns: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += columns) {
    rows.push(items.slice(i, i + columns));
  }
  return rows;
}

interface GroupListProps extends PeekProps {
  groups: readonly TimeGroup[];
  /** 缩略图每行几格：来自 useBreakpoint().listColumns */
  columns: number;
  fine: boolean;
  onPress: (photo: Photo) => void;
  selecting?: boolean;
  selected?: ReadonlySet<string>;
  onToggleSelect?: (photo: Photo) => void;
  /** 用户开始拖页面：浮层跟着收掉（滚动表示用户已不再关注该卡片） */
  onDragStart: () => void;
  /** 滑到底自动取下一页；没有下一页时不给 */
  onEndReached?: () => void;
  /** 列表尾注（追加中的转圈 / 失败重试）；FlatList 只吃元素，不吃任意节点 */
  footer?: ReactElement | null;
}

/**
 * 列表视图：按当前刻度分组（月尺度 = 每月一段、日尺度 = 每日一段），组内是缩略图网格。
 * 分组头就是图墙那条分段标签的同款视觉 —— 切「月 / 日」时两视图同时换口径。
 */
function GroupedList({
  groups,
  columns,
  fine,
  onPress,
  selecting,
  selected,
  onToggleSelect,
  peekId,
  onPeek,
  onDismissPeek,
  onDragStart,
  onEndReached,
  footer,
}: GroupListProps) {
  return (
    <FlatList
      data={groups}
      keyExtractor={(group) => group.key}
      contentContainerStyle={[styles.listContent, fine ? styles.groupGapFine : styles.groupGap]}
      showsVerticalScrollIndicator={false}
      onScrollBeginDrag={onDragStart}
      /* 无感分页：阈值 0.6 屏提前触发；列表本身已虚拟化，再补上「只渲染首屏 +
         滑出窗口的回收」，长列表滚动才不抖。 */
      onEndReached={onEndReached}
      onEndReachedThreshold={0.6}
      initialNumToRender={6}
      maxToRenderPerBatch={6}
      windowSize={7}
      removeClippedSubviews
      ListFooterComponent={footer}
      renderItem={({ item }) => (
        <View style={styles.wallGroup}>
          {/* 未知时间的残档也走同一条标签：core 的文案已是「未知时间」，不另造一套。
              张数直接取本组长度 —— FlatList 的数据是完整的，不存在墙面那种末段截断。 */}
          <GroupHead label={item.label} count={item.items.length} fine={fine} />
          <View style={styles.thumbGrid}>
            {chunkRows<GroupItem>(item.items, columns).map((row) => (
              <View key={row[0]!.photo.id} style={styles.thumbRow}>
                {row.map((cell) => (
                  <Thumb
                    key={cell.photo.id}
                    photo={cell.photo}
                    onPress={onPress}
                    selecting={selecting}
                    selected={selected?.has(cell.photo.id) ?? false}
                    onToggleSelect={onToggleSelect}
                    peeking={peekId === cell.photo.id}
                    onPeek={onPeek}
                    onDismissPeek={onDismissPeek}
                  />
                ))}
                {/* 末行不满时补占位格，免得最后几张被 flex 拉宽 */}
                {Array.from({ length: columns - row.length }, (_, index) => (
                  <View key={`pad-${index}`} style={styles.thumbPad} />
                ))}
              </View>
            ))}
          </View>
        </View>
      )}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* 切刻度时的过渡                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 切「月 / 日」时给内容一次淡入：分段会整体重切，硬切会有一下刺眼的跳变。
 * 非空间状态走 timing + smooth 曲线（与 Web 那边「重排位移」是同一处语义的两端表达）。
 */
function useScaleFade(scale: TimeScale) {
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    fade.setValue(0.4);
    Animated.timing(fade, { toValue: 1, duration: duration.base, easing: easing.smooth, useNativeDriver: true }).start();
  }, [fade, scale]);
  return { opacity: fade };
}

/* -------------------------------------------------------------------------- */

interface GalleryScreenProps {
  photos: readonly Photo[];
  loading: boolean;
  /** 服务端还有下一页（懒加载分页）；相册/检索态恒为 false —— 那两条路都是一次取回 */
  hasMore: boolean;
  /** 正在追加下一页 */
  loadingMore: boolean;
  /** 取数错误：列表为空时整块呈现，已有照片时由列表底部呈现并给重试入口 */
  error: string | null;
  /** 触发下一页：滑到列表底部时自动调用，失败后也由「重试」按钮调用 */
  onLoadMore: () => void;
  view: GalleryView;
  sort: SortOrder;
  /** 时间刻度粒度：月（整份档案的分布）/ 日（逐日精读） */
  scale: TimeScale;
  onViewChange: (view: GalleryView) => void;
  onSortChange: (sort: SortOrder) => void;
  onScaleChange: (scale: TimeScale) => void;
  category: string;
  onCategoryChange: (category: string) => void;
  /** 有值表示处于相册模式：数据源换成该相册的照片，顶部多一枚「退出相册」 */
  albumId?: string;
  onExitAlbum: () => void;
  /** EXIF 搜索条件：有值即改走服务端检索 */
  search: PhotoQuery;
  /** 是否具备前台编辑能力（admin 登录为 true）：显示编辑入口 */
  admin: boolean;
  /** 编辑保存成功后的回调：触发顶层重拉照片列表 */
  onPhotosChanged: () => void;
  liked: ReadonlySet<string>;
  onToggleLike: (id: string) => void;
}

export function GalleryScreen({
  photos,
  loading,
  hasMore,
  loadingMore,
  error,
  onLoadMore,
  view,
  sort,
  scale,
  onViewChange,
  onSortChange,
  onScaleChange,
  category,
  onCategoryChange,
  albumId,
  onExitAlbum,
  search,
  admin,
  onPhotosChanged,
  liked,
  onToggleLike,
}: GalleryScreenProps) {
  /* 列数随窗口宽度走：转屏 / 分屏 / 折叠屏都会让它们变化并触发重排 */
  const { wallColumns, listColumns } = useBreakpoint();

  /* 相册模式：数据源换成 albumApi.detail(id).photos（顺序由后台 sortOrder 决定）。
     其余筛选（分类 / 排序 / 视图）行为不变。 */
  const [album, setAlbum] = useState<{ title: string; photos: readonly Photo[] } | null>(null);
  const [albumLoading, setAlbumLoading] = useState(false);
  useEffect(() => {
    if (!albumId) {
      setAlbum(null);
      return;
    }
    let cancelled = false;
    setAlbumLoading(true);
    albumApi
      .detail(albumId)
      .then((detail) => {
        if (cancelled) return;
        setAlbum({ title: detail.album.title, photos: detail.photos });
        setAlbumLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setAlbum(null);
        setAlbumLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [albumId]);

  // 数据源：进了相册就用册内照片，否则用整份档案
  const source = albumId ? album?.photos : photos;

  /**
   * 服务端检索态：有搜索条件且不在相册模式时启用。
   * 【为什么不在相册里也走服务端】/search/photos 不认识「相册」这个维度，
   * 册内检索只能沿用客户端过滤 —— 相册照片本就是整份档案的子集。
   */
  const searching = hasSearchConditions(search);
  const [remote, setRemote] = useState<{ photos: readonly Photo[]; loading: boolean }>({ photos: [], loading: false });

  /* 搜索条件一变就重新检索：分类与排序一并交给服务端，返回结果即最终集合。
     隐私票据由 searchApi 内部附带（withPrivacy），这里不会、也不该绕过解锁。
     无搜索条件时不发请求，沿用整份档案的既有行为。 */
  useEffect(() => {
    if (!searching || albumId) {
      setRemote({ photos: [], loading: false });
      return;
    }
    let cancelled = false;
    setRemote((prev) => ({ photos: prev.photos, loading: true }));
    searchApi
      .photos({ category, sort, ...search })
      .then((result) => {
        if (!cancelled) setRemote({ photos: result, loading: false });
      })
      .catch(() => {
        // 检索失败即呈现空集，与「没有符合条件的照片」同一表现（前端不额外造错误态）
        if (!cancelled) setRemote({ photos: [], loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [searching, albumId, search, category, sort]);

  const filtered = useMemo(() => {
    // 服务端检索态：结果已在服务端按分类与条件筛好，直接采用，不再二次过滤
    if (searching && !albumId) return remote.photos;
    // 相册模式 / 常规态：沿用客户端过滤，语义与旧版一致
    return searchInMemory(filterByCategory(source ?? [], category), search);
  }, [searching, albumId, remote.photos, source, category, search]);

  const busy = albumId ? albumLoading || !album : searching ? remote.loading : loading;

  /* 日期有序副本：墙面分段、列表分组、轨上的刻度都必须落在同一个有序列表上 ——
     比较口径来自 core（与查看器翻页共用同一份，见 sortByDate）。 */
  const ordered = useMemo(() => sortByDate(filtered, sort), [filtered, sort]);

  /* 分段 / 分组一次算完：键与文案都取自 core，两视图不可能对同一条边界给出不同答案 */
  const groups = useMemo(() => buildTimeGroups(ordered, scale), [ordered, scale]);

  /* 分页只在「整份档案」这条路成立：相册与检索态拿到的都是一次取回的完整结果，没有下一页 */
  const canLoadMore = !albumId && !searching && hasMore;

  /* 列表底部的状态条：追加中转圈 / 失败时给出状态提示 + 重试。
     出错时**不**自动续取 —— 否则「失败 → 触底 → 再失败」会转成死循环，改为等用户点重试。
     什么状态都没有时不渲染，免得列表底部凭空多出一段空白。 */
  const pagerVisible = !albumId && !searching && (loadingMore || !!error);
  const listFooter = pagerVisible ? (
    <View style={styles.loadMore}>
      {loadingMore ? (
        <ActivityIndicator color={colors.text.tertiary} />
      ) : (
        <>
          <Text style={styles.loadMoreError}>{error}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="重试加载更多"
            onPress={onLoadMore}
            style={({ pressed }) => [styles.editAction, pressed && styles.pressed]}
          >
            <Text style={styles.editActionText}>重试</Text>
          </Pressable>
        </>
      )}
    </View>
  ) : null;

  const [target, setTarget] = useState<ViewerTarget | null>(null);

  /* 前台编辑（仅 admin）：编辑模式下点照片切换选中，浮动条提供批量编辑入口 */
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);

  /* 长按浮层：同一时刻只留一张 —— 换一张长按即移过去。
     点那张照片、开始滚页面、换视图 / 刻度 / 分类 / 进编辑模式都会把它收掉，
     否则它会悬在一张「已经不在这一屏」的照片上。 */
  const [peekId, setPeekId] = useState<string | null>(null);
  const openPeek = useCallback((photo: Photo) => setPeekId(photo.id), []);
  const closePeek = useCallback(() => setPeekId(null), []);
  useEffect(() => {
    setPeekId(null);
  }, [view, scale, category, sort, albumId, editing]);

  const toggleSelectId = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const toggleSelectPhoto = useCallback((photo: Photo) => toggleSelectId(photo.id), [toggleSelectId]);
  /* 全选口径 = 当前筛选 / 排序后真正展示的那些照片（ordered），不是整份档案 ——
     否则「已选 N / 共 M」的 M 与界面上的张数会对不上。 */
  const allSelected = ordered.length > 0 && selected.size >= ordered.length;
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => (prev.size >= ordered.length && ordered.length > 0 ? new Set() : new Set(ordered.map((item) => item.id))));
  }, [ordered]);
  const exitEditing = useCallback(() => {
    setEditing(false);
    setSelected(new Set());
  }, []);
  const beginEditing = useCallback(() => {
    setEditing(true);
    setSelected(new Set());
  }, []);

  /* 底部时间线横轨：墙面视图、有照片就渲染 —— 竖屏同样要有（需求裁定），
     不再按档位分叉。刻度落点与舞台跨度按**实际可用轨宽**整形（见 useWallRail），
     411dp 竖屏的月尺度因此能整段收进停靠条，不存在「窄屏装不下」的问题。 */
  const railActive = view === 'wall' && ordered.length > 0;
  const rail = useWallRail(ordered, scale, railActive);

  /* 用户开始拖页面：横轨放弃未完成的程序化跳转（原有语义），同时把长按浮层收掉 ——
     人在滚动就说明已经看别的去了，浮层不该继续挂在身后。两个视图共用这一条。 */
  const { onDragStart } = rail;
  const handleDragStart = useCallback(() => {
    onDragStart();
    setPeekId(null);
  }, [onDragStart]);

  const openFrom = useCallback((list: readonly Photo[], photo: Photo) => {
    const index = list.findIndex((item) => item.id === photo.id);
    setTarget({ list, index: index < 0 ? 0 : index });
  }, []);

  const openFromWall = useCallback((photo: Photo) => openFrom(ordered, photo), [openFrom, ordered]);
  const openFromList = useCallback((photo: Photo) => openFrom(ordered, photo), [openFrom, ordered]);

  /** 循环翻页：只接方向，下标在函数式更新里算，回调引用因此恒稳 */
  const stepViewer = useCallback((delta: number) => {
    setTarget((prev) => {
      if (!prev || prev.list.length === 0) return prev;
      const count = prev.list.length;
      return { list: prev.list, index: (prev.index + delta + count) % count };
    });
  }, []);

  const closeViewer = useCallback(() => setTarget(null), []);

  /** 切「月 / 日」时给两个视图一次淡入，避免分段整体重切的那一下硬跳 */
  const fadeStyle = useScaleFade(scale);
  const fine = scale === 'day';

  return (
    <View style={styles.screen}>
      <View style={styles.filterBar}>
        <ChipRow>
          {albumId ? (
            <Chip label={`退出相册 · ${album?.title ?? ''}`} active onPress={onExitAlbum} />
          ) : null}
          {CATEGORIES.map((item) => (
            <Chip key={item} label={item} active={item === category} onPress={() => onCategoryChange(item)} />
          ))}
        </ChipRow>
        {/* 工具栏一行：墙面 / 列表 + 时间排序 + 月 / 日刻度。
            排序与刻度对两个视图都生效，因此不再只出现在列表的筛选行里（同一功能不开两处入口）。 */}
        <View style={styles.segRow}>
          <PillBar options={VIEW_OPTIONS} value={view} onChange={onViewChange} label="浏览方式" iconOnly />
          <PillBar options={SORT_OPTIONS} value={sort} onChange={onSortChange} label="时间排序" iconOnly />
          <PillBar options={SCALE_OPTIONS} value={scale} onChange={onScaleChange} label="时间刻度单位" />
          {/* 前台编辑入口（仅 admin） */}
          {admin ? (
            <IconButton
              name="edit"
              label={editing ? '退出选择' : '批量编辑'}
              active={editing}
              onPress={editing ? exitEditing : beginEditing}
            />
          ) : null}
        </View>

        {/* 选择模式下浮动的批量操作条 */}
        {editing ? (
          <View style={styles.editBar}>
            <Text style={styles.editBarCount}>
              已选 {selected.size} / 共 {ordered.length}
            </Text>
            <View style={styles.editBarActions}>
              {/* 全选 / 取消全选：一次选中全部可批量处理的照片，减少重复点击 */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={allSelected ? '取消全选' : '全选'}
                onPress={toggleSelectAll}
                disabled={ordered.length === 0}
                style={({ pressed }) => [styles.editAction, ordered.length === 0 && styles.editActionDisabled, pressed && styles.pressed]}
              >
                <Text style={styles.editActionText}>{allSelected ? '取消全选' : '全选'}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="退出选择"
                onPress={exitEditing}
                style={({ pressed }) => [styles.editAction, pressed && styles.pressed]}
              >
                <Text style={styles.editActionText}>退出</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="批量编辑"
                onPress={() => setBatchOpen(true)}
                disabled={selected.size === 0}
                style={({ pressed }) => [styles.editAction, styles.editActionPrimary, selected.size === 0 && styles.editActionDisabled, pressed && styles.pressed]}
              >
                <Text style={styles.editActionPrimaryText}>批量编辑</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>

      <Animated.View style={[styles.body, fadeStyle]}>
        {busy ? (
          <Text style={styles.empty}>加载中…</Text>
        ) : filtered.length === 0 ? (
          /* 首屏取数失败：给出状态提示 + 重试入口，避免被误判为「暂无照片」。
             相册与检索态的错误各自在它们的请求里消化，不套用这里的口径。 */
          !albumId && !searching && error ? (
            <View style={styles.loadMore}>
              <Text style={styles.loadMoreError}>{error}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="重试"
                onPress={() => onPhotosChanged()}
                style={({ pressed }) => [styles.editAction, pressed && styles.pressed]}
              >
                <Text style={styles.editActionText}>重试</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.empty}>
              {albumId ? '这本相册暂无照片' : searching ? '无符合条件的照片' : '该分类暂无照片'}
            </Text>
          )
        ) : view === 'wall' ? (
          /* 全部档位共用列式瀑布流：竖屏 2 列、横屏 3~4 列、平板 4~5 列都是
             「列内连续堆叠、各列底部自然不齐」，与 Web 的 .masonry 同构。
             列数仍来自 useBreakpoint（与 Web 共用 core 的 wallColumnCount）。 */
          <ColumnWall
            groups={groups}
            columns={wallColumns}
            fine={fine}
            railInset={railActive}
            /* 本地渲染窗口已铺到手上这批数据的尽头时，向服务端要下一页。
               没有下一页（相册 / 检索 / 已到底）就传 undefined，墙面便只管本地分批 */
            onNeedMore={canLoadMore ? onLoadMore : undefined}
            footer={listFooter}
            scrollRef={rail.scrollRef}
            onScroll={rail.onScroll}
            onContentSizeChange={rail.onContentSizeChange}
            onLayout={rail.onLayout}
            onDragStart={handleDragStart}
            onGroupLayout={rail.onGroupLayout}
            onWallMounted={rail.onWallMounted}
            onPress={openFromWall}
            selecting={editing}
            selected={selected}
            onToggleSelect={toggleSelectPhoto}
            peekId={peekId}
            onPeek={openPeek}
            onDismissPeek={closePeek}
          />
        ) : (
          <GroupedList
            groups={groups}
            columns={listColumns}
            fine={fine}
            /* 滑到底自动取下一页：阈值 0.6 屏，等真到底再取就已经看到空白了 */
            onEndReached={canLoadMore ? onLoadMore : undefined}
            footer={listFooter}
            onPress={openFromList}
            selecting={editing}
            selected={selected}
            onToggleSelect={toggleSelectPhoto}
            peekId={peekId}
            onPeek={openPeek}
            onDismissPeek={closePeek}
            onDragStart={handleDragStart}
          />
        )}
      </Animated.View>

      {/* 底部时间线横轨：墙面视图、有照片时才渲染 */}
      {railActive ? (
        <TimelineRail
          label={rail.label}
          marks={rail.marks}
          activeKey={rail.activeKey}
          progress={rail.progress}
          geometry={rail.geometry}
          jumpTo={rail.jumpTo}
          panHandlers={rail.panHandlers}
        />
      ) : null}

      {target ? (
        <Viewer
          list={target.list}
          index={target.index}
          onStep={stepViewer}
          onClose={closeViewer}
          admin={admin}
          onPhotosChanged={onPhotosChanged}
          liked={liked}
          onToggleLike={onToggleLike}
        />
      ) : null}

      {/* 批量编辑对话框（仅 admin、选择模式内可触发）。
          传 photos 而非 ids：批量结果区要拿它逐张提供「保存到相册」 */}
      {batchOpen ? (
        <BatchEditDialog
          photos={ordered.filter((item) => selected.has(item.id))}
          onClose={() => setBatchOpen(false)}
          onDone={() => {
            setBatchOpen(false);
            exitEditing();
            onPhotosChanged();
          }}
        />
      ) : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1 },
  listContent: { paddingHorizontal: space.s16, paddingBottom: space.s40 },
  /* 分段之间的呼吸：与 Web 的 .masonry gap（space-24 / 日尺度 space-16）同档 */
  groupGap: { gap: space.s24 },
  groupGapFine: { gap: space.s16 },
  /* 横轨浮在页面正下方：最后一段照片要让开「停靠条 + space-64」，否则会被压住 */
  wallRailInset: { paddingBottom: RAIL_DOCK_H + space.s64 },

  filterBar: {
    paddingHorizontal: space.s16,
    paddingBottom: space.s8,
    gap: space.s8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.base,
  },
  segRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.s8 },

  empty: { ...text.body, color: colors.text.tertiary, textAlign: 'center', marginTop: space.s40 },

  /* 分页状态条：追加中 / 失败重试。居中、与空态同一档留白，读起来是一段「列表尾注」 */
  loadMore: { alignItems: 'center', gap: space.s12, paddingVertical: space.s24 },
  loadMoreError: { ...text.meta, color: colors.danger, textAlign: 'center' },

  /* 分段标签：渐变发丝线在上、时间标签在下，两者的间距与旧版的 paddingTop 同档 */
  groupHead: { gap: space.s12 },
  /* 日尺度下段数翻几倍：线与标签的间距同步收紧（Web 的 .masonry--fine） */
  groupHeadFine: { gap: space.s8 },
  /* 线本体：8 段等宽、透明度递减（见 HAIRLINE_STOPS），整行占位、不压照片 */
  hairline: { flexDirection: 'row', height: 1, borderRadius: 1, overflow: 'hidden' },
  hairlineSegment: { flex: 1, backgroundColor: colors.border.base },
  /* 时间标签：accent、15px/600、等宽数字（数值纵列对齐，读数不跳动） */
  groupHeadLabel: { ...text.heading, ...tabularNums, color: colors.accent },
  /* 时间标签与张数同行：基线对齐让字号差自然分出层级（张数读作标题的注解）。
     张数走 text.meta（元信息档、三级文字色，正是为「计数」备的那一档）+ 等宽数字，
     与 Web 的 .masonry__time-sep-count 同口径。 */
  groupHeadRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.s8 },
  groupHeadCount: { ...text.meta, ...tabularNums },

  /* 墙面 */
  wallGroup: { gap: space.s12 },
  /* 列式墙面：N 条独立纵列，间距与 Web 的 .masonry__grid 同档 */
  wallColumns: { flexDirection: 'row', columnGap: space.s4, alignItems: 'flex-start' },
  /* 纵向留白必须与上面的 columnGap 同档：原先用 space.s12（12px）会让上下相邻照片
     比左右相邻多出 8px 的缝，整面墙看起来被横向「切条」。两个方向共用同一个 token，
     既与 Web 的 .masonry__grid 同档，也保证换屏宽时横竖比例同步伸缩。 */
  wallColumn: { flex: 1, minWidth: 0, rowGap: space.s4 },
  /* 卡面只有照片本体：Pressable 必须**贴着照片**（宽度吃满列宽、高度只取内容高）。
     这里不能用 flex —— flexGrow 会把列里的多余空间灌进卡片，在照片下方留下一条
     属于卡片、却什么都没有的空白（点它会被当成点照片，等于误进大图）。 */
  tile: { width: '100%' },
  /* 照片直角显示：图墙不做圆角裁切，因此也不必再开 overflow 裁剪 */
  tileFrame: { width: '100%' },
  pressed: { opacity: 0.75 },

  /* 列表 */
  /* 缩略图：显式分行（chunkRows），行内多格 flex 等分。
     不用 flexWrap + 百分比 flexBasis —— 该组合在本机 RN 上会把百分比按整屏宽解析，
     换行错位且格子会落到可视区外。 */
  thumbGrid: { gap: space.s8 },
  /* 行内按各自的照片高度对齐：行高由最高的那格决定，但**不把其余格拉伸**到行高 ——
     否则矮的那几张（横构图）下方会多出一块可点的空白 */
  thumbRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.s8 },
  thumbPad: { flex: 1 },
  thumb: { flex: 1 },
  /* 照片直角显示，同图墙卡面 */
  thumbFrame: { width: '100%' },

  /* 长按浮层：贴着照片本体铺满（照片上缘因此不被压暗），信息块收在下缘。
     材质取 material.ultraThick —— token 里为「压在照片上的可读性底色」备的那一档
     （Web 那条渐变的下半段同色），文字于是不依赖照片本身的明暗。 */
  peekOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  peek: {
    paddingHorizontal: space.s8,
    paddingVertical: space.s8,
    gap: space.s4,
    backgroundColor: colors.material.ultraThick,
  },
  peekTitle: { ...text.label, fontWeight: '600' },
  peekGear: { flexDirection: 'row', alignItems: 'center', gap: space.s6 },
  peekCam: { ...text.meta, color: colors.text.secondary, flexShrink: 1 },
  /* 格式胶囊：与 Web 的 .photo-card__format 同款（accent 淡洗底 + accent 字） */
  peekFormat: {
    ...text.meta,
    color: colors.accent,
    fontWeight: '600',
    paddingHorizontal: space.s6,
    paddingVertical: space.s2,
    borderRadius: radius.full,
    backgroundColor: accentRgba(accentOpacity.wash),
    overflow: 'hidden',
  },
  /* 地点 / 时间 / 分辨率同行：地点在**时间左侧**，三者依次居左 */
  peekRow: { flexDirection: 'row', alignItems: 'center', gap: space.s8 },
  peekPlace: { flexDirection: 'row', alignItems: 'center', gap: space.s4, flexShrink: 1 },
  peekPlaceText: { ...text.meta, color: colors.accent, flexShrink: 1 },
  peekDate: { ...text.meta, ...tabularNums, color: colors.text.secondary, fontFamily: fontFamily.mono },
  peekResolution: { ...text.meta, ...tabularNums, fontFamily: fontFamily.mono },
  peekExposure: { ...text.meta, fontFamily: fontFamily.mono },

  /* 选择模式（admin 批量编辑） */
  checkBadge: {
    position: 'absolute',
    top: space.s8,
    right: space.s8,
    width: 22,
    height: 22,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: colors.text.base,
    backgroundColor: colors.material.ultraThick,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOverlay: {
    ...StyleSheet.absoluteFillObject,
    /* 压暗层由背板色派生（不再写死 rgba(0,0,0,.18)）：换主题色时不会留下一块异色 */
    backgroundColor: backgroundRgba(0.18),
  },
  editBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    /* 三枚操作（全选 / 退出 / 批量编辑）+ 计数在窄屏放不下一行时换行，不挤压文案 */
    flexWrap: 'wrap',
    gap: space.s8,
    marginTop: space.s8,
    paddingHorizontal: space.s12,
    paddingVertical: space.s8,
    borderRadius: radius.xl,
    backgroundColor: colors.material.thick,
  },
  editBarCount: { ...text.label, color: colors.text.secondary, flexShrink: 0 },
  editBarActions: { flexDirection: 'row', alignItems: 'center', gap: space.s8 },
  editAction: {
    paddingHorizontal: space.s16,
    height: 32,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.material.thin,
  },
  editActionText: { ...text.label, color: colors.text.secondary },
  editActionPrimary: { backgroundColor: colors.accent },
  editActionPrimaryText: { ...text.label, color: colors.background, fontWeight: '600' },
  editActionDisabled: { opacity: disabledOpacity },
});
