/**
 * packages/core/src/rail.ts
 *
 * 时间刻度（轨）的纯计算：刻度生成、落点整形、抽稀步长、读数判定。
 *
 * 【为什么放在 core】这套计算此前只活在 Web 的 useGalleryRail 里，而移动端的
 * 底部时间线横轨需要的是**同一个口径** —— 同一份 marks、同一条落点整形、
 * 同一句读数。两端各写一份，同一个月份在两根轨上就会落在不同的比例上。
 *
 * 【这里只搬「算什么」，不碰「怎么量」】Web 量的是 DOM 真实几何（measureAnchors
 * 仍留在 Web 的 hook 里）；移动端没有 DOM，改用下标比例（见 buildIndexMarks）。
 * 两者都归约成同一份 RailAnchor，后面的刻度生成、整形、读数因此逐字共用。
 */
import { formatDay, formatMonth, scaleKeyOf, scaleLabelOf } from './timeline';
import type { TimeScale } from './timeline';
import type { Photo } from './types';

/**
 * 轨上的一枚刻度。
 * 【两级文案】刻度本身只写小单位（「8月」/「8/6」），大单位（年 / 月）另有一条车道：
 * 月尺度下大单位是年、日尺度下大单位是月 —— 于是「切到日」不是把标签换成更密的同一层，
 * 而是把整条轨的层级整体下沉一级，年 / 月 / 日三级信息在同一个视野里各就各位。
 */
export interface RailMark {
  /** 判等与 React key：月尺度 YYYY-MM / 日尺度 YYYY-MM-DD */
  key: string;
  /** 内车道刻度文字：月尺度「8月」/ 日尺度「8/6」 */
  label: string;
  /** 外车道大单位文字：月尺度年份「2026」/ 日尺度月份「8月」 */
  majorLabel: string;
  /** 完整读数文字（浮标与读屏共用）：月尺度「2026 · 8月」/ 日尺度「2026 · 8月6日」 */
  text: string;
  year: string;
  /** 真实的滚动比例，0 = 起点（最新）、1 = 终点（最旧）。**跳转与读数只看它** */
  progress: number;
  /**
   * 轨上的落点比例。
   * 【为什么要与 progress 分开】横向轨在日尺度下刻度极密，落点必须整形
   * （单调 + 相邻不叠字，见 densifyMarks），整形后就不再等于滚动比例 ——
   * 若还拿它当跳转目标，点「4月」会跳到别的月份去。纵向轨不需要整形，两者相等。
   */
  ratio: number;
  /** 大单位起点：月尺度=年初、日尺度=月初。外车道标签与加粗刻度都只看它 */
  isMajor: boolean;
}

/**
 * 轨上的时间读数。
 * 【为什么带 key 与 majorKey】高亮必须与「读的是哪一枚刻度」逐字同源：
 * key 用来点亮内车道那一枚，majorKey 用来点亮外车道的大单位（年 / 月）。
 * 若各自按比例反推，边界上必然出现「读数说 6 月、高亮停在 7 月」。
 */
export interface RailLabel {
  /** 与 RailMark.key 同源 */
  key: string;
  /** 所属年份：外车道高亮在月尺度下按它判定 */
  year: string;
  /** 当前大单位刻度的 key（月尺度=年份起点、日尺度=月初） */
  majorKey: string;
  /** 已格式化的完整读数，如「2026 · 8月」/「2026 · 8月6日」 */
  text: string;
}

/** 一张照片在滚动范围里的真实位置：index 是它在有序列表里的下标，top 是像素比例 */
export interface RailAnchor {
  index: number;
  top: number;
}

/**
 * 内车道文字最多摆这么多枚。
 * 【为什么要有上限】月尺度下整份档案约 40 余枚刻度，逐枚写字正好排得下；
 * 切到日尺度后刻度会翻到两三倍，逐枚写字会糊成一片实心条。
 * 超过上限就按固定步长抽稀，**但当前读数那一枚永远渲染**（见 ProgressRail）。
 */
export const MAX_MINOR_LABELS = 44;

/**
 * 标准停靠条（1040）下的可用轨道宽：1040 − 两侧 16 内边距 − 两端 24 让位 = 960。
 * 整形以它为「单位 1」：需求没超出它就完全不动位置，超出了才按比例把舞台加长。
 *
 * 【它只是缺省值，不是唯一合理的基准】停靠条宽度随视口收缩（min(1040, 100vw − 48)），
 * 手机竖屏 411dp 时可用轨宽只剩 283px —— 若仍按 960 整形，落入这种窗口的刻度
 * 会被摊到四倍宽的时间轴上，一屏只看得到整段档案的 1/4。因此 densifyMarks 允许
 * 调用方传入**其实际可用的轨宽**（移动端的用法即是如此），本常量只留给
 * 「停靠条已达最大宽」的场景当缺省值。
 */
export const BASE_TRACK_PX = 960;

/** 两端让位，与 app.css 的 --rail-end-pad 同值：算舞台 min-width 时要加回去 */
export const END_PAD_PX = 24;

/** 相邻两枚刻度数字之间必须留出的空隙 */
export const LABEL_GAP_PX = 8;

/** 与轨上的进度同源的夹取：刻度落点也必须留在 0–1 之间 */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 照片在当前尺度下的刻度键；日期缺失或不合法时返回 null（调用方必须跳过） */
export function markKeyOf(photo: Photo, scale: TimeScale): string | null {
  return scaleKeyOf(photo.date, scale);
}

/** 大单位键：月尺度看年、日尺度看月 —— 用来判定「这一枚是不是换了章节」 */
export function majorKeyOf(key: string, scale: TimeScale): string {
  return scale === 'month' ? key.slice(0, 4) : key.slice(0, 7);
}

/** 由刻度键写出它的三份文案（内车道 / 外车道 / 完整读数） */
export function describeMark(key: string, scale: TimeScale): Omit<RailMark, 'ratio' | 'progress' | 'isMajor'> {
  const month = key.slice(5, 7);
  return {
    key,
    /* 内车道只写小单位：月尺度「9月」/ 日尺度「9/6」 */
    label: scale === 'month' ? formatMonth(month) : formatDay(key),
    /* 外车道写大单位：月尺度年份 / 日尺度月份 */
    majorLabel: scale === 'month' ? key.slice(0, 4) : formatMonth(month),
    /* 完整读数与视图里的分组标题、分隔标签共用 core 的同一份文案 */
    text: scaleLabelOf(key, scale),
    year: key.slice(0, 4),
  };
}

/**
 * 由真实锚点生成刻度：progress 取该月（或该日）照片**最靠上**的实际位置，而不是下标比例。
 *
 * 【墙面为什么必须取 min】墙面按轮转分列（第 i 张进第 i % N 列），各列卡片高低不一、
 * 列尾不齐：某月「时间序第一张」若恰好落在一列高卡片堆叠里，位置会比上个月更靠下，
 * 轨上的刻度于是出现回退（实测 5 月在 6 月之上）。而每一列内部的月份严格有序，
 * 取该月在所有列中位置的最小值，可证明刻度严格单调 —— 列表是单列，最小值天然等于首条，
 * 因此这一条规则两个视图、两种尺度共用，刻度的基准完全一致。
 */
export function buildMeasuredMarks(
  ordered: readonly Photo[],
  anchors: readonly RailAnchor[],
  scale: TimeScale,
): RailMark[] {
  /** key → 该刻度已见最靠上的位置；order 只负责保序输出（anchors 已按时间下标排好） */
  const firstTop = new Map<string, number>();
  const order: string[] = [];

  for (const anchor of anchors) {
    const photo = ordered[anchor.index];
    if (!photo) continue;
    /* 没有 EXIF 日期的照片不产生刻度（返回 null），否则轨上会多一枚「0 月」/「0/0」 */
    const key = markKeyOf(photo, scale);
    if (!key) continue;
    const seen = firstTop.get(key);
    if (seen === undefined) {
      firstTop.set(key, anchor.top);
      order.push(key);
    } else if (anchor.top < seen) {
      firstTop.set(key, anchor.top);
    }
  }

  return order.map((key, index) => ({
    ...describeMark(key, scale),
    progress: firstTop.get(key)!,
    ratio: firstTop.get(key)!,
    isMajor: index === 0 || majorKeyOf(order[index - 1]!, scale) !== majorKeyOf(key, scale),
  }));
}

/**
 * 移动端专用：没有 DOM 可量，用「下标比例」当地锚点。
 *
 * 【为什么可以这么替代】Web 量真实像素是为了让刻度位置不假设排布；
 * 移动端的墙面是「按时间段 → 段内 N 列」，每个时间段独占一条横带，
 * 段内照片的时间序与纵向位置本就同向，因此下标比例与真实像素比例同构。
 * 代价是段内卡片高低不一时读数会有几十像素的偏差 —— 这是没有布局引擎可量时的取舍。
 */
export function buildIndexMarks(ordered: readonly Photo[], scale: TimeScale): RailMark[] {
  const last = Math.max(1, ordered.length - 1);
  const anchors: RailAnchor[] = ordered.map((_, index) => ({ index, top: index / last }));
  return buildMeasuredMarks(ordered, anchors, scale);
}

/**
 * 估算一枚刻度数字的渲染宽度：汉字 11px、其余字符 6.5px。
 * 两个值都对着 11px 字号实测过（「9月」18px、「10月」25px、「9/12」26px、「10/26」32px），
 * 因此这份估算足够判断「这两枚数字会不会压在一起」，不需要真去量 DOM。
 */
export function labelWidthOf(text: string): number {
  let width = 0;
  for (const char of text) width += /[\u3400-\u9fff]/.test(char) ? 11 : 6.5;
  return width;
}

/**
 * 把「真实滚动位置」整形成「可读落点」：单调不减，且相邻两枚至少隔开半字宽之和 + 空隙。
 *
 * 【为什么横向必须整形】纵向轨贴着整屏高度，21 枚日刻度摊开后基本不相压；
 * 横向只有一屏宽，而墙面的真实滚动位置在日尺度下**本就不单调** —— 墙面按轮转分列，
 * 相邻两个日期可能落在不同列的不同高度（实测 8/9 比 8/12 更靠上、间距几十像素），
 * 于是日尺度下会出现「8/9 完全盖在 8/12 上」这种整片数字糊住的情况。
 *
 * 【做法】按时间序推一遍：理想落点（progress × 基准宽）与「上一枚 + 所需间隙」
 * 取较大者 —— 稀疏处保持真实位置、密集处才被往后推。推完的总跨度超出基准宽时
 * 由调用方把舞台按比例加长（返回 spanPx），由可视窗横向滚动保底。
 * 因此月尺度（刻度稀疏）推不动，位置与滚动严格对应；日尺度才适度延长。
 *
 * @param baseTrackPx 调用方实际可用的轨道宽（缺省为满宽停靠条下的 960）。
 *   【为什么必须能传】它是「单位 1」：窗口比 960 窄时仍按 960 摆，
 *   整段档案会被摊到窗口的好几倍宽 —— 手机竖屏因此只能看到时间线的一小截。
 *   传入真实可用宽后，摆得下的档案（月尺度）会整段收进视窗，摆不下的才继续加长。
 */
export function densifyMarks(
  marks: readonly RailMark[],
  baseTrackPx: number = BASE_TRACK_PX,
): { marks: RailMark[]; spanPx: number } {
  if (marks.length === 0) return { marks: [], spanPx: 0 };
  const base = Math.max(1, baseTrackPx);

  const placed: number[] = [0];
  for (let index = 1; index < marks.length; index += 1) {
    const previous = marks[index - 1]!;
    const gapPx = (labelWidthOf(previous.label) + labelWidthOf(marks[index]!.label)) / 2 + LABEL_GAP_PX;
    placed.push(Math.max(marks[index]!.progress * base, placed[index - 1]! + gapPx));
  }

  /* 舞台只加长、不缩短：摆得下时保持基准宽，落点仍等于真实比例 */
  const span = Math.max(base, placed[placed.length - 1]!);
  return {
    marks: marks.map((mark, index) => ({ ...mark, ratio: placed[index]! / span })),
    spanPx: 2 * END_PAD_PX + span,
  };
}

/**
 * 按当前进度读时间点：刻度表按「新 → 旧」排列、ratio 严格递增，
 * 返回最后一枚「入口已越过判定线」的刻度，并一并记录它属于哪个大单位
 * （外车道高亮与内车道高亮因此都来自这一份读数，不会出现两处不一致）。
 * 进度在第一枚之前（含顶部过度滚动）时读第一枚。
 * 首帧几何还没量出来（刻度表为空）时退回有序下标，保证读数不闪空 —— 页面初始 progress 本就为 0。
 */
export function labelAtProgress(
  marks: readonly RailMark[],
  ordered: readonly Photo[],
  progress: number,
  scale: TimeScale,
): RailLabel | null {
  if (marks.length > 0) {
    let current = marks[0]!;
    let majorKey = current.key;
    /* 遍历全部、取「已越过判定线的刻度里时间序最靠后的一枚」。
       【为什么不能遇到第一枚没越过的就 break】那个写法假设刻度位置严格单调递增，
       但日尺度下不成立：刻度间距只剩几十像素，墙面各列的高度差足以让更旧的一刻
       落在更靠上的位置（实测 4/19 在 4/26 之上、6/6 在 7/10 之上）。带 break 时
       遍历会提前停在中段，点「4/26」反而读到「6月6日」。 */
    for (const mark of marks) {
      if (mark.progress > progress + 0.0005) continue;
      current = mark;
      if (mark.isMajor) majorKey = mark.key;
    }
    return { key: current.key, year: current.year, majorKey, text: current.text };
  }

  const photo = ordered[Math.round(progress * (ordered.length - 1))];
  const key = photo ? markKeyOf(photo, scale) : null;
  if (!key) return null;
  const described = describeMark(key, scale);
  return { key, year: described.year, majorKey: key, text: described.text };
}

/** 内车道文字的抽稀步长：刻度少时（月尺度）为 1，即逐枚都写 */
export function labelEveryFor(marks: readonly RailMark[]): number {
  return Math.max(1, Math.ceil(marks.length / MAX_MINOR_LABELS));
}

/** 刻度集合是否等价：只有位置真的变了才写 state，避免「量 → 渲染 → 再量」转不停 */
export function sameMarks(left: readonly RailMark[], right: readonly RailMark[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((mark, index) => {
    const other = right[index]!;
    return (
      mark.key === other.key && mark.label === other.label && Math.abs(mark.progress - other.progress) < 0.0005
    );
  });
}

/** 读数是否等价：跨刻度时 key 变，跨年 / 跨月时 majorKey 变 —— 两者都不变就复用旧对象 */
export function sameLabel(left: RailLabel | null, right: RailLabel | null): boolean {
  if (!left || !right) return left === right;
  return left.key === right.key && left.majorKey === right.majorKey;
}
