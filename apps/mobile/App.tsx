/**
 * apps/mobile/App.tsx
 *
 * 应用外壳（RN 根组件）：模块 state → 四个平级模块，外加跨模块共享的筛选与喜爱状态。
 *
 * 【与 Web 的差异】Web 用 hash 路由（地址栏是它的天然状态）；移动端没有地址栏，
 * 一个 state 就是最短的路由实现 —— 见 src/modules.ts 的说明。
 *
 * 【状态为什么在顶层】分类筛选与喜爱集合要能「切走再切回来还在」，
 * 所以它们比模块活得更久，放在这里；其余状态尽量留在使用它的模块内。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Animated, Image, StyleSheet } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { configureApiBase } from '@shaping-memory/sdk';
import type { PhotoQuery } from '@shaping-memory/sdk';
import type { GalleryView, SortOrder, TimeScale } from '@shaping-memory/core';

import { TopNav } from './src/components/TopNav';
import { AlbumsScreen } from './src/screens/AlbumsScreen';
import { GalleryScreen } from './src/screens/GalleryScreen';
import { MapScreen } from './src/screens/MapScreen';
import { ToolsScreen } from './src/screens/ToolsScreen';
import { AdminScreen } from './src/admin/AdminScreen';
import { usePhotos } from './src/hooks/usePhotos';
import { clearSession, currentSession, isFrontAdmin } from './src/front/session';
import type { FrontSession } from './src/front/session';
import { duration, easing } from './src/layout/motion';
import { colors } from './src/theme';
import type { MapViewState } from './src/screens/MapScreen';
import type { Module } from './src/modules';

// 打包期注入的 API 域名：Expo 会把 EXPO_PUBLIC_* 内联进 bundle。
// 必须在渲染前生效 —— usePhotos 一挂载就发请求，而真机上的 127.0.0.1 是手机自己。
const envApiBase = process.env.EXPO_PUBLIC_API_BASE;
if (envApiBase) configureApiBase(envApiBase);

/* 开屏标记直接用开屏素材本身：原生侧 Expo 会把它缩到 200dp 见方居中显示
   （splash 的 imageWidth 默认值就是 200），JS 侧照同一尺寸渲染，
   原生开屏退场的那一帧才能与这层遮罩严丝合缝地对上 —— 用户只看到「标记淡出」。
   改这里的数值必须连同 app.json 的 splash 与 scripts/generate-brand-assets.mjs 一起改。 */
const SPLASH_MARK = require('./assets/splash.png');
const SPLASH_MARK_DP = 200;

/** 开屏节奏：数据已就绪也要让标记展示够 MIN；迟迟不来最多等 MAX（弱网下宁可缩短展示时间，也避免被误判为卡死） */
const LAUNCH_MIN_MS = 400;
const LAUNCH_MAX_MS = 1400;
/** 主界面上浮的距离（dp）：在 8~12 区间取上沿，既能察觉上浮，又不至于过分 */
const CONTENT_RISE_DP = 12;

/** 画廊筛选：分类 / 浏览方式 / 列表顺序 / 时间刻度 / 相册，五个维度一起跨模块存活 */
interface GalleryFilters {
  category: string;
  view: GalleryView;
  sort: SortOrder;
  /** 刻度粒度同时驱动图墙分段标签、列表分组与底部横轨，因此必须比模块活得更久 */
  scale: TimeScale;
  albumId?: string;
}

/** 初始筛选：全部 / 墙面 / 倒序（最新在前）/ 月刻度 */
const INITIAL_FILTERS: GalleryFilters = { category: '全部', view: 'wall', sort: 'desc', scale: 'month' };

export function App() {
  const [module, setModule] = useState<Module>('gallery');
  const [filters, setFilters] = useState<GalleryFilters>(INITIAL_FILTERS);
  const [liked, setLiked] = useState<ReadonlySet<string>>(() => new Set());
  // EXIF 搜索条件：顶栏搜索面板「应用」后写入；有值时画廊改走服务端检索
  const [search, setSearch] = useState<PhotoQuery>({});
  // 整份照片档案在顶层取一次，画廊与影集共用。
  // 首屏只取一页，滚到底由 GalleryScreen 触发 loadMore；地图要全量点位，见下面的 effect。
  const { photos, loading, hasMore, loadingMore, error, loadMore, loadAll, refresh } = usePhotos();
  // 前台登录态：admin 登录后开放前台编辑能力
  const [session, setSession] = useState<FrontSession | null>(() => currentSession());
  const admin = isFrontAdmin(session);
  /* 地图视野（底图 / 中心 / 缩放）：null = 还没定过，由 MapScreen 按照片分布自己定；
     用户动过之后回写到这层 —— 切走再切回来仍在同一片区域，不会被重置 */
  const [mapView, setMapView] = useState<MapViewState | null>(null);
  /* 模块切换淡入：与 Web 的 .module 入场关键帧采用同一档动效，
     同时也盖住地图 WebView 挂载瞬间的空白 */
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: duration.base, easing: easing.smooth, useNativeDriver: true }).start();
  }, [module, fade]);

  /* 开屏过渡：原生开屏退场时，这层遮罩已经用同一张图站好了位，
     因此用户实际看到的只有「标记淡出、主界面上浮」这一件事。
     两条动画都是纯透明度 + 位移，全部交给 native driver，不占 JS 线程。 */
  const [launching, setLaunching] = useState(true);
  const launch = useRef(new Animated.Value(1)).current;
  const content = useRef(new Animated.Value(0)).current;
  // 挂载时刻：下面按它算「标记已经露了多久」
  const mountedAt = useRef(Date.now());
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    // 照片先到就按最短停留走；还没到就等到上限 —— 上限不可省，否则弱网下开屏会被误判为卡死
    const held = Date.now() - mountedAt.current;
    const cap = loading ? LAUNCH_MAX_MS : LAUNCH_MIN_MS;
    const timer = setTimeout(() => {
      started.current = true;
      Animated.parallel([
        Animated.timing(launch, { toValue: 0, duration: duration.slow, easing: easing.smooth, useNativeDriver: true }),
        // 主界面晚 150ms 起步：标记先退、内容再浮上来，两段叠着走，衔接才不突兀
        Animated.timing(content, {
          toValue: 1,
          duration: duration.slow,
          delay: duration.fast,
          easing: easing.smooth,
          useNativeDriver: true,
        }),
      ]).start(() => setLaunching(false));
    }, Math.max(0, cap - held));
    return () => clearTimeout(timer);
  }, [loading, launch, content]);

  /** 主界面的上浮量：与透明度共用同一条进度，12dp → 0 */
  const contentRise = content.interpolate({ inputRange: [0, 1], outputRange: [CONTENT_RISE_DP, 0] });

  /** 只接受增量补丁：调用方不必关心另外两个维度现在是什么 */
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

  const openAlbum = useCallback(
    (albumId: string) => {
      // 进入相册：分类先归位到「全部」（册内可再按分类细筛），再切到画廊
      patchFilters({ albumId, category: '全部' });
      setModule('gallery');
    },
    [patchFilters],
  );

  /* 地图要的是「全部点位」（聚类分布），而首屏只取了一页 —— 切到地图时补一份整档。
     【为什么声明在 usePhotos 之后】同一组件内的 effect 按声明顺序执行，排在后面才能保证
     「先取第一页、再取整档」，后者代次更晚，不会被前者覆盖；相册模式下地图用的是册内照片，
     与整档无关，无需额外请求一次。 */
  useEffect(() => {
    if (module === 'map' && !filters.albumId) loadAll();
  }, [module, loadAll, filters.albumId]);

  /* 模块 → 屏幕：用 switch 而非层层三元，新增模块时只加一个 case */
  let screen: ReactNode;
  switch (module) {
    case 'albums':
      screen = <AlbumsScreen onOpenAlbum={openAlbum} />;
      break;
    case 'map':
      screen = (
        <MapScreen
          photos={photos}
          loading={loading}
          category={filters.category}
          albumId={filters.albumId}
          search={search}
          view={mapView}
          onViewChange={setMapView}
          onCategoryChange={(category) => patchFilters({ category })}
          onExitAlbum={() => patchFilters({ albumId: undefined })}
          admin={admin}
          onPhotosChanged={refresh}
          liked={liked}
          onToggleLike={toggleLike}
        />
      );
      break;
    case 'tools':
      screen = <ToolsScreen />;
      break;
    case 'admin':
      screen = <AdminScreen />;
      break;
    default:
      screen = (
        <GalleryScreen
          photos={photos}
          loading={loading}
          hasMore={hasMore}
          loadingMore={loadingMore}
          error={error}
          onLoadMore={loadMore}
          category={filters.category}
          view={filters.view}
          sort={filters.sort}
          scale={filters.scale}
          albumId={filters.albumId}
          onCategoryChange={(category) => patchFilters({ category })}
          onViewChange={(view) => patchFilters({ view })}
          onSortChange={(sort) => patchFilters({ sort })}
          onScaleChange={(scale) => patchFilters({ scale })}
          onExitAlbum={() => patchFilters({ albumId: undefined })}
          search={search}
          admin={admin}
          onPhotosChanged={refresh}
          liked={liked}
          onToggleLike={toggleLike}
        />
      );
  }

  return (
    <SafeAreaProvider>
      {/* 暗色是唯一方案（规范 §1.1）：状态栏亮字配深色背板 */}
      <StatusBar style="light" />
      {/* 横屏与刘海屏要让出左右安全区：竖屏时这两个值本就是 0，
          横屏时刘海会切到侧边，不进 padding 就会被页头与照片压住。 */}
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
        {/* 页头与内容一起进场：只浮内容的话，页头会先钉在上面，与开屏的衔接就断成两截 */}
        <Animated.View style={[styles.shell, { opacity: content, transform: [{ translateY: contentRise }] }]}>
          <TopNav module={module} onNavigate={setModule} onSearch={setSearch} session={session} onLogin={setSession} onLogout={handleLogout} />
          <Animated.View style={[styles.body, { opacity: fade }]}>{screen}</Animated.View>
        </Animated.View>
      </SafeAreaView>
      {/* 开屏遮罩：必须挂在 SafeAreaView 之外才会铺满整屏 —— 放进去会被安全区的 padding 顶下来 */}
      {launching && (
        <Animated.View style={[styles.launch, { opacity: launch }]} pointerEvents="none">
          <Image source={SPLASH_MARK} style={styles.launchMark} />
        </Animated.View>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  shell: { flex: 1 },
  body: { flex: 1 },
  // 与原生开屏同款：深底 + 居中那块玻璃板
  launch: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  launchMark: { width: SPLASH_MARK_DP, height: SPLASH_MARK_DP },
});