/**
 * apps/web/src/components/Icon.tsx
 *
 * 图标集：统一 24 格线性风格（stroke 1.5，圆角端点），与原型保持同一套形状。
 * 只保留工程真正用到的图标，不做「先攒一堆以后再说」的储备。
 */
import type { ReactNode } from 'react';

export type IconName =
  | 'grid'
  | 'album'
  | 'map'
  | 'wrench'
  | 'camera'
  | 'aperture'
  | 'close'
  | 'download'
  | 'heart'
  | 'heartFilled'
  | 'arrowLeft'
  | 'arrowRight'
  | 'info'
  | 'chevron'
  | 'chevronRight'
  | 'eye'
  | 'eyeOff'
  | 'pin'
  | 'live'
  | 'play'
  | 'pause'
  | 'lock'
  | 'search'
  | 'edit'
  | 'user'
  | 'logout'
  | 'check'
  | 'list'
  | 'arrowUp'
  | 'arrowDown'
  | 'sliders';

/** 每个图标只是一段 path 描述，属性写在 <g> 上，避免逐个重复 */
const SHAPES: Record<IconName, ReactNode> = {
  grid: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
    </g>
  ),
  album: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5.5A2.5 2.5 0 016.5 3h11A2.5 2.5 0 0120 5.5v13a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 18.5z" />
      <circle cx="9" cy="8.5" r="1.4" />
      <path d="M4 15.5l3.5-3 3 2.5 3.5-3.5 4 4" />
    </g>
  ),
  /** 地图画廊：折叠地图（外轮廓 + 两条折缝），与 pin 的「单点定位」语义区分开 */
  map: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4.6L3.8 6.9v12.5L9 17.1l6 2.3 5.2-2.3V4.6L15 6.9z" />
      <path d="M9 4.6v12.5M15 6.9v12.5" />
    </g>
  ),
  wrench: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 6.5a4 4 0 00-5.6 4.2L4 15.6V19h3.4l4.9-4.9a4 4 0 004.2-5.6L14 11l-2.5-2.5z" />
    </g>
  ),
  camera: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5A1.5 1.5 0 014.5 6H7l1.5-2h7L17 6h2.5A1.5 1.5 0 0121 7.5v9a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 16.5z" />
      <circle cx="12" cy="12.5" r="3.2" />
    </g>
  ),
  /** 建筑影集用的「光圈」形状，与相机区分开 */
  aperture: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5l4 6.5M20.5 12l-7.5 1M16.5 20l-2-7M3.5 12l7.5-1M7.5 4l2 7" />
    </g>
  ),
  close: (
    <g fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </g>
  ),
  download: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v11" />
      <path d="M8 11l4 4 4-4" />
      <path d="M5 20h14" />
    </g>
  ),
  heart: (
    <g fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20s-7-4.5-9.5-8A5.3 5.3 0 0112 6.5 5.3 5.3 0 0121.5 12C19 15.5 12 20 12 20z" />
    </g>
  ),
  heartFilled: (
    <path
      fill="currentColor"
      d="M12 20s-7-4.5-9.5-8A5.3 5.3 0 0112 6.5 5.3 5.3 0 0121.5 12C19 15.5 12 20 12 20z"
    />
  ),
  arrowLeft: (
    <g fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 6L8.5 12l6 6" />
    </g>
  ),
  arrowRight: (
    <g fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 6l6 6-6 6" />
    </g>
  ),
  info: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.8v.2" />
    </g>
  ),
  chevron: (
    <g fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </g>
  ),
  chevronRight: (
    <g fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 6l6 6-6 6" />
    </g>
  ),
  /** 时间线浮层的显隐：睁眼 = 展开、闭眼（带一道斜杠）= 已收起 */
  eye: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </g>
  ),
  eyeOff: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.2 8.4C3.1 9.6 2.5 12 2.5 12s3.5 5.5 9.5 5.5c1.3 0 2.4-.2 3.4-.6" />
      <path d="M9.6 6.7A9.6 9.6 0 0112 6.5c6 0 9.5 5.5 9.5 5.5s-.9 1.4-2.5 2.8" />
      <path d="M9.8 9.8a2.6 2.6 0 003.4 3.4" />
      <path d="M4 4l16 16" />
    </g>
  ),
  /** 拍摄地：卡片右上角展示 GPS 反解地址 */
  pin: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21s6.5-5.6 6.5-10.4a6.5 6.5 0 10-13 0C5.5 15.4 12 21 12 21z" />
      <circle cx="12" cy="10.4" r="2.4" />
    </g>
  ),
  /** 实况照片：同心圆（iOS Live Photo 的通用语汇，可直观表达「这张会动」） */
  live: (
    <g fill="none" stroke="currentColor" strokeWidth={1.6}>
      <circle cx="12" cy="12" r="8.4" strokeDasharray="2.6 2.2" />
      <circle cx="12" cy="12" r="3.2" />
    </g>
  ),
  play: <path fill="currentColor" d="M8 5.2l11 6.8-11 6.8z" />,
  pause: (
    <g fill="currentColor">
      <rect x="7.5" y="5.5" width="3.4" height="13" rx="1.2" />
      <rect x="13.1" y="5.5" width="3.4" height="13" rx="1.2" />
    </g>
  ),
  /** 隐私照片：挂锁（锁体 + 拱形锁梁），直观表达「需要授权」 */
  lock: (
    <g fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
      <path d="M8.4 10.5V8a3.6 3.6 0 0 1 7.2 0v2.5" />
    </g>
  ),
  /** 搜索：放大镜，顶栏搜索入口 */
  search: (
    <g fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </g>
  ),
  /** 编辑：铅笔，admin 的元数据/EXIF 编辑入口 */
  edit: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h16" />
      <path d="M14.5 5.5l4 4L9 19l-5 1 1-5z" />
    </g>
  ),
  /** 账号：登录/当前用户入口 */
  user: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20a7.5 7.5 0 0115 0" />
    </g>
  ),
  /** 退出登录 */
  logout: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H5.5A1.5 1.5 0 004 6.5v11A1.5 1.5 0 005.5 19H9" />
      <path d="M14.5 8l4 4-4 4M18.5 12h-9" />
    </g>
  ),
  /** 勾选：批量选择模式下「已选中」角标 */
  check: (
    <g fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </g>
  ),
  /** 列表视图：三条带点的横线 */
  list: (
    <g fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <path d="M8.5 6.5h11" />
      <path d="M8.5 12h11" />
      <path d="M8.5 17.5h11" />
      <circle cx="4.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="17.5" r="1" fill="currentColor" stroke="none" />
    </g>
  ),
  arrowUp: (
    <g fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 14l6-6 6 6" />
    </g>
  ),
  arrowDown: (
    <g fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 10l6 6 6-6" />
    </g>
  ),
  /** 参数滑杆：三条轨道 + 三个旋钮，用于「EXIF 编辑」这类面板型工具 */
  sliders: (
    <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
      <path d="M4 8h16M4 12h16M4 16h16" />
      <circle cx="9" cy="8" r="1.8" />
      <circle cx="15" cy="12" r="1.8" />
      <circle cx="7" cy="16" r="1.8" />
    </g>
  ),
};

interface IconProps {
  name: IconName;
  className?: string;
}

/** 装饰性图标：对读屏器隐藏，语义交给外层按钮的 aria-label */
export function Icon({ name, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      {SHAPES[name]}
    </svg>
  );
}