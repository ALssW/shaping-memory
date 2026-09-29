/**
 * apps/web/src/components/ProgressRail.tsx
 *
 * 进度轨的展示层：轨道 + 挂在轨上的时间刻度标签 + 填充 + 滑块。
 *
 * 【两种朝向，同一套刻度】纵向版钉在列表左缘，横向版浮在墙面正下方居中 ——
 * 两者共用同一份刻度数据（位置、文案、抽稀都由 useGalleryRail 算好），
 * 这里只把「比例」映射到纵向的 top 或横向的 left。但两者是**两套相反的隐喻**：
 *   - 纵向 = 尺子不动、游标动：滑块与命中标签随进度走，已走过的填充从起点长到滑块；
 *   - 横向 = 游标不动、尺子动：滑块与读数钉在正中，时间线整条左移（见 .progress-rail__stage
 *     的 translateX），已走过的进度不再是一条填充，改由中心光带 + 呼吸表达。
 * 其余差异：抽稀只发生在纵向（横向的时间轴会按内容延长，见下）；
 * 刻度与标签的摆放方向由 CSS 的 --horizontal 变体接管。
 *
 * 【横向为什么允许「比停靠条更长」】横向版要在一行里摊开全部刻度数字（月尺度「9月」/
 * 日尺度「9/6」），而墙面的真实滚动位置在日尺度下本就非单调且密集 —— 不处理就会有
 * 数字完全盖住另一个数字。因此落点先整形（单调 + 相邻不叠字，见 useGalleryRail 的
 * densifyMarks），整形后总跨度超出停靠条时再给舞台一个 min-width：
 * 时间线因此更长，同样的进度差就走得更远，密集处的数字才有摆放空间。
 * 跳转仍走 mark.progress（真实滚动比例）—— 落点整形过，不能再当跳转目标。
 * 纵向没有这一层：它贴着列表整屏高度，天然装得下，抽稀仍然是它更合适的取舍。
 *
 * 【刻度为什么围着轨道换边（纵向版）】每一枚内车道刻度都带一个标签：平时停在轨道**左侧**，
 * 当滚动到达它那个时间点时滑到轨道**右侧**并点亮 accent，越过之后再滑回左侧原位。
 * 于是「我现在读到哪一刻」不需要另做图腾 —— 右侧那一枚就是答案，
 * 而左侧那列始终摊着整份档案的时间分布。
 *
 * 【为什么标签与轨道并列为兄弟】整条轨都是拖拽命中区（横向落在轨根、纵向落在轨道上，
 * 见 useProgressRail 的文件头），所以标签必须自己接事件才点得动 ——
 * 轨道里只画刻度短横线，一律 pointer-events: none，命中区保持完整。
 * 标签层与轨道同尺寸，同一个比例坐标因此落在同一条线上。
 *
 * 【命中后为什么要跟着滚动点走】命中那一枚的落点从「它自己那枚刻度」换成
 * 「当前滚动点」：刻度只说明这张照片在档案里的位置，而滚动点才是当前读到的位置。
 *
 * 【纵向为什么不用 Motion】全档案有 40 余枚刻度，逐帧 diff 这么多动画并不划算。
 * 命中与未命中的落点都写成 CSS 变量（--mark-ratio / --rail-progress），位移交给 CSS transition；
 * 只有滑块与填充留给 Motion。
 */
import { useMemo } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { motion } from 'motion/react';

import { fade, INSTANT } from '../lib/motion';
import type { RailHitProps, RailLabel, RailOrientation, RailSliderProps } from '../hooks/useProgressRail';
import type { RailMark } from '../hooks/useGalleryRail';

interface ProgressRailProps {
  progress: number;
  /** 当前时间点（未格式化） */
  label: RailLabel | null;
  dragging: boolean;
  /** 轨上的时间刻度（时间分布） */
  marks: readonly RailMark[];
  /** 当前越过的刻度 key，用于高亮与「留在右侧」 */
  activeKey: string | null;
  /** 内车道文字的抽稀步长：1 = 逐枚都写 */
  labelEvery: number;
  /** 横向舞台的所需宽度（px，由 useGalleryRail 的落点整形算出）；纵向为 0，不使用 */
  spanPx: number;
  /** 朝向：纵向（列表左缘）/ 横向（墙面底部） */
  orientation: RailOrientation;
  /** 点刻度 / 点大单位的跳转出口，与拖动共用同一条路径 */
  jumpTo: (ratio: number) => void;
  /** 拖拽与键盘的事件：横向展开在轨根（整条轨都可拖）、纵向展开在轨道上 */
  hitProps: RailHitProps;
  /** role / tabIndex / aria-*：两种朝向都留在轨道上（见 RailSliderProps 的注释） */
  sliderProps: RailSliderProps;
  /** 轨道元素：横向拖拽要拿它的宽度当「时间线可移距离」 */
  trackRef: RefObject<HTMLDivElement>;
}

/** 刻度位置全部走 CSS 变量：--mark-ratio 是这一枚的原始落点，--rail-progress 是当前滚动点 */
type SlotStyle = CSSProperties & { '--mark-ratio': number };
/** 舞台的横向最小跨度也走 CSS 变量：横向版据此把时间轴拉长到「摆得下全部刻度数字」 */
type StageStyle = CSSProperties & { '--rail-min-span': string };

export function ProgressRail({
  progress,
  label,
  dragging,
  marks,
  activeKey,
  labelEvery,
  spanPx,
  orientation,
  jumpTo,
  hitProps,
  sliderProps,
  trackRef,
}: ProgressRailProps) {
  /* 拖动时不能有补间（优先保证跟手性），其余时候用 token 里最快的一档 */
  const transition = dragging ? INSTANT : fade('fast');
  const horizontal = orientation === 'horizontal';

  /* 每一年（日尺度下是每一月）只在它的第一枚刻度处落一个大单位标签 */
  const majorMarks = useMemo(() => marks.filter((mark) => mark.isMajor), [marks]);

  /** 沿轨方向的坐标：横向走 left、纵向走 top。刻度短横线、标签、滑块都用它 */
  const along = (ratio: number) => (horizontal ? { left: `${ratio * 100}%` } : { top: `${ratio * 100}%` });
  /* 标签落点：纵向仍写成 CSS 变量 —— CSS 里那条 clamp（顶部安全边）要靠它算；
     横向没有换边与安全边的讲究，直接给 left 即可。 */
  const labelStyle = (ratio: number) =>
    horizontal ? along(ratio) : ({ '--mark-ratio': ratio } as SlotStyle);

  /* 横向的时间轴所需宽度：由 useGalleryRail 的落点整形算出（见 densifyMarks）。
     舞台的 min-width 取「本值 与 可视窗宽度 里的较大者」，因此只有真的摆不下才会变长。 */
  const minSpan = spanPx;

  /* 纵向：填充从起点长到滑块处 —— 填充量就是滑块距起点的距离。
     横向不画它：滑动点恒定在正中、时间线整体平移，没有「已走过的进度条」这回事，
     那一小段光带与呼吸交给 CSS 的 .progress-rail__focus。 */
  const fill = horizontal ? null : (
    <motion.span
      className="progress-rail__fill"
      initial={false}
      animate={{ height: `${(1 - progress) * 100}%` }}
      transition={transition}
    />
  );

  /* 滑块：纵向随进度上下走（尺子不动、游标动），横向钉在正中（游标不动、尺子动）。
     横向因此不把 along(progress) 交给 Motion —— 位置由 app.css 的 --horizontal 变体钉死。 */
  const thumb = (
    <motion.span
      className="progress-rail__thumb"
      initial={false}
      animate={horizontal ? { left: '50%' } : along(progress)}
      transition={transition}
    />
  );

  /* 命中区落在哪一层由朝向决定（见 useProgressRail 的文件头）：
     横向落在轨根 —— 轨道活在会被平移的舞台里，而且「整条轨任意位置都能拖」；
     纵向落在轨道本身 —— 它就是那条细尺子，与「按哪读哪」的绝对映射同源。
     语义（role / tabIndex / aria）不跟着走：它始终留在轨道上。 */
  const rootHitProps = horizontal ? hitProps : undefined;
  const trackHitProps = horizontal ? undefined : hitProps;

  /* 轨道 + 两层刻度标签：纵向直接铺在轨根上；横向多包一层「可视窗 + 舞台」——
     可视窗负责裁掉超出停靠条两端的刻度，舞台负责承载长度并经 transform 整体平移。 */
  const railBody = (
    <>
      <div className="progress-rail__track" ref={trackRef} {...sliderProps} {...trackHitProps}>
        {/* 刻度短横线不接事件：整条轨的拖拽命中区必须保持完整，文字标签在上一层 */}
        {marks.map((mark) => (
          <span
            key={mark.key}
            className={`progress-rail__mark${mark.isMajor ? ' is-major' : ''}${mark.key === activeKey ? ' is-on' : ''}`}
            style={along(mark.ratio)}
          />
        ))}
        {horizontal ? null : (
          <>
            {fill}
            {thumb}
          </>
        )}
      </div>

      {/* 浮标层：大单位标签（年 / 月）+ 内车道刻度数字。
          与轨道同尺寸，因此同一个比例坐标就落在同一条线上。 */}
      <div className="progress-rail__floaters">
        {majorMarks.map((mark) => (
          <button
            key={mark.key}
            type="button"
            /* tabIndex -1：刻度标签不该占满 Tab 顺序，键盘跳转由轨道上的方向键承担 */
            tabIndex={-1}
            className={`progress-rail__major${mark.key === label?.majorKey ? ' is-on' : ''}`}
            style={labelStyle(mark.ratio)}
            onClick={() => jumpTo(mark.progress)}
            aria-label={`跳到 ${mark.majorLabel} 起点`}
          >
            {mark.majorLabel}
          </button>
        ))}

        {marks.map((mark, index) => {
          /* 抽稀只发生在纵向：横向的时间轴会按内容加长（见 minSpan），
             摆得下就逐枚写字、摆不下就横向滚动 —— 刻度数字因此永远是全的。
             被抽稀的那些仍渲染出来（用 is-muted 收成透明）：它们要能参与
             「滑到右侧」的过渡，突然挂载会跳一下。 */
          const muted = !horizontal && index % labelEvery !== 0 && mark.key !== activeKey;
          return (
            <button
              key={mark.key}
              type="button"
              tabIndex={-1}
              className={`progress-rail__minor${mark.key === activeKey ? ' is-on' : ''}${muted ? ' is-muted' : ''}`}
              style={labelStyle(mark.ratio)}
              onClick={() => jumpTo(mark.progress)}
              aria-label={`跳到 ${mark.text}`}
            >
              {mark.label}
            </button>
          );
        })}
      </div>
    </>
  );

  return (
    /* --rail-progress 挂在轨的根上：命中那一枚标签靠它把落点切到滚动点。
       横向的拖拽命中区（含 role=slider 与全部指针/键盘事件）也挂在这里 —— 整条轨
       任意位置都能拖，而不是只有那条 16px 的轨道；纵向落在轨道上（见 railBody）。 */
    <div
      className={`progress-rail progress-rail--${orientation}${dragging ? ' is-dragging' : ''}`}
      style={{ '--rail-progress': progress } as CSSProperties}
      {...rootHitProps}
    >
      {/* 横向版的读数：居中一行，压在时间轴之上 —— 它不随横向滚动走，
          因此任何滚动位置下「当前读到哪一刻」都停在停靠条正中。 */}
      {horizontal ? (
        <p className="progress-rail__readout" aria-hidden="true">
          {label?.text ?? ''}
        </p>
      ) : null}

      {horizontal ? (
        <div className="progress-rail__viewport">
          <div className="progress-rail__stage" style={{ '--rail-min-span': `${minSpan}px` } as StageStyle}>
            {railBody}
          </div>
        </div>
      ) : (
        railBody
      )}

      {/* 横向的滑动点必须画在可视窗**之外**：它钉在停靠条正中、不参与时间线平移，
          而它的光晕要向上洇出停靠条 —— 留在 overflow: hidden 的可视窗里会被整块裁掉。 */}
      {horizontal ? (
        <>
          <span className="progress-rail__focus" aria-hidden="true" />
          {thumb}
        </>
      ) : null}
    </div>
  );
}
