/**
 * apps/web/src/types.ts
 *
 * Web 端内部共享类型：只放「跨组件的小契约」，领域模型仍然只有 @shaping-memory/core 一份。
 */
import type { GalleryView, SortOrder } from '@shaping-memory/core';
import type { RailScale } from './hooks/useProgressRail';
import type { BasemapKey } from './components/GpsPicker';

/** 画廊的筛选维度，由 App 持有，切模块后回来仍保持原选择 */
export interface GalleryFilters {
  /** 分类，'全部' 表示不筛 */
  category: string;
  view: GalleryView;
  sort: SortOrder;
  /** 时间刻度粒度（月 / 日），两个视图共用同一条轨，因此提升到这里 */
  scale: RailScale;
  /** 相册筛选：有值时画廊只展示该相册内的照片（与分类筛选叠加） */
  albumId?: string;
}

/**
 * 地图视野：由 App 持有，切走再切回时不重置 ——
 * 每次回到地图都跳回默认视野，会把「我在看哪一片」这条上下文丢掉。
 */
export interface MapViewState {
  /** 底图（高德 / OSM），与 GpsPicker 同一份 BASEMAPS 的键 */
  basemap: BasemapKey;
  lat: number;
  lon: number;
  zoom: number;
}

/** 打开查看器：传入照片在当前列表中的下标与列表本身，翻页方向才与列表一致 */
export type OpenHandler = (
  index: number,
  list: readonly import('@shaping-memory/core').Photo[],
  /** 被点照片在网格里的视口矩形：放大动画的起点，退出时还要用它飞回来 */
  origin: DOMRect,
) => void;