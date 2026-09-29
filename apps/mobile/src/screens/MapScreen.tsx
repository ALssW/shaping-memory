/**
 * apps/mobile/src/screens/MapScreen.tsx
 *
 * 地图画廊（导航胶囊第三项）：把带 GPS 的照片按**当前缩放级别**聚成簇，钉在 Leaflet 底图上。
 *
 * 【为什么把测绘的活全留在 RN 侧】WebView 里那页 Leaflet 只是个哑渲染层 ——
 * 聚类、坐标系换算、筛选全部由 RN 用 packages/core 的纯函数算好再一并下发。
 * 这样两端（Web / 移动端）共用同一份 map-cluster 与 geo，分组口径不可能出现不一致；
 * 页面里也不必再有一份 GCJ-02 换算代码。
 *
 * 【坐标系铁律】`photo.gps` 恒为 WGS-84，高德底图是 GCJ-02（国内偏 300–600 米）。
 * 因此：RN 内部状态一律 WGS-84，只在**下发给地图**那一刻 fromWgs84，
 * 从地图读回视野时 toWgs84。切底图因此只是「换个坐标系重新落点」，真实地点不动。
 *
 * 【为什么聚类在 WGS-84 空间做】GCJ-02 的偏移在国内是近似平移，同一格（最细约 33 米）内的
 * 照片在两种坐标系下几乎必然仍同格，所以切底图不会重排分组，只是整体挪到真实位置。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import { albumApi, searchApi } from '@shaping-memory/sdk';
import type { PhotoQuery } from '@shaping-memory/sdk';
import { CATEGORIES, clusterPhotosByZoom, filterByCategory, fromWgs84, hasGps, toWgs84 } from '@shaping-memory/core';
import type { CoordSystem, Photo, PhotoCluster } from '@shaping-memory/core';

import { Chip, ChipRow } from '../components/primitives';
import { MapBottomSheet } from '../components/MapBottomSheet';
import { hasSearchConditions, searchInMemory } from '../lib/photo-search';
import { useBreakpoint } from '../layout/useBreakpoint';
import { backgroundRgba, blurCss, colors, elevationCssShadow, radius, space, text, textRgba } from '../theme';
import { Viewer } from './Viewer';

/**
 * 底图标识（与 Web 的 GpsPicker 同一组键）。
 * 【为什么只剩一档】OSM 瓦片在境内被 DNS 污染 / TCP 阻断（实测连接超时），
 * 留着它只是给用户一个「切过去就是灰底」的按钮，因此不再提供切换。
 * 类型与视图状态里的 basemap 字段仍然保留：视野是跨屏共享的既有结构，
 * 为一档底图把它整条拆掉，收益远小于改动面。
 */
export type BasemapKey = 'amap';

interface BasemapConfig {
  /** 瓦片地址模板 —— 由 RN 下发给页面，页面里不再存第二份底图配置 */
  url: string;
  /** 子域轮询（高德必需，否则单域名并发受限） */
  subdomains?: string;
  /** 该底图使用的坐标系 —— 换算的唯一依据 */
  crs: CoordSystem;
}

const BASEMAPS: Record<BasemapKey, BasemapConfig> = {
  amap: {
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: '1234',
    crs: 'gcj02',
  },
};

/** 底图与聚类都缺失时的保底视野：中国腹地，zoom 4 大致装下全国 */
const DEFAULT_VIEW: MapViewState = { basemap: 'amap', lat: 34.5, lon: 108.9, zoom: 4 };
/** 缩略图针脚直径（与页面里 .pin 的尺寸同值） */
const PIN_SIZE = 40;
/** 包围盒跨度（度）小于它即认为「同一机位」——放大也分不开，直接展开簇内容 */
const SAME_SPOT_SPAN = 1e-4;
/** 点簇放大时允许的最近档：再近瓦片就糊了 */
const FOCUS_MAX_ZOOM = 17;
/** 点簇放大的留白（像素），换算到手机屏上约等于「留出一指宽」 */
const FIT_PADDING = 48;

/** 地图视野：由 App 持有，切走再切回时不重置 */
export interface MapViewState {
  basemap: BasemapKey;
  lat: number;
  lon: number;
  zoom: number;
}

/** 地图上报给 RN 的消息 */
interface MapMessage {
  type?: 'ready' | 'view' | 'tapMarker' | 'tapMap';
  lat?: number;
  lon?: number;
  zoom?: number;
  key?: string;
}

/** 下发给页面的一个标记：坐标**已换算到底图坐标系** */
interface MarkerPayload {
  key: string;
  lat: number;
  lon: number;
  count: number;
  /** 单张时是缩略图地址；多张时为 undefined */
  url?: string;
}

/* -------------------------------------------------------------------------- */
/* 内联 Leaflet 页面                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 内联 Leaflet 页面。与 GpsPicker 同一套范式：`postMessage` 上报、`injectJavaScript` 回灌。
 * 【为什么内联而不是加载 remote URL】内联 HTML 不依赖本项目的静态资源托管，
 * 换域名 / 离线打包都不会失效；页面里真正联网的只有瓦片。
 *
 * 造型色（accent / 背板色）由 RN 从设计 token 中取出后写入页面，页面里不写死任何色值 ——
 * 否则后端改一次 accent，地图上的标记就会与其余界面脱节。
 */
function buildMapHtml(initial: MapViewState): string {
  const config = BASEMAPS[initial.basemap];
  const start = fromWgs84({ lat: initial.lat, lon: initial.lon }, config.crs);
  const accent = JSON.stringify(colors.accent);
  const background = JSON.stringify(colors.background);
  const textColor = JSON.stringify(colors.text.base);
  /* 玻璃针脚的三件套（半透明材质 / 发丝描边 / 受光高光）在这里算好后写入页面：
     页面里没有 CSS 变量与 color-mix()，数值仍只有 tokens 一处来源。
     当前底图瓦片为浅色，因此描边只用白色发丝，不用具体颜色去配。 */
  const glass = JSON.stringify(colors.material.medium);
  const hairline = JSON.stringify(textRgba(0.34));
  const halo = JSON.stringify(textRgba(0.48));
  const pad = JSON.stringify(backgroundRgba(0.55));
  const glow = JSON.stringify(backgroundRgba(0.6));
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  html,body,#map{height:100%;margin:0;background:${background}}
  .leaflet-container{background:${background};font-family:inherit}
  /* divIcon 的默认边框与白底必须清掉，否则每个标记都会顶着一个白方块 */
  .mk{background:none;border:0}
  /* 透明玻璃针脚：玻璃壳 + 内嵌缩略图。壳厚 3px（padding）—— 这一圈里透出来的是底图，
     针脚因此读起来像压在图上的一块玻璃，而不是贴在图上的一张圆头像 */
  .pin{display:block;box-sizing:border-box;border-radius:50%;overflow:hidden;padding:3px;
    background:${glass};
    -webkit-backdrop-filter:blur(${blurCss.md}) saturate(1.5);backdrop-filter:blur(${blurCss.md}) saturate(1.5);
    border:1px solid ${hairline};
    box-shadow:inset 0 1px 0 ${halo}, 0 0 0 1px ${pad}, ${elevationCssShadow}}
  .pin img{width:100%;height:100%;object-fit:cover;display:block;border-radius:50%}
  /* 簇标记：同一块玻璃，只是把内嵌的缩略图换成张数。
     计数用主色（不是反白）—— 玻璃底是半透明的暗色，主色在其上比白字更醒目 */
  .cluster{display:flex;align-items:center;justify-content:center;border-radius:50%;
    background:${glass};
    -webkit-backdrop-filter:blur(${blurCss.md}) saturate(1.5);backdrop-filter:blur(${blurCss.md}) saturate(1.5);
    border:1px solid ${hairline};color:${accent};
    box-shadow:inset 0 1px 0 ${halo}, 0 0 0 1px ${pad}, ${elevationCssShadow}}
  .cluster b{font-weight:600;line-height:1;
    /* 浅色瓦片透过玻璃后仍是浅色，给字一圈极淡的暗晕，以保证文字在底图上清晰可读 */
    text-shadow:0 1px 2px ${glow}}
  /* 缩放控件默认白底黑边，与暗色界面冲突：换成材质色 + 文字色图标 */
  .leaflet-control-zoom a{background:${background};color:${textColor};border-color:rgba(255,255,255,0.12)}
</style>
</head><body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function(){
  var post = function (m) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(m)); };
  var PIN = ${PIN_SIZE};
  var map = L.map('map', { zoomControl: true, attributionControl: false, worldCopyJump: true })
    .setView([${start.lat}, ${start.lon}], ${initial.zoom});
  var tiles = null;
  function setTiles(url, subdomains) {
    if (tiles) { map.removeLayer(tiles); }
    tiles = L.tileLayer(url, { subdomains: subdomains || 'abc', minZoom: 3, maxZoom: 19 }).addTo(map);
  }
  setTiles(${JSON.stringify(config.url)}, ${JSON.stringify(config.subdomains ?? 'abc')});

  var live = {};
  function iconFor(item) {
    if (item.count === 1) {
      var pin = document.createElement('span');
      pin.className = 'pin';
      pin.style.width = PIN + 'px';
      pin.style.height = PIN + 'px';
      var img = document.createElement('img');
      img.src = item.url;
      img.alt = '';
      pin.appendChild(img);
      return L.divIcon({ className: 'mk', html: pin, iconSize: [PIN, PIN] });
    }
    var size = item.count >= 100 ? 44 : item.count >= 10 ? 38 : 32;
    var badge = document.createElement('span');
    badge.className = 'cluster';
    badge.style.width = size + 'px';
    badge.style.height = size + 'px';
    badge.style.fontSize = (size >= 44 ? 14 : 13) + 'px';
    var num = document.createElement('b');
    num.textContent = String(item.count);
    badge.appendChild(num);
    return L.divIcon({ className: 'mk', html: badge, iconSize: [size, size] });
  }

  /* 标记按网格键复用：同键只挪位置，签名没变就不 setIcon —— 缩略图因此不会被重新请求 */
  window.__setMarkers = function (list) {
    var next = {};
    (list || []).forEach(function (item) {
      next[item.key] = true;
      var sig = item.count + '|' + (item.url || '');
      var entry = live[item.key];
      if (entry) {
        entry.marker.setLatLng([item.lat, item.lon]);
        entry.marker.setZIndexOffset(item.count * 100);
        if (entry.sig !== sig) { entry.marker.setIcon(iconFor(item)); entry.sig = sig; }
        return;
      }
      var marker = L.marker([item.lat, item.lon], { icon: iconFor(item), zIndexOffset: item.count * 100, keyboard: false });
      /* 点击只报「哪一簇」，卡片内容由 RN 决定 —— 页面不认识照片模型 */
      marker.on('click', function () { post({ type: 'tapMarker', key: item.key }); });
      marker.addTo(map);
      live[item.key] = { marker: marker, sig: sig };
    });
    Object.keys(live).forEach(function (key) {
      if (next[key]) { return; }
      map.removeLayer(live[key].marker);
      delete live[key];
    });
  };
  window.__setBasemap = function (url, subdomains) { setTiles(url, subdomains); };
  /* 换底图 / 外部改动视野：animate:false —— 这是「换个坐标系看同一个地方」，不该看到一段位移 */
  window.__setView = function (lat, lon, zoom) { map.setView([lat, lon], zoom, { animate: false }); };
  window.__fitBounds = function (points, maxZoom, padding) {
    if (!points || !points.length) { return; }
    map.fitBounds(L.latLngBounds(points), { padding: [padding, padding], maxZoom: maxZoom });
  };

  /* moveend 在缩放结束后也会触发，因此视野上报只挂这两个事件就够 */
  var report = function () {
    var center = map.getCenter();
    post({ type: 'view', lat: center.lat, lon: center.lng, zoom: map.getZoom() });
  };
  map.on('moveend', report);
  map.on('zoomend', report);
  /* 点空白处 = 收起信息面板（触屏上比寻找关闭按钮更直接） */
  map.on('click', function () { post({ type: 'tapMap' }); });
  post({ type: 'ready' });
})();
</script>
</body></html>`;
}

/* -------------------------------------------------------------------------- */

interface MapScreenProps {
  /** 整份档案（非相册模式下的数据源） */
  photos: readonly Photo[];
  loading: boolean;
  category: string;
  onCategoryChange: (category: string) => void;
  /** 有值时处于相册模式：数据源换成册内照片 */
  albumId?: string;
  onExitAlbum: () => void;
  /** EXIF 搜索条件：有值时改走服务端检索（与画廊同一处口径，见 lib/photo-search） */
  search: PhotoQuery;
  /** 上次的视野；null = 还没定过，由本组件按照片分布自己定 */
  view: MapViewState | null;
  onViewChange: (view: MapViewState) => void;
  /** 是否具备前台编辑能力（admin）：放大器里显示编辑入口 */
  admin: boolean;
  /** 编辑保存成功后的回调：触发顶层重拉照片列表 */
  onPhotosChanged: () => void;
  liked: ReadonlySet<string>;
  onToggleLike: (id: string) => void;
}

export function MapScreen({
  photos,
  loading,
  category,
  onCategoryChange,
  albumId,
  onExitAlbum,
  search,
  view,
  onViewChange,
  admin,
  onPhotosChanged,
  liked,
  onToggleLike,
}: MapScreenProps) {
  const { tier } = useBreakpoint();
  /* 聚类格边长（屏幕像素，见 core/map-cluster）：竖屏收窄到 56 —— 同样的物理屏幕里
     少一格就少一个标记，手指也更容易点中 */
  const cellPx = tier === 'sm' ? 56 : 64;
  /* 标记上限同理按档位收：手机上减少数十个节点，平移的流畅度会明显改善 */
  const maxMarkers = tier === 'sm' ? 120 : 240;

  const viewRef = useRef<WebView>(null);
  /** 页面是否就绪：ready 之前的 injectJavaScript 会丢，所有下发都以它为闸门 */
  const [ready, setReady] = useState(false);
  const fittedRef = useRef(false);
  /** 地图当前的 WGS-84 中心与缩放：换底图 / 点簇放大时要用到最新值（state 会带来闭包过期） */
  const centerRef = useRef<{ lat: number; lon: number }>({ lat: DEFAULT_VIEW.lat, lon: DEFAULT_VIEW.lon });
  const zoomRef = useRef(DEFAULT_VIEW.zoom);
  const crsRef = useRef(BASEMAPS[view?.basemap ?? DEFAULT_VIEW.basemap].crs);
  /* 底图的「最新值」镜像：换底图时 __setView 会立刻触发一次 moveend 上报，
     那个回调若读的是本轮渲染闭包里的 basemap，就可能把刚切好的底图又写回旧值 */
  const basemapRef = useRef(view?.basemap ?? DEFAULT_VIEW.basemap);
  const clustersRef = useRef<Map<string, PhotoCluster>>(new Map());
  const [zoom, setZoom] = useState(view?.zoom ?? DEFAULT_VIEW.zoom);
  const [showAll, setShowAll] = useState(false);

  const basemap = view?.basemap ?? DEFAULT_VIEW.basemap;
  /* 页面只按首帧的视野建一次：之后所有变化都走 injectJavaScript，重建 WebView 会丢地图状态 */
  const initialView = useRef(view ?? DEFAULT_VIEW);
  const html = useMemo(() => buildMapHtml(initialView.current), []);

  /** 下发一段脚本；页面没就绪就丢（各 effect 都以 ready 为依赖，就绪后会重跑一遍） */
  const inject = useCallback((script: string) => {
    viewRef.current?.injectJavaScript(script);
  }, []);

  /* ---------------------------------------------------------------- 数据 */

  /* 相册模式：数据源换成册内照片（顺序由后台 sortOrder 决定） */
  const [album, setAlbum] = useState<readonly Photo[] | null>(null);
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
        setAlbum(detail.photos);
        setAlbumLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setAlbum([]);
        setAlbumLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [albumId]);

  /* 服务端检索态：有搜索条件且不在相册模式时启用（相册是整份档案的子集，只能本地筛） */
  const searching = hasSearchConditions(search);
  const [remote, setRemote] = useState<{ photos: readonly Photo[]; loading: boolean }>({ photos: [], loading: false });
  useEffect(() => {
    if (!searching || albumId) {
      setRemote({ photos: [], loading: false });
      return;
    }
    let cancelled = false;
    setRemote((prev) => ({ photos: prev.photos, loading: true }));
    searchApi
      .photos({ category, ...search })
      .then((result) => {
        if (!cancelled) setRemote({ photos: result, loading: false });
      })
      .catch(() => {
        /* 检索失败即呈现空集，与「没有符合条件的照片」同一表现 */
        if (!cancelled) setRemote({ photos: [], loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [searching, albumId, search, category]);

  /** 实际参与筛选的照片。「看全部」直接短路 —— 它的语义就是「无视分类 / 相册 / 搜索条件」 */
  const filtered = useMemo(() => {
    if (showAll) return photos;
    if (searching && !albumId) return remote.photos;
    const source = albumId ? album ?? [] : photos;
    return searchInMemory(filterByCategory(source, category), search);
  }, [showAll, searching, albumId, remote.photos, album, photos, category, search]);

  /** 可上图的部分（没有定位的照片在地图上无处安放，直接剔除并另行计数） */
  const mapped = useMemo(() => filtered.filter(hasGps), [filtered]);
  const missingCount = filtered.length - mapped.length;

  const clusters = useMemo(
    () => clusterPhotosByZoom(mapped, { zoom, cellPx, maxMarkers }),
    [mapped, zoom, cellPx, maxMarkers],
  );

  const busy = albumId ? albumLoading || !album : searching ? remote.loading : loading;

  /* ---------------------------------------------------------------- 面板 */

  /* 信息面板的两种形态：单张详情 / 同一机位的一组，共用一个底部抽屉。
     `spot` 恒是「这份内容出自哪个点位」—— 从横条里挑一张之后 cluster 会置空，
     但进放大器时的列表仍要是整簇（见 openSpot）。 */
  const [sheet, setSheet] = useState<{
    photo: Photo | null;
    cluster: PhotoCluster | null;
    spot: PhotoCluster | null;
  }>({ photo: null, cluster: null, spot: null });
  const closeSheet = useCallback(() => setSheet({ photo: null, cluster: null, spot: null }), []);

  /* 放大器：与图墙那一路各持一份 —— 这里的列表恒为「这个点位的照片」。
     列表语义不同（「这个机位拍了些什么」而非「整份档案的第几张」），故不共用同一份状态。 */
  const [viewer, setViewer] = useState<{ list: readonly Photo[]; index: number } | null>(null);

  /** 循环翻页：与图墙那一路同形，只是列表恒为「这个点位」 */
  const stepViewer = useCallback((delta: number) => {
    setViewer((prev) => {
      if (!prev || prev.list.length === 0) return prev;
      const count = prev.list.length;
      return { ...prev, index: (prev.index + delta + count) % count };
    });
  }, []);
  const seekViewer = useCallback((index: number) => {
    setViewer((prev) => {
      if (!prev || prev.list.length === 0) return prev;
      return { ...prev, index: Math.min(prev.list.length - 1, Math.max(0, index)) };
    });
  }, []);
  const closeViewer = useCallback(() => setViewer(null), []);

  /**
   * 卡片里的缩略图被点 → 进放大器。列表恒为**这个点位的全部照片**：
   * 单张针脚的点位长度就是 1，多张的点位进来就能左右翻遍该机位的每一张。
   */
  const openSpot = useCallback((spot: PhotoCluster | null, photo: Photo) => {
    const list = spot && spot.photos.length > 0 ? spot.photos : [photo];
    const at = list.findIndex((item) => item.id === photo.id);
    setViewer({ list, index: at < 0 ? 0 : at });
  }, []);

  /** 点簇 / 点针脚：单张直接开面板，多张先放大，实在分不开（同一机位）就直接展开簇内容 */
  const handleMarkerTap = useCallback(
    (key: string) => {
      const cluster = clustersRef.current.get(key);
      if (!cluster) return;
      if (cluster.photos.length === 1) {
        setSheet({ photo: cluster.photos[0], cluster: null, spot: cluster });
        return;
      }
      /* 包围盒跨度：小于阈值的簇放大后仍会并在一起，直接展开内容才是有效反馈 */
      let span = 0;
      for (const photo of cluster.photos) {
        span = Math.max(
          span,
          Math.abs((photo.gps?.lat ?? 0) - cluster.lat),
          Math.abs((photo.gps?.lon ?? 0) - cluster.lon),
        );
      }
      if (span <= SAME_SPOT_SPAN || zoomRef.current >= FOCUS_MAX_ZOOM) {
        setSheet({ photo: null, cluster, spot: cluster });
        return;
      }
      const crs = crsRef.current;
      const points = cluster.photos.map((photo) => {
        const moved = fromWgs84({ lat: photo.gps?.lat ?? 0, lon: photo.gps?.lon ?? 0 }, crs);
        return [moved.lat, moved.lon];
      });
      inject(`window.__fitBounds(${JSON.stringify(points)}, ${FOCUS_MAX_ZOOM}, ${FIT_PADDING}); true;`);
    },
    [inject],
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: MapMessage;
      try {
        message = JSON.parse(event.nativeEvent.data) as MapMessage;
      } catch {
        return;
      }
      if (message.type === 'ready') {
        setReady(true);
        return;
      }
      if (message.type === 'tapMap') {
        closeSheet();
        return;
      }
      if (message.type === 'tapMarker') {
        if (message.key) handleMarkerTap(message.key);
        return;
      }
      if (message.type === 'view' && typeof message.lat === 'number' && typeof message.lon === 'number' && typeof message.zoom === 'number') {
        /* 底图报回来的是它自己坐标系里的坐标：先换回 WGS-84 再进状态 */
        const wgs = toWgs84({ lat: message.lat, lon: message.lon }, crsRef.current);
        centerRef.current = wgs;
        zoomRef.current = message.zoom;
        setZoom(message.zoom);
        onViewChange({ basemap: basemapRef.current, lat: wgs.lat, lon: wgs.lon, zoom: message.zoom });
      }
    },
    [onViewChange, handleMarkerTap, closeSheet],
  );

  /* ---------------------------------------------------------------- 下发 */

  /* 换底图：换瓦片源 + 把中心按新坐标系重新落点。标记由下面的 effect 按新坐标系重发 ——
     它依赖 basemap，因此这一步之后必然跟着跑一遍。 */
  useEffect(() => {
    /* 先同步镜像再下发：__setView 触发的 moveend 上报会读 basemapRef */
    basemapRef.current = basemap;
    if (!ready) return;
    const config = BASEMAPS[basemap];
    inject(`window.__setBasemap(${JSON.stringify(config.url)}, ${JSON.stringify(config.subdomains ?? 'abc')}); true;`);
    if (crsRef.current === config.crs) return;
    /* crs 必须先换再下发：__setView 会立刻触发 moveend 上报，上报时用的就是 crsRef */
    const moved = fromWgs84(centerRef.current, config.crs);
    crsRef.current = config.crs;
    inject(`window.__setView(${moved.lat}, ${moved.lon}, ${zoomRef.current}); true;`);
  }, [basemap, ready, inject]);

  /* 标记落地：坐标在 RN 侧换算到底图坐标系，页面只负责画 */
  useEffect(() => {
    if (!ready) return;
    const crs = BASEMAPS[basemap].crs;
    clustersRef.current = new Map(clusters.map((cluster) => [cluster.key, cluster]));
    const payload: MarkerPayload[] = clusters.map((cluster) => {
      const moved = fromWgs84({ lat: cluster.lat, lon: cluster.lon }, crs);
      const single = cluster.photos.length === 1 ? cluster.photos[0] : null;
      const marker: MarkerPayload = { key: cluster.key, lat: moved.lat, lon: moved.lon, count: cluster.photos.length };
      if (single) marker.url = single.cardUrl ?? single.url;
      return marker;
    });
    inject(`window.__setMarkers(${JSON.stringify(payload)}); true;`);
  }, [clusters, basemap, ready, inject]);

  /* 首次进入：App 没存过视野就按包围盒自动定位，让用户一进入就看见自己照片的分布。
     只做一次 —— 之后每次平移都会改变视野，再自动 fit 会与用户的手动操作相冲突。 */
  useEffect(() => {
    if (!ready || fittedRef.current) return;
    if (view) {
      fittedRef.current = true;
      return;
    }
    if (mapped.length === 0) return;
    fittedRef.current = true;
    const crs = BASEMAPS[basemap].crs;
    const points = mapped.map((photo) => {
      const moved = fromWgs84({ lat: photo.gps?.lat ?? 0, lon: photo.gps?.lon ?? 0 }, crs);
      return [moved.lat, moved.lon];
    });
    inject(`window.__fitBounds(${JSON.stringify(points)}, 14, ${FIT_PADDING}); true;`);
  }, [ready, view, mapped, basemap, inject]);

  const empty = !busy && mapped.length === 0;

  return (
    <View style={styles.screen}>
      <View style={styles.filterBar}>
        <ChipRow>
          {albumId && !showAll ? <Chip label="退出相册" active onPress={onExitAlbum} /> : null}
          {/* 看全部打开时分类 chip 收起：此时它们已经不生效，留着只会误导 */}
          {showAll
            ? null
            : CATEGORIES.map((item) => (
                <Chip key={item} label={item} active={item === category} onPress={() => onCategoryChange(item)} />
              ))}
          <Chip label="看全部" active={showAll} onPress={() => setShowAll((prev) => !prev)} />
        </ChipRow>
        <View style={styles.metaRow}>
          {/* 底图切换已撤（只剩高德一档，见 BasemapKey 的注释）；
              底图是哪一张由右下角的署名说明，这里不再占一个控件 */}
          <Text style={styles.hint} numberOfLines={1}>
            {busy ? '正在读取照片…' : `${mapped.length} 张已上图 · ${missingCount} 张无定位`}
          </Text>
        </View>
      </View>

      <View style={styles.stage}>
        <WebView
          ref={viewRef}
          source={{ html }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          setSupportMultipleWindows={false}
          onMessage={handleMessage}
          style={styles.webview}
        />

        {empty ? (
          <View style={styles.empty} pointerEvents="none">
            <Text style={styles.emptyTitle}>当前范围没有带定位的照片</Text>
            <Text style={styles.emptyTip}>
              {showAll ? '整份档案中暂无带定位的照片，可在「工具」模块补充拍摄地点' : '可打开「看全部」，或切换其他分类'}
            </Text>
          </View>
        ) : null}

        {/* 署名只是标注：不参与命中，地图右下角仍可正常拖动 */}
        <View style={styles.creditWrap} pointerEvents="none">
          <Text style={styles.credit}>© 高德</Text>
        </View>

        <MapBottomSheet
          photo={sheet.photo}
          cluster={sheet.cluster}
          onPick={(photo) => setSheet({ photo, cluster: null, spot: sheet.spot })}
          /* 卡片里的缩略图被点 → 进放大器（需求 2/3）。列表恒为这个点位的照片，
             因此 `spot` 要一路带着走：从横条挑过一张之后 cluster 已经置空 */
          onOpen={(photo) => openSpot(sheet.spot, photo)}
          onClose={closeSheet}
        />
      </View>

      {/* 放大器：与图墙那一路共用同一个组件，差别只在 list 与那条缩略图带 ——
          这里恒为「这个点位的照片」，翻页因此是「在该机位的若干张之间挑」 */}
      {viewer ? (
        <Viewer
          list={viewer.list}
          index={viewer.index}
          strip={viewer.list}
          onSeek={seekViewer}
          onStep={stepViewer}
          onClose={closeViewer}
          admin={admin}
          onPhotosChanged={onPhotosChanged}
          liked={liked}
          onToggleLike={onToggleLike}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },

  filterBar: { paddingHorizontal: space.s16, paddingTop: space.s8, gap: space.s8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.s12, paddingBottom: space.s8 },
  hint: { ...text.meta, color: colors.text.quaternary, flexShrink: 1 },

  /* 舞台吃满剩余高度：WebView 必须有一个确定高度的父级，否则它自己会塌成 0 */
  stage: { flex: 1, overflow: 'hidden' },
  webview: { flex: 1, backgroundColor: colors.background },

  empty: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.s40,
    gap: space.s8,
  },
  emptyTitle: { ...text.label, color: colors.text.secondary },
  emptyTip: { ...text.meta, color: colors.text.quaternary, textAlign: 'center' },

  /* 版权署名压在地图右下角：与 Web 的 .map-credit 同一处位置 */
  creditWrap: { position: 'absolute', right: space.s8, bottom: space.s4 },
  credit: {
    ...text.meta,
    color: colors.text.quaternary,
    backgroundColor: colors.material.thin,
    borderRadius: radius.sm,
    paddingHorizontal: space.s6,
    paddingVertical: space.s2,
  },
});
