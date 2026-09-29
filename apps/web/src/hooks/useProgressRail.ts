/**
 * apps/web/src/hooks/useProgressRail.ts
 *
 * 进度轨的通用逻辑：滚动 → 进度 + 年月读数，以及拖拽 / 键盘反向改写滚动位置。
 * 画廊的墙面与列表两个视图共用这一份，两处只有**读数怎么来**不同（见 RailStrategy）。
 *
 * 【为什么读数不读 DOM】两个视图同屏并存的时间跨度并不相同：
 * 墙面是 N 条贯穿整页高度的纵列（同一屏必然并存 N 个月份），
 * 列表则是单列、一屏跨一个月左右。「屏幕里是哪个月」在两种排布下
 * 不是同一个问题，因此两个视图统一改成**档案时间刻度**：进度 0 = 最新一张、
 * 进度 1 = 最旧一张，按比例落在日期有序列表上（纯计算，不读 DOM）。
 * 策略之外的一切（进度公式、指针捕获、键盘步长、rAF 节流）两边完全一致。
 *
 * 【性能约定】(1) 滚动监听只订阅一次，rAF 节流：一帧最多算一次几何；
 * (2) progress 千分位取整后再入 state —— 数值没变就不触发渲染；
 * (3) 读数只在跨月时才换对象引用，滚动时绝大多数帧的 setState 直接被 React 短路。
 *
 * 【几何约定】判定线取 sdk 的 themeTlLine()：与 app.css 的 --tl-line **同一个公式**
 * （--size-header + 56px × 倍率），因此倍率怎么改，两边都跟着走。
 *
 * 【拖拽约定：命中区与两种映射】
 * 命中区——纵向落在轨道本身（那条细尺子，16px 宽），横向落在**轨根**：
 * 横向要求「整条轨任意位置都能拖」，而它的轨道活在会随进度平移的舞台里
 * （见 ProgressRail 的 .progress-rail__stage），拿它当命中区既不完整也不稳。
 * 映射——纵向是**绝对**的（轨不动，按哪读哪），横向是**相对增量**的
 * （时间线跟着手走：手指横向移动多少像素，时间线就移多少像素）。
 * 横向若也用绝对映射就会形成自反馈：指针坐标锚在一个随进度平移的坐标系上，
 * 于是越拖越偏、半边被夹死。相对增量的分母取轨道自己的宽度
 * （= 舞台宽 − 两端让位），因此指针走满它正好是进度 0→1。
 * 另外：拖动末尾那一次 click 会被指针捕获改派给命中区（实测 Chrome：click target = 捕获元素），
 * 若按下的位置是刻度标签，那一次 click 就会盖掉刚拖出来的进度 —— 因此超过 DRAG_SLOP 的
 * 拖动会把它吞掉（见 onClickCapture）；反过来「按下落在标签上且没拖动」时不能捕获指针，
 * 否则标签自己的点击跳转永远收不到 click（见 onPointerDown）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import type { RailLabel, TimeScale } from '@shaping-memory/core';
import { themeTlLine } from '@shaping-memory/sdk';

/** 与 app.css 的 --tl-line 同源（必须是精确值，不给余量）：
 *  48px 悬浮页头 + 画廊置顶工具栏高 56px，再整体乘主题倍率。它同时是轨的吸附点与
 *  （画廊模块顶部留白收窄后）轨的静态位置 —— 两者相等，轨才会一动不动地钉在视口里。
 *  【为什么是函数而不是常量】倍率由后台配置，运行时才知道；写成常量就会与 CSS 分叉，
 *  差 1px 都会让轨在滚动开头先跳一下。 */
const tlLine = (): number => themeTlLine();
/** 键盘调档步长 */
const KEY_STEP = 0.05;
/** 「点了一下」与「真的在拖」的分界（px）：与 Viewer 区分点击/拖曳用的是同一档 */
const DRAG_SLOP = 4;

/** 轨的朝向：列表视图走纵向（钉在左缘），墙面视图走横向（浮在页面正下方） */
export type RailOrientation = 'vertical' | 'horizontal';

/** 时间刻度的粒度：月（默认，整份档案的分布）或日（逐日精读）。
 *  与 core 的分组口径是**同一个类型**：轨上刻度、图墙分隔线、列表分组必须一起换口径。 */
export type RailScale = TimeScale;

/**
 * 轨上的时间读数。
 * 【定义已上移到 core】读数由 core 的 labelAtProgress 判定，类型自然也该由它给出 ——
 * 高亮必须与「读的是哪一枚刻度」逐字同源（key 点亮内车道那一枚，
 * majorKey 点亮外车道的大单位），类型不一致就会在边界上产生分歧。
 */
export type { RailLabel };

/** 视图专属的读数策略：拿到进度与容器，说出「当前时间点」 */
export interface RailStrategy {
  read: (progress: number, container: HTMLElement) => RailLabel | null;
}

/** 轨的语义与焦点：**永远挂在轨道上**，横向也不跟着命中区走。
 *  【为什么不能挪到轨根】role="slider" 的子树在无障碍树里是装饰性内容，
 *  刻度标签一旦落进它内部就从树里消失（实测：8 枚「跳到 …」按钮全部不再暴露）——
 *  那是可点的功能，不能只对读屏隐藏。于是语义留在轨道、事件去命中区。 */
export interface RailSliderProps {
  role: 'slider';
  tabIndex: number;
  'aria-label': string;
  'aria-orientation': RailOrientation;
  'aria-valuemin': number;
  'aria-valuemax': number;
  'aria-valuenow': number;
  'aria-valuetext'?: string;
}

/** 拖拽命中区要展开的事件（纵向在轨道上、横向在轨根上，见文件头）。
 *  键盘也在这里：横向挂轨根，焦点落在轨道或刻度标签上时方向键都能穿透到它。 */
export interface RailHitProps {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** 吞掉「拖完之后补发的那一次 click」，避免它误触刻度标签（见文件头） */
  onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

/** 一次拖拽的锚点：按下瞬间的指针坐标、进度，以及两种朝向各自要用的几何 */
interface DragAnchor {
  /** 按下时的指针坐标（横向取 X、纵向取 Y） */
  pointer: number;
  /** 按下时的进度：横向作为相对增量的基准 */
  progress: number;
  /** 纵向绝对映射用的轨道矩形（按下时量一次即可 —— 轨是 sticky，拖拽期间不动） */
  rect: DOMRect;
  /** 横向的可移距离（= 轨道宽 = 舞台宽 − 两端让位），指针走满它正好是进度 0→1 */
  travel: number;
  /** 是否已拿到指针捕获。按下落在刻度标签上时先不捕获，越过 DRAG_SLOP 再补（见 onPointerDown） */
  captured: boolean;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** 与轨上的进度同源的夹取：刻度落点也必须留在 0–1 之间（见 useGalleryRail 的锚点换算） */
export { clamp01 };

/** 指针事件里与轨朝向对应的那一根轴（横向看 X，纵向看 Y） */
function axisPos(event: { clientX: number; clientY: number }, orientation: RailOrientation): number {
  return orientation === 'horizontal' ? event.clientX : event.clientY;
}

/** 指针坐标 → 命中区（或轨道）内 0–1 的比例。只吃矩形，不自己量 DOM：
 *  量几何的时机交给调用方 —— 纵向按下时量一次就够（轨是 sticky，拖拽期间不动），
 *  每帧重新量会把拖动变成一连串强制重排。 */
function ratioAt(clientPos: number, box: DOMRect, orientation: RailOrientation): number {
  const span = orientation === 'horizontal' ? box.width : box.height;
  const offset = clientPos - (orientation === 'horizontal' ? box.left : box.top);
  return offset / Math.max(1, span);
}

/** 键盘步进方向：横向轨走 ←/→，纵向轨走 ↑/↓ —— 与 aria-orientation 保持一致 */
function stepOf(key: string, orientation: RailOrientation): number {
  if (orientation === 'horizontal') {
    if (key === 'ArrowLeft') return -KEY_STEP;
    if (key === 'ArrowRight') return KEY_STEP;
    return 0;
  }
  if (key === 'ArrowUp') return -KEY_STEP;
  if (key === 'ArrowDown') return KEY_STEP;
  return 0;
}

/**
 * 内容区的滚动进度分母：内容高减去「视口高 - 判定线」。
 * 直觉版「内容高 - 视口高」在页首会把画廊头部那段算漏，进度永远到不了 1。
 *
 * 【为什么要导出】useGalleryRail 量照片真实位置时用的是同一把尺子：
 * 锚点比例 = 距容器顶的像素 / 这个分母，与 progress 严格同源，
 * 两者才能直接比大小（否则又变成两套口径互相冲突）。
 */
export function progressDenom(rect: DOMRect): number {
  return Math.max(1, rect.height - (window.innerHeight - tlLine()));
}

/** 容器几何 → 当前进度（未取整）。滚动测量与拖拽基准共用这一条公式：
 *  拖动开始时直接量一次，不必等「滚动 → rAF」那一趟，否则拖拽基准会滞后一两帧。 */
function progressOf(rect: DOMRect): number {
  return clamp01((tlLine() - rect.top) / progressDenom(rect));
}

interface UseProgressRailResult {
  /** 挂在「定义滚动范围的那个容器」上（即 .rail-layout 的根元素） */
  containerRef: RefObject<HTMLDivElement>;
  /** 挂在 .progress-rail__track 上：横向要拿它的宽度当「时间线可移距离」（见文件头） */
  trackRef: RefObject<HTMLDivElement>;
  progress: number;
  /** 已格式化的读数，如「2026 · 4月」；null 表示本视图不显示读数 */
  labelText: string | null;
  /** 当前时间点的原始字段：外车道高亮、内车道高亮、浮标文字各取一半 */
  label: RailLabel | null;
  dragging: boolean;
  /** 直接跳到某个进度（0–1）：拖动、键盘与「点刻度跳转」共用同一条路径 */
  jumpTo: (ratio: number) => void;
  /** 拖拽与键盘要展开的事件。展开在哪个元素上由视图决定（见文件头） */
  hitProps: RailHitProps;
  /** 轨的语义与焦点：两种朝向都挂在轨道上（见 RailSliderProps） */
  sliderProps: RailSliderProps;
}

/**
 * @param strategy 读数策略。**必须用 useMemo 固定引用**：它的身份变化会触发重新测量，
 *   各视图正是靠 `useMemo(() => ({ read }), [blocks])` 在筛选 / 排序变化后刷新进度与读数。
 * @param ariaLabel 轨的语义名称，如「墙面位置」/「列表位置」
 * @param orientation 轨的朝向。进度与滚动位置的关系与朝向无关（滚动永远是纵向的），
 *   朝向决定三件事：指针的哪一根轴算位置、键盘走 ←/→ 还是 ↑/↓、以及拖拽怎么映射
 *   （纵向绝对、横向相对增量，命中区也随之一个在轨道上、一个在轨根上，见文件头）。
 */
export function useProgressRail(
  strategy: RailStrategy,
  ariaLabel: string,
  orientation: RailOrientation = 'vertical',
): UseProgressRailResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [label, setLabel] = useState<RailLabel | null>(null);
  const [dragging, setDragging] = useState(false);
  /** 一次拖拽的全部状态。不用 state：它每帧都改，进 state 会把「跟手」变成「等重渲染」 */
  const dragRef = useRef<DragAnchor | null>(null);
  /** 本次按下是否已经越过 DRAG_SLOP（拖动中为 true；下一次 pointerdown 复位） */
  const movedRef = useRef(false);

  /** 把进度比例写回滚动位置：拖动与键盘共用同一条路径 */
  const jumpTo = useCallback((ratio: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const denom = progressDenom(rect);
    window.scrollTo(0, window.scrollY + rect.top - (tlLine() - clamp01(ratio) * denom));
  }, []);

  /* 滚动 → 进度 + 读数：rAF 节流，一帧最多算一次。
     依赖整个 strategy 而不是它的 read：read 多为模块级函数（引用恒定），
     只有策略对象的身份才会随内容变化 —— 那正是「内容换了一批，重测一次」的信号。 */
  useEffect(() => {
    let frame = 0;

    const measure = () => {
      frame = 0;
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const next = Math.round(progressOf(rect) * 1000) / 1000;
      setProgress((prev) => (prev === next ? prev : next));

      const found = strategy.read(next, container);
      setLabel((prev) => {
        if (!found) return prev === null ? prev : null;
        // 三项全等才复用旧对象：跨刻度时 key 会变，跨年 / 跨月时 majorKey 会变
        return prev && prev.key === found.key && prev.majorKey === found.majorKey ? prev : found;
      });
    };

    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [containerRef, strategy]);

  /* 进度轨拖拽：用指针捕获，指针滑出命中区也继续跟随，不必在 window 上挂监听 */
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;

      const hit = event.currentTarget;
      /* 可移距离要量**轨道自己**的宽（= 舞台宽 − 两端让位）：横向的命中区是轨根，
         它的宽度是停靠条的宽度，而时间线比停靠条更长（见 ProgressRail 的 --rail-min-span）。
         纵向的命中区就是轨道，量任一元素结果相同。 */
      const measured = orientation === 'horizontal' ? trackRef.current : null;
      const box = (measured ?? hit).getBoundingClientRect();

      /* 按下落在刻度标签上时**不能**立刻捕获：指针捕获会把随后的 click 改派给捕获元素
         （实测 Chrome：click target = 捕获元素），标签自己的 onClick 就永远收不到了。
         先记成未捕获，等真的拖起来（越过 DRAG_SLOP）再补 —— 那时指针必然还在轨内。 */
      const onLabel = (event.target as HTMLElement).closest('button') !== null;
      const captured = !(orientation === 'horizontal' && onLabel);
      if (captured) hit.setPointerCapture(event.pointerId);

      const pos = axisPos(event, orientation);
      document.body.style.userSelect = 'none';
      dragRef.current = {
        pointer: pos,
        // 基准进度直接按容器几何量，不读 state：state 由滚动的下一帧写回，会比手指慢一两帧
        progress: progressOf(container.getBoundingClientRect()),
        rect: box,
        travel: Math.max(1, box.width),
        captured,
      };
      movedRef.current = false;
      setDragging(true);

      /* 只有纵向「按哪读哪」：轨不动，绝对映射本身就是实话。
         横向不在这儿跳 —— 时间线跟着手走，按下即跳会让内容在手指下窜一下。 */
      if (orientation === 'vertical') jumpTo(ratioAt(pos, box, orientation));
    },
    [containerRef, jumpTo, orientation],
  );

  /** 收尾：松开指针捕获、恢复页面选中、清掉拖拽态 */
  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const hit = event.currentTarget;
    if (hit.hasPointerCapture(event.pointerId)) hit.releasePointerCapture(event.pointerId);
    document.body.style.userSelect = '';
    dragRef.current = null;
    setDragging(false);
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;

      /* 鼠标在窗口外松开时收不到 pointerup：用「按键已抬起」自愈，
         否则接下来的悬停移动会一直带着时间线跑（触屏有隐式指针捕获，不受影响）。 */
      if (event.buttons === 0) {
        endDrag(event);
        return;
      }

      const pos = axisPos(event, orientation);
      if (!movedRef.current && Math.abs(pos - drag.pointer) > DRAG_SLOP) movedRef.current = true;
      /* 延迟捕获：真的拖起来就立刻补上捕获，此后指针滑到哪儿都继续跟手 */
      if (!drag.captured && movedRef.current) {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.captured = true;
      }

      /* 横向走相对增量：时间线跟着手走 —— 手往右（+dx）= 时间线右移 = 露出较早的一段 = 进度减小。
         分母是轨道宽（见 DragAnchor.travel），因此指针走满一轨正好是进度 0 → 1。 */
      if (orientation === 'horizontal') {
        jumpTo(drag.progress - (pos - drag.pointer) / drag.travel);
        return;
      }
      jumpTo(ratioAt(pos, drag.rect, orientation));
    },
    [endDrag, jumpTo, orientation],
  );

  /* 拖动末尾浏览器会补一次 click：它已被改派给命中区，若按下的位置是刻度标签，
     那一次 click 就会在松手后补一次跳转、盖掉刚拖出来的进度 —— 于是吞掉它。
     没拖动过（按下就松）时放行：标签自己的点击跳转必须照常工作。
     放在捕获阶段：标签的 onClick 在冒泡阶段，这里拦得住。 */
  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!movedRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = stepOf(event.key, orientation);
      if (!step) return;
      event.preventDefault();
      jumpTo(progress + step);
    },
    [jumpTo, progress, orientation],
  );

  const labelText = label?.text ?? null;

  return {
    containerRef,
    trackRef,
    progress,
    labelText,
    label,
    dragging,
    jumpTo,
    hitProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onClickCapture,
      onKeyDown,
    },
    sliderProps: {
      role: 'slider',
      tabIndex: 0,
      'aria-label': ariaLabel,
      'aria-orientation': orientation,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': Math.round(progress * 100),
      // 读数同时供可见标签与读屏使用，来源同一份，不会产生分歧
      'aria-valuetext': labelText ?? undefined,
    },
  };
}