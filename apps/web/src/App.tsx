/**
 * apps/web/src/App.tsx
 *
 * 应用外壳：hash 路由 → 四个平级模块，外加跨模块共享的筛选与喜爱状态。
 *
 * 【状态为什么在顶层】分类筛选与喜爱集合要能「切走再切回来还在」，
 * 所以它们比模块活得更久，放在这里；其余状态尽量留在使用它的模块内。
 *
 * 【MotionConfig 为什么在最外层】它为整棵树统一处理两件事：
 *   1) 未单独指定 transition 的动画统一落到 tokens 的 smooth 弹簧上；
 *   2) reducedMotion="user" —— 用户开了系统「减少动态效果」时，
 *      Motion 自动改为只做透明度变化，不在 JS 里逐个组件判断。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { MotionConfig } from 'motion/react';

import { AlbumsScreen } from './screens/AlbumsScreen';
import { GalleryScreen } from './screens/GalleryScreen';
import { MapScreen } from './screens/MapScreen';
import { PrivacyShareScreen } from './screens/PrivacyShareScreen';
import { ToolsScreen } from './screens/ToolsScreen';
import { TopNav } from './components/TopNav';
import { useHashRoute } from './hooks/useHashRoute';
import { usePhotos } from './hooks/usePhotos';
import { clearSession, currentSession, isFrontAdmin } from './lib/session';
import type { FrontSession } from './lib/session';
import { springs } from './lib/motion';
import type { GalleryFilters, MapViewState } from './types';
import type { SearchQuery } from '@shaping-memory/core';

/** 初始筛选：全部 / 墙面 / 倒序（最新在前）/ 月刻度 */
const INITIAL_FILTERS: GalleryFilters = { category: '全部', view: 'wall', sort: 'desc', scale: 'month' };

export function App() {
  const [route, params, navigate] = useHashRoute();
  const [filters, setFilters] = useState<GalleryFilters>(() => ({
    ...INITIAL_FILTERS,
    // 分享链接 /#gallery?album=xxx 直达：把 query 里的相册 id 落到筛选态
    albumId: params.album,
  }));
  const [liked, setLiked] = useState<ReadonlySet<string>>(() => new Set());
  // EXIF 搜索条件：顶栏搜索面板「搜索」后写入。它同时是取数条件 —— 由 usePhotos 交给
  // /search/photos 在服务端筛，因此这里不再需要在前端做二次过滤。
  const [search, setSearch] = useState<SearchQuery>({});
  // 整份照片档案在顶层取一次，画廊与影集共用（条件变化会自动重取）。
  // 接口一次性返回全部结果，地图与图墙看到的是同一份完整数据。
  const { photos, loading, error, refresh } = usePhotos(search);
  // 前台登录态：admin 登录后开放前台编辑能力（编辑保存后 refresh 触发重拉）
  const [session, setSession] = useState<FrontSession | null>(() => currentSession());
  const admin = isFrontAdmin(session);
  /* 地图视野（底图 / 中心 / 缩放）：null = 还没定过视野，由 MapScreen 首次根据照片分布自己定；
     一旦用户动过就回写到这层 —— 切走再切回来仍是同一片区域，不会被重置回默认视野。 */
  const [mapView, setMapView] = useState<MapViewState | null>(null);

  /** 只接受增量补丁：调用方不必关系另外两个维度现在是什么 */
  const patchFilters = useCallback((patch: Partial<GalleryFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  const toggleLike = useCallback((id: string) => {
    setLiked((prev) => {
      const next = new Set(prev);
      // Set.delete 返回是否真的删掉了：一举两得，不必先 has 再判断
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  /** 退出前台（清会话 + 复位状态） */
  const handleLogout = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  /* hash 路由不会自己滚回顶部：从长列表切到另一个模块会停在半途，这里补上 */
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

  const openAlbum = useCallback(
    (albumId: string) => {
      // 进入相册：分类先归位到「全部」（册内可再按分类细筛），再切到画廊
      patchFilters({ albumId, category: '全部' });
      navigate('gallery');
    },
    [navigate, patchFilters],
  );

  /* 路由 → 模块：用 switch 而非层层三元，新增模块时只加一个 case */
  let module: ReactNode;
  switch (route) {
    case 'albums':
      module = <AlbumsScreen onOpenAlbum={openAlbum} />;
      break;
    case 'map':
      module = (
        <MapScreen
          photos={photos}
          loading={loading}
          filters={filters}
          onFiltersChange={patchFilters}
          search={search}
          view={mapView}
          onViewChange={setMapView}
          admin={admin}
          onPhotosChanged={refresh}
          liked={liked}
          onToggleLike={toggleLike}
        />
      );
      break;
    case 'tools':
      module = <ToolsScreen />;
      break;
    case 'privacy-share':
      module = <PrivacyShareScreen token={params.token ?? ''} />;
      break;
    default:
      module = (
        <GalleryScreen
          photos={photos}
          loading={loading}
          error={error}
          filters={filters}
          onFiltersChange={patchFilters}
          search={search}
          admin={admin}
          onPhotosChanged={refresh}
          liked={liked}
          onToggleLike={toggleLike}
        />
      );
  }

  /* 分享页是「给外人看的一页」：不挂站内导航，免得被一路点进别人的档案里 */
  const bare = route === 'privacy-share';

  return (
    <MotionConfig reducedMotion="user" transition={springs.smooth}>
      {bare ? null : (
        <TopNav route={route} onNavigate={navigate} onSearch={setSearch} session={session} onLogin={setSession} onLogout={handleLogout} />
      )}
      <main className="app">{module}</main>
    </MotionConfig>
  );
}