/**
 * apps/web/src/components/Viewer.tsx
 *
 * 全屏查看器（模态面，§6.3 渐进显图 + §7.1 模态层）。
 *
 * 【动画方案：确定性 FLIP，不用 layoutId】
 * 放大动画的两端矩形都由 JS 直接算出来：
 *   起点 = 被点那张照片在网格里的视口矩形（PhotoTile 交给上层传进来）
 *   终点 = 把「照片纵横比的盒子」装进查看器安全区后的矩形（fitRect）
 * 于是 frame 只是在这两个矩形之间补间 left/top/width/height，进出场完全对称。
 *
 * 为什么不用 Motion 的 layoutId 共享元素：它与 AnimatePresence 组合时，
 * 退场要等布局投影结算完才允许移除节点；节点残留期间再打开，
 * 新节点会继承「正在退场」的节点 presence 状态而跳过 enter 动画
 * （实测表现为背板透明度卡在 0、整层不可见）。自己算矩形没有这类时序耦合。
 *
 * 【状态归属】当前下标由父级 GalleryScreen 持有，本组件只上报「翻页方向」与「跳到第几张」。
 * 关闭是两段式：先播退场动画，播完才回调 onClose —— 这样退出动画不会被卸载打断。
 *
 * 【画框外的两件东西】
 *   - EXIF 卡片：挂在画框右缘（窄屏下缘）之外，高度取画框高 —— 照片多高卡片就多高。
 *     它的裁切窗**紧贴画框**，卡片自己藏在窗里（位移 −100%）；就位时窗退开一格、
 *     卡片滑到位，于是「从照片右缘长出来、再缓缓离开／反向贴回去」全程都在窗内完成。
 *     卡片右下角常驻「加载原片 / 下载 / 标记喜爱」三个操作；
 *   - 胶片条：只摆 20 张的滑动窗口，滚轮可翻页，选中那张在整体尺寸上再放大 1.5 倍。
 *
 * 【原页头 viewer__top 已按需求移除】关闭按钮单独挂在右上角，实况播放按钮移到照片右下角。
 *
 * 【照片吃满屏幕】画框的落点由 fitRect 按**整个视口**算，只扣两处：
 *   宽屏在右侧扣掉「间隙 + EXIF 卡片宽」，底部扣掉胶片条占的那一带。
 *   顶边贴视口上缘、左右铺满 —— 关闭按钮 / 翻页箭头 / EXIF 卡片都是浮在照片之上的浮层。
 *   容器 .viewer 也铺满视口，但它只是背板与「点空白处关闭」的命中区，不参与照片度量。
 *
 * 【放大：单击定住、按住看细节、按住再拖即平移】三种手势共用一份 pan 状态 ——
 *   单击一次       → 以点击位置为中心放大到 2× 并**定住**（zoomLocked），再单击复原；
 *   按住不放       → 同样是 2×，但松开即复原（「按住看细节」的临时态）；
 *   按住后拖动     → 在按下那一刻的位移之上平移（4px 阈值滤掉手抖）；
 *                    未锁定时松手复原，已锁定时停在拖到的位置。
 *   三条路靠两把尺子分叉：移动距离（DRAG_SLOP）区分拖动与原地按，
 *   按住时长（HOLD_MS）区分「快速单击」与「按住看细节」—— 于是各套手势互不干扰。
 *   按下瞬间就推到 2×，所以无论最终走哪条路，画面都不会有一下跳变。
 * 变换写在 img 上而不是外层容器上：容器的布局盒因此保持不变，
 * getBoundingClientRect() 始终是未缩放的框，位移换算与边界夹取才有稳定的参照。
 *
 * 【窄屏的 EXIF 是一层抽屉】宽屏卡片挂在画框右缘；窄屏没有多余的横向空间，
 * 于是收成一枚信息按钮 + 从屏幕底部升起的抽屉（见 app.css 的 .viewer__exifclip 窄屏段）。
 * 卡片本体只写一份 —— 宽屏与窄屏共用同一个元素（exifCard），只换挂载点与位移方向。
 *
 * 【退场时哪些元素在动】画框飞回网格 + 背板淡出 + 关闭按钮/箭头/胶片条一起淡出。
 * 后三样此前是「照片缩完、节点被卸载时才一起消失」，读起来像闪一下；
 * 现在它们跟着 leaving 走同一条淡出，与画框的飞行同时发生。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { tokens } from '@shaping-memory/design-tokens';
import { themeExifHeight, themeExifWidth, themeSpace } from '@shaping-memory/sdk';
import { EXIF_SCOPE_CLASS, exifRows, formatDate, photoAspect, placeholderColors } from '@shaping-memory/core';
import type { Photo } from '@shaping-memory/core';

import { Icon } from './Icon';
import { IconButton } from './controls';
import { EditDialog } from './EditDialog';
import { PhotoMiniMap } from './PhotoMiniMap';
import { UnlockDialog } from './UnlockDialog';
import { useViewport } from '../hooks/useViewport';
import { fade, springs } from '../lib/motion';
import { cachedOriginal, isOriginalCacheable, loadOriginal } from '../lib/original-cache';

/**
 * 照片可用区的留白基准（必须与 app.css 里 .viewer__stripbox 的留白一致）
 * —— 与 useProgressRail 的 TL_LINE 是同一类约定：CSS 量在 JS 里只留这一份镜像。
 *
 * 【照片吃满整块屏幕，只给胶片条让位】可用区 = 整个视口：顶边贴视口上缘、左右铺满
 * （宽屏再扣掉右侧 EXIF 卡片与间隙），底边停在胶片条上缘。
 * 关闭按钮、翻页箭头、EXIF 卡片都是浮在照片之上的浮层，照片因此不再有自己的留白；
 * 唯一必须让位的是固定在屏幕最底部的胶片条（见 currentGeom().safeBottom 与 fitRect）。
 *
 * 【为什么要现算而不是写成常量】后台可配置「字号倍率」，而字号一放大，卡片 /
 * 胶片条这些几何量必须同比例跟上，否则照片会被放大后的 EXIF 卡片或胶片条压住。
 * 因此这里只留**基准值**（来自 design-tokens），实际像素由 currentGeom() 在渲染时
 * 按当前倍率算出来 —— 与 app.css 里那些 calc(var(--theme-scale)) 是同一套口径。
 */
const S4 = Number.parseFloat(tokens.space.s4);
const S8 = Number.parseFloat(tokens.space.s8);
const S12 = Number.parseFloat(tokens.space.s12);
const S20 = Number.parseFloat(tokens.space.s20);
const S24 = Number.parseFloat(tokens.space.s24);
const S64 = Number.parseFloat(tokens.space.s64);

/** EXIF 卡片的挂载方向：宽屏挂在画框右缘、窄屏收成屏幕底部的抽屉（与 app.css `@media (max-width: 899px)` 同口径） */
const WIDE_MIN = 900;

/** 胶片条一次最多摆这么多张：以当前这张为中心取窗口，而不是把整卷铺开 */
const STRIP_SIZE = 20;
/** 滚轮翻页的节流：一次滚动操作会连发几十个 wheel 事件，不锁就会一滑跳过十几张 */
const WHEEL_LOCK_MS = 180;

/** 放大倍率：单击锁定与按住预览都放大到这个倍数，复原回到 1× */
const ZOOM_SCALE = 2;
/** 「按住」与「拖曳」的判定阈值（px）：位移不超过它就不算拖动，只当手抖 */
const DRAG_SLOP = 4;
/**
 * 「单击」与「按住」的判定阈值（ms）：一次「没拖动过的按下—抬起」究竟是哪一种，
 * 只能靠按住时长区分 —— 快速点一下是「单击」（把 2× 定住），
 * 停一会儿再松是「按住看细节」（松开即复原）。
 * 取 300ms：点击通常不到 150ms，而想看清细节自然会按得更久。
 */
const HOLD_MS = 300;

/** 查看器的几何量：随主题倍率现算，供 fitRect 与卡片动画共用同一份数 */
interface ViewerGeom {
  /** 底部让位带：胶片条距屏幕底 space-8 + 胶片条高 + 一格呼吸，照片因此绝不会压住胶片条 */
  safeBottom: number;
  /** EXIF 卡片宽 / 高（只随专区倍率，与 app.css 的 --exif-w / --exif-h 同源） */
  exifW: number;
  exifH: number;
  /** 卡片与照片之间那一格间隙；它只在 JS 里 —— 被 Motion 演出来（见 exifclip 的注释） */
  exifGap: number;
}

/** 按当前主题倍率算一份几何量（每次渲染现算：倍率变了，下一帧就对上） */
function currentGeom(): ViewerGeom {
  /* 一枚缩略图：space-64 + space-4，再整体缩小 1.5 倍（与 app.css 的 --strip-dot 同式） */
  const stripDot = (themeSpace(S64) + themeSpace(S4)) / 1.5;
  /** 胶片条高 = 一枚缩略图 + 上下内边距 space-20 × 2 */
  const stripH = stripDot + themeSpace(S20) * 2;
  return {
    /* 胶片条贴在屏幕最底部（距底 space-8），照片的下边界因此按「条高 + 一格呼吸」让位 */
    safeBottom: themeSpace(S8) + stripH + themeSpace(S24),
    exifW: themeExifWidth(),
    exifH: themeExifHeight(),
    exifGap: themeSpace(S12),
  };
}

/** 放大后的平移量（px，作用在未缩放的画框坐标系里） */
interface PanOffset {
  x: number;
  y: number;
}

/**
 * 把平移量夹在合法范围内：放大后的画面必须始终盖住画框。
 * 超出这个范围就会在画框里露出底色（照片被拖走了），因此这里按「放大后多出来的那圈」
 * 取上下限 —— 半宽 = 画框宽 × (倍率 − 1) / 2。
 */
function clampPan(offset: PanOffset, box: { width: number; height: number }): PanOffset {
  const maxX = (box.width * (ZOOM_SCALE - 1)) / 2;
  const maxY = (box.height * (ZOOM_SCALE - 1)) / 2;
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

/** 画框矩形（视口坐标） */
interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Motion 的 animate 目标要求可索引（它按属性名取关键帧），这里显式声明以便直接传矩形 */
  [axis: string]: number;
}

/** 把「按纵横比撑开的盒子」装进照片可用区并居中：这就是放大后的落点。
 *  可用区 = 整块屏幕（照片要尽可能大），只扣两处：
 *   - 宽屏在**右侧**扣掉「间隙 + EXIF 卡片宽」；窄屏的 EXIF 是浮在照片之上、
 *     从屏幕底部升起的抽屉，不参与占位，照片因此能吃满横向空间；
 *   - 底部扣掉胶片条占的那一带（胶片条固定在屏幕最底部，照片不能压住它）。
 *  盒子按原始纵横比缩放（等价于 contain），所以照片只会整体变大变小，绝不会被拉歪。 */
function fitRect(aspect: number, viewport: { width: number; height: number }, geom: ViewerGeom): FrameRect {
  const wide = viewport.width >= WIDE_MIN;
  const reserveW = wide ? geom.exifGap + geom.exifW : 0;
  const availW = Math.max(1, viewport.width - reserveW);
  /* 底边 = 胶片条上缘（条高 + 距底那一格 + 一格呼吸）；顶边就是视口上缘，不再另留页头带 */
  const availH = Math.max(1, viewport.height - geom.safeBottom);
  /* 先按「铺满宽」试算，太高就改成「铺满高」—— 取能装下的最大那一档，且等比缩放 */
  let width = availW;
  let height = width / aspect;
  if (height > availH) {
    height = availH;
    width = height * aspect;
  }
  return {
    left: (availW - width) / 2,
    top: (availH - height) / 2,
    width,
    height,
  };
}

const toFrameRect = (rect: DOMRect): FrameRect => ({
  left: rect.left,
  top: rect.top,
  width: rect.width,
  height: rect.height,
});

interface ViewerProps {
  list: readonly Photo[];
  index: number;
  /** 打开时被点照片的网格矩形：放大动画的起点 */
  origin: DOMRect;
  /** 只上报方向（-1 上一张 / +1 下一张），循环与边界由父级处理 */
  onStep: (delta: number) => void;
  /** 直接跳到第 n 张：底部缩略图条用 */
  onSeek: (index: number) => void;
  /** 退场动画播完后才被调用 —— 父级此时才真正卸载本组件 */
  onClose: () => void;
  /** 是否具备前台编辑能力（admin）：显示「编辑」入口 */
  admin: boolean;
  /** 分类候选（编辑对话框的分类下拉用） */
  categories: readonly string[];
  /** 编辑保存成功后回调（触发重拉列表） */
  onPhotosChanged: () => void;
  liked: ReadonlySet<string>;
  onToggleLike: (id: string) => void;
}

export function Viewer({ list, index, origin, onStep, onSeek, onClose, admin, categories, onPhotosChanged, liked, onToggleLike }: ViewerProps) {
  const photo = list[index];
  const viewport = useViewport();
  /* 几何量随主题倍率现算：倍率改了（刷新页面后）这里的留白与卡片尺寸立刻跟上，
     与 app.css 的 --theme-scale 口径一致 */
  const geom = currentGeom();
  const stripRef = useRef<HTMLDivElement>(null);
  /**
   * 已加载完成的**图片地址**（而不是「是否加载完成」的布尔量）。
   * 【为什么要按地址记】换页时布尔量必须重置，而重置与 load 事件的先后顺序是不确定的：
   * 命中浏览器缓存的图往往在 effect 跑之前就把 load 事件发完了，重置因此把
   * 「已经加载好」误写成「还没加载」，之后再没有第二个 load 事件来纠正它 ——
   * 画面就永远停在底片色块 + 转圈上（滚轮在胶片条上快速翻页时最容易撞见）。
   * 换成地址判等后，迟到的重置不再有杀伤力：地址对上就是加载好了。
   */
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  /** 画框当前落点：初值就是网格原位，挂载后下一帧才切到安全区中心 */
  const [rect, setRect] = useState<FrameRect>(() => toFrameRect(origin));
  /** 已就位：与画框在同一次 rAF 里翻起，作为 EXIF 卡片滑出的起跑信号 */
  const [settled, setSettled] = useState(false);
  /** 退场中：先播动画，播完再回调 onClose */
  const [leaving, setLeaving] = useState(false);
  /**
   * 实况播放中：默认关着 —— 实况是「主动唤起」的内容，
   * 打开查看器即自动播放会使用户分不清所看的是照片还是视频。
   */
  const [liveOn, setLiveOn] = useState(false);
  /**
   * 放大态：null = 1×；有值 = 2×，值就是平移量（px）。
   * 两套手势共用这一份状态（见下面三个指针处理函数）：
   *   按住（未锁定）→ 以指针位置为中心推到 2×，松开即复原，这是「按住看细节」的临时态；
   *   单击          → 把 2× 定住 / 再单击解除（见 zoomLocked）；
   *   按住再拖      → 在本次按下的位移之上平移。
   * 实况播放中不响应放大：动态画面放大会让运动模糊更明显，意义不大。
   */
  const [pan, setPan] = useState<PanOffset | null>(null);
  /**
   * 放大是否被「单击」锁定：
   *   false = 放大只在按住期间存在（松开即复原）；
   *   true  = 单击一次把 2× 定住，此时按住拖动只是平移、松手不回缩，再单击才回到 1×。
   * 它就是「单击放大 / 再单击复原」与「按住放大 / 松手复原」两套手势的区分开关。
   */
  const [zoomLocked, setZoomLocked] = useState(false);
  /** 拖曳中（按下左键且已开始拖）：只用来切 cursor 与关掉 transform 的补间 */
  const [dragging, setDragging] = useState(false);
  /**
   * 本次按下的拖曳会话：按下时的指针坐标 + 按下那一刻的平移量 + 按下时是否已锁定。
   * 用 ref 而不是 state —— 它每一帧都变，进 state 会让整棵子树跟着重渲染；
   * 真正需要重渲染的只有 pan（被 transform 读走）与 dragging（被 cursor 读走）。
   * wasLocked 也记在会话里（而不是松开时去读 state）：松开时该「定住」还是「复原」，
   * 取决于按下那一刻的状态，不能被这期间的状态更新带跑。
   */
  const dragRef = useRef<{
    pointerId: number;
    fromX: number;
    fromY: number;
    base: PanOffset;
    moved: boolean;
    wasLocked: boolean;
    /** 按下的时间戳：抬起时用它判「单击」（快）还是「按住」（慢） */
    startedAt: number;
  } | null>(null);
  /**
   * 窄屏的 EXIF 抽屉是否展开。宽屏用不到它（卡片常驻画框右缘）；
   * 窄屏默认收起 —— 手机上一屏就那么高，卡片摊开会把照片挤成一条。
   */
  const [exifOpen, setExifOpen] = useState(false);
  /** 解锁面板是否展开（隐私照片点「输入密码解锁」时打开） */
  const [unlockOpen, setUnlockOpen] = useState(false);
  /** 编辑对话框是否展开（仅 admin） */
  const [editOpen, setEditOpen] = useState(false);
  /**
   * 已加载的原片地址：null = 画框里是详情档缩略图；有值 = 已换成原片。
   * 【为什么不落盘】这只是把画框里的 `<img>` 换一份字节，不触发任何保存；
   * 真正落盘是「下载」——它走同一个出口地址，只是处置方式是 attachment。
   * 与用户预期一致：看原片不应顺带把文件写入下载目录。
   */
  const [originalSrc, setOriginalSrc] = useState<string | null>(null);
  /** 原片正在下载（十几 MB，慢网下需要状态提示） */
  const [originalBusy, setOriginalBusy] = useState(false);
  /** 原片下载失败的原因；成功或收起原片时清掉 */
  const [originalError, setOriginalError] = useState<string | null>(null);
  /**
   * 打开时的起点矩形。除了「从地图点位进来」这一路，它平时用不上
   * —— 但那一路上网格里没有对应的格子，退场只能飞回这里（见 requestClose）。
   */
  const originRef = useRef(origin);
  const photoId = photo?.id ?? null;
  const isLiked = photo ? liked.has(photo.id) : false;
  /**
   * 这张是否被隐私策略锁住：锁住时后端给的是**服务端生成的模糊图**，
   * 原图地址与实况地址一律不下发（见 PhotosService.toApi），
   * 因此这里再怎么点都不可能有清晰图 —— 界面只需把「解锁」这条路指出来。
   */
  const locked = photo?.privacy?.locked ?? false;
  const [ratioW, ratioH] = photo ? photoAspect(photo) : [1, 1];
  /**
   * 画框当前该画哪一份字节：默认详情档缩略图；点过「加载原片」后换成原片
   * （`originalPreviewUrl` —— 带库里最新 EXIF 的那份，与「下载」同一份字节）。
   * 列表被筛空时可能一张都没有，读成 null 即不会抛异常。
   */
  const currentSrc = (originalSrc ?? photo?.url) ?? null;
  /** 当前这张是否已经画出来：地址对上即算数 */
  const loaded = currentSrc !== null && loadedSrc === currentSrc;
  /** 画框里现在是原片（而不是缩略图）：按钮据此显示「加载原片 / 显示缩略图」 */
  const originalLoaded = originalSrc !== null;
  /** 命中缓存时图片可能在 React 挂上 onLoad 之前就已经 complete，那一趟 load 事件就丢了 ——
      挂载回调里补一次检查，把这种「已静默完成」的图也纳入判断。 */
  const catchCached = useCallback(
    (node: HTMLImageElement | null) => {
      if (currentSrc && node?.complete && node.naturalWidth > 0) setLoadedSrc(currentSrc);
    },
    [currentSrc],
  );
  const target = fitRect(ratioW / ratioH, viewport, geom);
  const wide = viewport.width >= WIDE_MIN;
  /** 卡片这一帧该不该露出来：就位后才向右滑出，退场时先原路收回照片背后 */
  const cardShown = settled && !leaving;

  /* 进出场都用「状态变化」驱动，不用挂载期的 initial→animate。
     原因：Motion 在开发期的 StrictMode 双挂载下会丢掉那次挂载动画
     （实测：挂载后画框停在网格原位不动、背板恒为 0，要等下一次重渲染才补上）。
     显式改状态则两种模式下都是确定的一次补间。 */
  useEffect(() => {
    if (leaving) return;
    const frame = requestAnimationFrame(() => {
      setRect(target);
      setSettled(true);
    });
    return () => cancelAnimationFrame(frame);
    // 目标矩形的四项都是数值，逐个入依赖即可（对象每次渲染都是新的，不能直接依赖）
  }, [leaving, target.left, target.top, target.width, target.height]);

  /* 关闭请求：先把「当前这张」在网格里的矩形量出来作为落点。
     翻页后再关闭时，落点会自动跟着当前照片走，不需要父级补数据。
     量不到就退回**打开时的那个起点**（origin）—— 从地图点位进来时网格里没有它的
     格子，此时若直接 onClose 就是一次硬切；飞回起点至少还是一次连贯的退场。 */
  const requestClose = useCallback(() => {
    if (!photo) return;
    const tile = document.querySelector(`[data-photo="${photo.id}"] .progressive`);
    const fallback = originRef.current;
    /* 两端都无法获取可补间的矩形时只能直接关：没有可补间的两端，
       等 onAnimationComplete 会一直等不到，查看器就卡住了 */
    if (!tile && fallback.width < 1) {
      onClose();
      return;
    }
    setLeaving(true);
    // 回退值是 DOMRect，落点要的是 FrameRect（Motion 按属性名取关键帧，见 toFrameRect）
    setRect(tile ? toFrameRect(tile.getBoundingClientRect()) : toFrameRect(fallback));
  }, [onClose, photo]);

  /** 按下左键：立刻以指针位置为中心推到 2×，同时开一次拖曳会话。
   *  松开时的走向由「有没有拖过」与「按下时是否已锁定」共同决定（见 endZoomDrag）。 */
  const onZoomPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // 拦住冒泡：否则外层 div 的 onClick=requestClose 会连带把查看器关闭
      event.stopPropagation();
      if (liveOn || event.button !== 0) return;
      /* 【矩形必须在 setState 之前取】React 会在事件处理函数返回后把 event.currentTarget 置空，
         而 setState 的更新函数是稍后才被调用的 —— 把 getBoundingClientRect() 写进更新函数里
         会读到 null 并抛错，整个查看器随之崩溃（实测整站白屏）。 */
      const box = event.currentTarget.getBoundingClientRect();
      // 放大中心 = 指针在画框里的位置。中心缩放要把该点推到画面中央，位移取其到中心的距离 × 倍率
      const pressed = clampPan(
        {
          x: -ZOOM_SCALE * (event.clientX - box.left - box.width / 2),
          y: -ZOOM_SCALE * (event.clientY - box.top - box.height / 2),
        },
        box,
      );
      /* 已锁定：按下不改动画面（保持用户自己平移到的位置），这一下只是「准备平移」；
         未锁定：按下本身就是「按住放大」，立刻以指针位置为中心推上去。 */
      const base = zoomLocked && pan ? pan : pressed;
      if (!zoomLocked) setPan(pressed);
      // 指针捕获：手指/鼠标滑出画框后仍继续跟随，不必在 window 上挂监听
      event.currentTarget.setPointerCapture(event.pointerId);
      /* base 记的是「按下那一刻的位移」：之后拖动是在它之上叠加指针位移，
         而不是从零起算 —— 否则按下的瞬间画面会先跳回中心再跟着指针走。 */
      dragRef.current = {
        pointerId: event.pointerId,
        fromX: event.clientX,
        fromY: event.clientY,
        base,
        moved: false,
        wasLocked: zoomLocked,
        startedAt: event.timeStamp,
      };
    },
    [liveOn, zoomLocked, pan],
  );

  /** 拖曳中：平移量 = 按下时的位移 + 指针位移。位移未超过阈值时不算「拖过」，只当手抖 */
  const onZoomPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.fromX;
    const dy = event.clientY - drag.fromY;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      drag.moved = true;
      setDragging(true);
    }
    setPan(clampPan({ x: drag.base.x + dx, y: drag.base.y + dy }, event.currentTarget.getBoundingClientRect()));
  }, []);

  /** 松开左键：一次操作最终落在哪种状态，由两把尺子共同决定 ——
   *   「有没有拖过」分「拖动 / 原地按」，「按了多久」分「单击 / 按住」：
   *     原地快按（单击）  未锁定 → 把刚推上去的 2× **定住**（单击放大）；
   *                      已锁定 → 缩回 1×（再单击复原）；
   *     原地慢按（按住）  未锁定 → 缩回 1×（按住看细节，松手即复原）；
   *                      已锁定 → 保持原状（看细节时不打扰既有画面）；
   *     拖过了（平移）    未锁定 → 缩回 1×（松开即复原）；
   *                      已锁定 → 停在拖到的位置，继续保持放大。
   *  两条轴各自独立，所以「单击放大 / 再单击复原」与「按住放大 / 松手复原」
   *  各占一把尺子，不会互相顶掉。 */
  const endZoomDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const box = event.currentTarget;
    if (box.hasPointerCapture(event.pointerId)) box.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
    /* 没拖过 = 原地按：此时「单击」与「按住」只能靠按了多久来分。
       startedAt 用的是事件时间戳（同一个 timeStamp 坐标系），拿当前时间对它做差即可。 */
    if (!drag.moved) {
      const isClick = event.timeStamp - drag.startedAt < HOLD_MS;
      if (isClick) {
        // 单击：切换锁定（未锁定 → 定住，已锁定 → 复原）
        setZoomLocked(!drag.wasLocked);
        setPan(drag.wasLocked ? null : drag.base);
      } else if (!drag.wasLocked) {
        // 按住看细节（未锁定时）：松手即复原；已锁定时不打扰画面
        setPan(null);
      }
      return;
    }
    if (!drag.wasLocked) setPan(null);
  }, []);

  /* 键盘：Esc 优先收编辑对话框 → 收窄屏的 EXIF 抽屉 → 退出放大 → 关闭查看器；左右翻页。
     【为什么编辑对话框要抢在 requestClose 前面】编辑对话框浮在查看器之上，
     此时用户眼里的「当前层」是对话框。若不拦截，一次 Esc 会把对话框连同查看器
     一起关掉 —— 草稿丢了、在网格里的位置也没了。后台用的是 AntD Drawer（Esc 只关抽屉），
     这里对齐同一套语义：Esc 只收最上面那一层。 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (editOpen) setEditOpen(false);
        else if (exifOpen) setExifOpen(false);
        /* 退出放大：连同「单击锁定」一起解除 —— 否则画面缩回去了、锁定态却还留着，
           下一次按下会莫名其妙地不放大（或一点就定住）。 */
        else if (pan) {
          setPan(null);
          setZoomLocked(false);
        } else requestClose();
      } else if (event.key === 'ArrowLeft') onStep(-1);
      else if (event.key === 'ArrowRight') onStep(1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onStep, requestClose, pan, editOpen, exifOpen]);

  /* 打开期间锁住页面滚动：不摘滚动条（摘掉会让视口变宽约 15px，
     fixed 页头与 sticky 左轨会跟着重排，就是「一直闪」的根源），
     改为拦掉滚动的输入源 —— 滚轮、触摸拖动，以及会翻页的按键。
     查看器自己的胶片条、EXIF 卡片，以及编辑对话框的正文区仍需可滚，所以命中这些滚动容器时放行。 */
  useEffect(() => {
    const scrollKeys = new Set([' ', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
    /** 事件落在查看器自己的哪个滚动容器里；都不在则返回 null（= 落在背景页上）。
        【编辑对话框的正文区也要算进来】它浮在查看器之上，那一段是独立滚动容器 ——
        漏掉它会让弹层里的滚轮、触摸拖动以及空格 / 翻页键全部被拦掉，连正文里敲空格都失灵。
        只认「滚动容器」本身、不按整层放行：弹层的页头 / 页脚在滚动容器之外，
        放行它们只会把滚动量交给背景页（实测会让后面的网格跟着滚），宁可不动。 */
    const scrollerOf = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element
        ? target.closest<HTMLElement>('.viewer__stripbox, .viewer__exif, .edit-dialog__body')
        : null;
    /* 【为什么命中滚动容器还要再判一次边界】只看「在不在容器里」是不够的：
       容器滚到顶/底之后，剩余滚动量会沿着祖先链继续传给背景页 —— 这就是滚动穿透。
       overscroll-behavior: contain（见 app.css）能挡住大部分情况，
       但容器本身不可滚时那条规则不生效，因此这里按方向补一道闸。 */
    const eatsWheel = (target: EventTarget | null, deltaY: number): boolean => {
      const box = scrollerOf(target);
      if (!box) return true;
      const canScroll = box.scrollHeight - box.clientHeight > 1;
      if (!canScroll) return true;
      const atTop = box.scrollTop <= 0;
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 1;
      return (deltaY < 0 && atTop) || (deltaY > 0 && atBottom);
    };
    const onWheel = (event: WheelEvent) => {
      if (eatsWheel(event.target, event.deltaY)) event.preventDefault();
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!scrollerOf(event.target)) event.preventDefault();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (scrollKeys.has(event.key) && !scrollerOf(event.target)) event.preventDefault();
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  /* 打开期间让滚动条「隐形」：只改滑块颜色，不动 overflow、也不摘滚动条
     —— 两者都会让视口宽度变化（实测 15px）并让页头与左轨重排，
     而重排是发生在半透明背板底下的，看起来就是「一开一关，背后闪一下」。 */
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('is-viewer-open');
    return () => root.classList.remove('is-viewer-open');
  }, []);

  /* 胶片条上的滚轮 = 翻页，不是滚动：一次滚动操作会连发几十个 wheel 事件，
     因此加一道时间锁，一次手势只走一张。横向滚动（deltaY 为 0）照旧放给浏览器，
     触控板横向滑仍用来浏览缩略图本身。 */
  useEffect(() => {
    const box = stripRef.current;
    if (!box) return;
    let last = 0;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      // 拦住冒泡：外层那条全局滚轮锁也挂在 window 上，否则一次事件被处理两遍
      event.stopPropagation();
      const now = performance.now();
      if (now - last < WHEEL_LOCK_MS) return;
      last = now;
      onStep(event.deltaY > 0 ? 1 : -1);
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [onStep]);

  /* 换页时把实况收起来：翻到下一张却还在放上一张的视频，是最容易破坏观感连贯性的一处。
     解锁面板同理 —— 翻到下一张却还停着上一张的密码框，会使用户误判为输错了目标。
     放大态也要复位（连同「单击锁定」）：上一张的放大位置对下一张没有意义，
     锁定态更不能留着 —— 否则新照片一打开就是 2×，还怎么点都不缩回去。
     「已加载原片」同样要复位：下一张还没看，默认仍该是省流量的缩略图。
     窄屏的 EXIF 抽屉也一起收起：它浮在照片之上，翻页后还摊着会挡住新照片。 */
  useEffect(() => {
    setLiveOn(false);
    setUnlockOpen(false);
    setPan(null);
    setZoomLocked(false);
    setDragging(false);
    setOriginalSrc(null);
    setOriginalError(null);
    setOriginalBusy(false);
    setExifOpen(false);
    dragRef.current = null;
  }, [photoId]);

  /* 换页不需要「重置加载态」了：loaded 由地址判等得出，新地址天然不等于旧地址 */

  /* 胶片条只摆 STRIP_SIZE 张：以当前这张为中心向前后各取一半，形成一条**滑动窗口**
     （而不是把整卷铺开）。走到列表两端时窗口被夹在边上，
     夹取后当前这张一定还在窗口里 —— 这也是下面按 index − start 取元素的前提。 */
  const stripStart = Math.max(0, Math.min(index - Math.floor(STRIP_SIZE / 2), list.length - STRIP_SIZE));
  const stripItems = list.slice(stripStart, stripStart + STRIP_SIZE);

  /* 跳转后把当前缩略图带进视野中央：用容器自身的 scrollTo，
     而不是 scrollIntoView —— 后者会连带把整页也滚一下。 */
  useEffect(() => {
    const box = stripRef.current;
    const dot = box?.children[index - stripStart] as HTMLElement | undefined;
    if (!box || !dot) return;
    box.scrollTo({ left: dot.offsetLeft - box.clientWidth / 2 + dot.offsetWidth / 2, behavior: 'smooth' });
  }, [index, stripStart]);

  /** 模态内的点击都不该冒泡到最外层（外层的点击 = 关闭） */
  const stop = useCallback((event: React.MouseEvent) => event.stopPropagation(), []);

  // 列表在查看期间被筛掉（例如空分类）时的回退处理，避免读到 undefined
  if (!photo) return null;

  const colors = placeholderColors(photo);
  /**
   * 原片就地预览地址；锁定 / 无原片 / 浏览器无法渲染的格式时为空（按钮据此自然不出现）。
   * 【为什么按格式挡一道】缩略图一律是 JPEG，原片却可能是 HEIC、DNG、RAW ——
   * 这些格式 `<img>` 多半渲染不出来，点了只会得到一个碎图标，不如直接不提供这个入口。
   * 下载不受此限：能不能显示与能不能存盘是两回事。
   */
  const previewSrc = photo.format === 'JPG' ? photo.originalPreviewUrl ?? null : null;

  /**
   * 切换「原片 / 缩略图」。
   * 【为什么要自行增加一层缓存】原片出口带 no-store，浏览器不会自动保留一份，
   * 于是每点一次都要重下十几 MB。首次点走网络并把字节接进内存缓存，
   * 之后同一张再点就直接换 src —— 缓存活到页面关闭 / 刷新为止（见 lib/original-cache）。
   * 翻页仍然回到缩略图（沿用原设计：下一张还没看，默认该省流量），
   * 但那时再点一下就是命中缓存，不再走网络。
   */
  const toggleOriginal = async () => {
    if (originalSrc) {
      setOriginalSrc(null);
      setOriginalError(null);
      return;
    }
    if (!previewSrc || originalBusy) return;
    const hit = cachedOriginal(photo.id);
    if (hit) {
      setOriginalSrc(hit);
      return;
    }
    setOriginalError(null);
    setOriginalBusy(true);
    try {
      setOriginalSrc(await loadOriginal(photo.id, previewSrc, isOriginalCacheable(photo)));
    } catch (err: unknown) {
      setOriginalError(err instanceof Error ? err.message : '原片加载失败，请稍后重试');
    } finally {
      setOriginalBusy(false);
    }
  };

  /**
   * 卡片本体的入场位移：宽屏从画框里侧滑出（x 由 -100% 到 0）；
   * 窄屏的抽屉由**外层挂载点**整体升起，卡片自己不再位移（否则两层各滑一次，像掉帧）。
   */
  const exifAnimate = wide
    ? { x: cardShown ? '0%' : '-100%', y: '0%' }
    : { x: '0%', y: '0%' };

  /**
   * EXIF 卡片本体。宽屏挂在画框右缘的裁切窗里、窄屏作屏幕底部的抽屉 ——
   * 两处内容必须逐字一致，所以只写这一份，差别全在「挂载位置与动画对象」。
   * 抽屉形态多一枚「收起」按钮（手机上没有 Esc 键）。
   */
  const exifCard = (
    <motion.aside
      className={`viewer__exif ${EXIF_SCOPE_CLASS}`}
      aria-label="拍摄信息"
      initial={false}
      animate={exifAnimate}
      transition={springs.smooth}
    >
      <header className="viewer__exifhead">
        <h2 className="viewer__exiftitle">{photo.title}</h2>
        {/* 窄屏抽屉：右上角的收起按钮。定位由 CSS 负责（.viewer__exifclose） */}
        {wide ? null : (
          <span className="viewer__exifclose">
            <IconButton name="arrowDown" label="收起拍摄信息" onClick={() => setExifOpen(false)} />
          </span>
        )}
        <p className="viewer__exifmeta">
          {photo.cat} · {formatDate(photo.date)}
        </p>
        <p className="viewer__exifmeta">{photo.place}</p>
      </header>

      {/* 照片描述：手写正文，紧跟标题摘要、排在拍摄信息表之前。
          换行与空行靠 pre-wrap 原样呈现（录入侧就是多行纯文本）；
          卡片自身可滚动（.viewer__exif 的 overflow-y: auto），长文滚自己、不挤照片。 */}
      {photo.description.trim() ? (
        <p className="viewer__exifdesc">{photo.description}</p>
      ) : null}

      {/* 拍摄位置：与地图画廊同一套点位语汇的一枚小地图。
          没有 GPS 的照片（以及被隐私策略抹掉坐标的那种）不出现这一块 ——
          空地图比没有地图更容易造成困惑。 */}
      {photo.gps ? <PhotoMiniMap gps={photo.gps} title={photo.title} /> : null}

      {exifRows(photo).map(([key, value]) => (
        <div className="exif-row" key={key}>
          <span className="exif-row__k">{key}</span>
          <span className="exif-row__v">{value}</span>
        </div>
      ))}

      {/* 卡片右下角的操作区：原页头里的下载与点赞迁到这里。
          sticky bottom 让它常驻卡片右下角 —— 表格很长时不用滚到底才能点到。
          宽度屏右对齐、窄屏抽屉同样是底缘，因此 justify-content 统一 flex-end。 */}
      <footer className="viewer__exifactions">
        {/* 前台编辑入口（仅 admin）：打开单张编辑对话框（元数据 + EXIF） */}
        {admin ? (
          <IconButton name="edit" label="编辑照片" active={editOpen} onClick={() => setEditOpen(true)} />
        ) : null}
        {/* 加载原片：只把画框里的 `<img>` 换成原片（带库里最新 EXIF 的同一份字节），
            不落盘；再点一次回到缩略图。首次点会下十几 MB，之后走内存缓存（见 lib/original-cache）。
            锁住时后端不下发原片地址，按钮因此自然不出现。 */}
        {previewSrc ? (
          <>
            <IconButton
              name="eye"
              label={originalLoaded ? '显示缩略图' : '加载原片'}
              active={originalLoaded || originalBusy}
              onClick={() => void toggleOriginal()}
            />
            {/* 下载中的状态提示与失败原因：慢网下缺少反馈会使用户误判为未点击 */}
            {originalBusy ? <span className="viewer__origstate">原片加载中…</span> : null}
            {originalError ? <span className="viewer__origstate is-error">{originalError}</span> : null}
          </>
        ) : null}
        {/* 下载原片：同一份字节，但处置方式是 attachment —— 点击即落盘。
            不再 target=_blank：带 attachment 的响应会直接触发「另存为」，页面留在原地。
            锁住时不给这个入口：此时地址为空，点下去只会下到一张模糊图。 */}
        {locked ? null : (
          <a
            className="icon-btn"
            href={photo.downloadUrl ?? photo.originalUrl ?? photo.url}
            rel="noreferrer"
            aria-label="下载原片"
          >
            <Icon name="download" />
          </a>
        )}
        <IconButton
          name={isLiked ? 'heartFilled' : 'heart'}
          label={isLiked ? '取消喜爱' : '标记喜爱'}
          active={isLiked}
          onClick={() => onToggleLike(photo.id)}
        />
      </footer>
    </motion.aside>
  );

  return (
    <div
      className={`viewer${leaving ? ' is-leaving' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`${photo.title} 全屏预览`}
      /* 点照片以外的任何地方 → 反向动画缩回网格原位 */
      onClick={requestClose}
    >
      {/* 背板单独一层淡出：照片飞回网格的途中背板先退场，画面才连贯。
          initial={false}：挂载时直接取 animate 的值（不播动画），避免与下面 rAF 驱动的进入重复 */}
      <motion.span
        className="viewer__scrim"
        initial={false}
        animate={{ opacity: leaving ? 0 : 1 }}
        transition={fade()}
      />

      {/* 关闭按钮：原 viewer__top（顶部带渐变纱幕的页头条）已按需求移除，关闭按钮单独挂在右上角，
          仍随退场一起淡出。原页头里的其余按钮已分散：实况播放→画框右下角、下载/点赞→EXIF 卡片右下角。 */}
      <motion.div
        className="viewer__close"
        onClick={stop}
        initial={false}
        animate={{ opacity: leaving ? 0 : 1 }}
        transition={fade()}
      >
        <IconButton name="close" label="关闭查看器" onClick={requestClose} />
      </motion.div>

      {/* 窄屏专属：EXIF 抽屉的开关，挂左上角与右上角的关闭按钮对称。
          宽屏的卡片常驻画框右缘，不需要这个入口，因此只在窄屏渲染。 */}
      {wide ? null : (
        <motion.div
          className="viewer__exifbtn"
          onClick={stop}
          initial={false}
          animate={{ opacity: leaving ? 0 : 1 }}
          transition={fade()}
        >
          <IconButton
            name="info"
            label={exifOpen ? '收起拍摄信息' : '查看拍摄信息'}
            active={exifOpen}
            onClick={() => setExifOpen((on) => !on)}
          />
        </motion.div>
      )}

      {/* 画框：left/top/width/height 四项补间，两端矩形都是算出来的，进出场因此完全对称 */}
      <motion.div
        className="viewer__frame"
        initial={false}
        animate={rect}
        transition={springs.smooth}
        onAnimationComplete={() => {
          if (leaving) onClose();
        }}
      >
        {loaded ? null : (
          <span className="viewer__placeholder" style={{ backgroundImage: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})` }} />
        )}

        {/* 缩放层：自己带 overflow:hidden 把放大后的画面裁在画框内 —— 画框本身是 overflow:visible
            （宽屏时右侧的 EXIF 卡片挂在框外），不能直接给 img 加缩放，否则放大后画面会溢到框外。
            下面三个指针事件就是全部手势：单击定住 2×（再单击复原）、按住看细节（松手复原）、
            按住再拖即平移 —— 三条路怎么分叉见三个处理函数的注释。
            变换落在内部的 img 上（见下方 style），容器始终保持未缩放的布局盒。 */}
        <div
          className={`viewer__zoom${pan ? ' is-zoomed' : ''}${dragging ? ' is-dragging' : ''}`}
          /* 这一层是「放大 / 平移」的命中区，拖曳由自定义指针事件实现，
             必须关掉浏览器原生的图片拖拽 —— 否则按住拖的第一下会被浏览器先吃掉，
             变成拖照片幽灵而不是平移画面。 */
          draggable={false}
          onClick={stop}
          onPointerDown={onZoomPointerDown}
          onPointerMove={onZoomPointerMove}
          onPointerUp={endZoomDrag}
          onPointerCancel={endZoomDrag}
        >
          <img
            ref={catchCached}
            className={`viewer__img${loaded ? ' is-loaded' : ''}`}
            src={currentSrc ?? photo.url}
            alt={photo.title}
            decoding="async"
            draggable={false}
            onLoad={() => setLoadedSrc(currentSrc)}
            /* 拖曳中必须关掉补间，否则画面会「追」着指针走、明显滞后；
               放大 / 缩小的那一次切换则交给 CSS 里的 260ms 补间。
               translate 写在 scale 之前：位移因此以画框像素为单位，与指针位移 1:1 对应。 */
            style={
              pan
                ? {
                    transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${ZOOM_SCALE})`,
                    transition: dragging ? 'none' : undefined,
                  }
                : undefined
            }
          />
        </div>

        {/* 实况视频：点了播放按钮才挂上来（卸载即停播，不需要额外暂停逻辑），
            叠在照片之上但盖不住照片本身 —— 内嵌轨的比例与照片接近，contain 后正好铺满画框 */}
        {liveOn && photo.liveUrl ? (
          <video
            className="viewer__live"
            src={photo.liveUrl}
            autoPlay
            muted
            loop
            playsInline
            onClick={stop}
          />
        ) : null}
        {loaded ? null : <span className="viewer__spinner" aria-hidden="true" />}

        {/* 实况播放按钮：按需求移到照片右下角（原在页头）。只在这张确实有内嵌视频时出现。
            它是主动交互控件，必须自己拦冒泡，否则点它会触发缩放层的 toggleZoom。 */}
        {photo.isLive && photo.liveUrl && !locked ? (
          <div className="viewer__livebtn" onClick={stop}>
            <IconButton
              name={liveOn ? 'pause' : 'play'}
              label={liveOn ? '结束实况播放' : '播放实况'}
              active={liveOn}
              onClick={() => setLiveOn((on) => !on)}
            />
          </div>
        ) : null}

        {/* 锁面板：压在（服务端给的）模糊图之上，把「为什么看不清」明确说明，
            并给出唯一一条出路 —— 输入密码。锁着时这里不显示任何原图元素。 */}
        {locked ? (
          <div className="viewer__lock" onClick={stop}>
            <span className="viewer__lockicon">
              <Icon name="lock" />
            </span>
            <p className="viewer__locktext">这张照片已设为隐私，需要授权后查看</p>
            <button type="button" className="viewer__lockbtn" onClick={() => setUnlockOpen(true)}>
              输入密码解锁
            </button>
          </div>
        ) : null}

        {/* 宽屏：EXIF 卡片挂在画框右缘，两层同时在动 —— 合成的观感是「卡片从照片右缘长出来 / 贴回照片」：
            裁切窗从紧贴画框（0）退开到一格间隙（EXIF_GAP），卡片自己从 −100% 滑到 0。
            窗口始终贴着照片那一侧，因此中途露出的只是窗口里的一条，
            不会在照片旁边留下半截黑条、也不会飘到别的照片上去。
            窄屏不在这里 —— 卡片要收成屏幕底部的抽屉，挂载点必须在画框之外（见画框之后那段）。 */}
        {wide ? (
          <motion.div
            className="viewer__exifclip"
            onClick={stop}
            initial={false}
            animate={{ x: cardShown ? geom.exifGap : 0, y: 0 }}
            transition={springs.smooth}
          >
            {exifCard}
          </motion.div>
        ) : null}
      </motion.div>

      {/* 窄屏：EXIF 收成从屏幕底部升起的抽屉，默认收起、点左上角的信息按钮展开。
          挂载点必须在画框**之外**：画框带着 FLIP 位移，抽屉若挂在它里面会跟着照片一起跑。
          抽屉自己 fixed 到视口底部（与胶片条同一层），放在这个不含 transform 的容器下最稳。 */}
      {wide ? null : (
        <motion.div
          className="viewer__exifclip viewer__exifclip--drawer"
          onClick={stop}
          initial={false}
          animate={{ y: cardShown && exifOpen ? '0%' : '100%' }}
          transition={springs.smooth}
        >
          {exifCard}
        </motion.div>
      )}

      <motion.div
        className="viewer__arrows"
        onClick={stop}
        initial={false}
        animate={{ opacity: leaving ? 0 : 1 }}
        transition={fade()}
      >
        <IconButton name="arrowLeft" label="上一张" onClick={() => onStep(-1)} />
        <IconButton name="arrowRight" label="下一张" onClick={() => onStep(1)} />
      </motion.div>

      {/* 底部横向缩略图导航条：把「曝光滑杆」换成缩略图（参考 Motion 的 iOS slider 示例）。
          滚轮在这条上翻页（见上方 wheel 监听），横向滑仍用来浏览缩略图本身。 */}
      <motion.div
        className="viewer__strip"
        onClick={stop}
        initial={false}
        animate={{ opacity: leaving ? 0 : 1 }}
        transition={fade()}
      >
        <div className="viewer__stripbox" ref={stripRef} role="tablist" aria-label="照片导航">
          {stripItems.map((item, offset) => {
            const at = stripStart + offset;
            const isOn = at === index;
            return (
              <motion.button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={isOn}
                aria-label={item.title}
                className="viewer__dot"
                onClick={() => onSeek(at)}
                initial={false}
                /* 选中那张在整体尺寸的基础上再放大 1.5 倍（1.5 是相对本枚而言的额外倍数） */
                animate={{ scale: isOn ? 1.5 : 1, opacity: isOn ? 1 : 0.5 }}
                transition={springs.snappy}
              >
                {/* 用卡片档缩略图：体积小、加载快；选中的那张才需要较大图，其余不放大 */}
                <img src={item.cardUrl ?? item.url} alt="" loading="lazy" draggable={false} />
                {/* 选中标记是一圈 accent 淡洗底，带 layoutId —— 切换时它从上一枚飞到下一枚 */}
                {isOn ? <motion.span className="viewer__dotring" layoutId="viewer-dot-ring" transition={springs.snappy} /> : null}
              </motion.button>
            );
          })}
        </div>
      </motion.div>

      {/* 解锁面板：外层包一层「拦冒泡」—— 否则点对话框的背板会顺着 DOM 冒泡到查看器的
          点击即关闭，一次点击同时关掉两层（DOM 冒泡按树走，不按几何，所以空壳也拦得住）。 */}
      {unlockOpen && photo ? (
        <div onClick={stop}>
          <UnlockDialog photo={photo} onClose={() => setUnlockOpen(false)} />
        </div>
      ) : null}

      {/* 单张编辑对话框（仅 admin）：外层拦冒泡，点对话框不触发查看器的「点击即关闭」 */}
      {editOpen && photo ? (
        <div onClick={stop}>
          <EditDialog
            // key 让「编辑中切到下一张」重挂组件：EditDialog 的元数据草稿是 useState 初值，
            // 不重挂会带着上一张的标题/标签/隐私草稿，用户一保存就把它们写到了新照片上
            key={photo.id}
            photo={photo}
            categories={categories}
            onClose={() => setEditOpen(false)}
            onChanged={onPhotosChanged}
          />
        </div>
      ) : null}
    </div>
  );
}